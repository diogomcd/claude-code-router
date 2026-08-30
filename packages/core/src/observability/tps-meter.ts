import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MIN_SPEED_SPAN_MS = 400;
const WRITE_THROTTLE_MS = 200;
const SESSION_RETENTION_MS = 10 * 60 * 1_000;
const SSE_DATA_PREFIX = "data: ";
const DEFAULT_CHARS_PER_TOKEN = 3.5;
const MIN_CHARS_PER_TOKEN = 1.5;
const MAX_CHARS_PER_TOKEN = 6;
const MIN_CALIBRATION_TOKENS = 300;
const MIN_CALIBRATION_SAMPLE = 100;
const MAX_PENDING_LINE_CHARS = 4_000_000;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

type TpsSession = {
  activeRequests: number;
  filePath: string;
  firstTokenAt?: number;
  endedAt?: number;
  lastWriteAt: number;
  model: string;
  requestStartedAt: number;
  retention?: NodeJS.Timeout;
  tokens: number;
};

type Calibration = {
  chars: number;
  tokens: number;
};

export type TpsMeter = {
  append: (chunk: Buffer | string) => void;
  finish: () => void;
};

const sessions = new Map<string, TpsSession>();
const calibrations = new Map<string, Calibration>();

export function tpsMeterDirectory(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  return join(runtimeDir && runtimeDir.length > 0 ? runtimeDir : tmpdir(), "claude-tps");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readSessionId(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return SAFE_SESSION_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

// Character density varies by provider and content: prose, source code and tool-call JSON all tokenize
// differently. Each finished response teaches the ratio back, so the live estimate converges instead of
// carrying a fixed guess.
function charsPerToken(model: string): number {
  const learned = calibrations.get(model);
  if (!learned || learned.tokens < MIN_CALIBRATION_TOKENS) return DEFAULT_CHARS_PER_TOKEN;
  const ratio = learned.chars / learned.tokens;
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, ratio));
}

function learnCalibration(model: string, chars: number, tokens: number): void {
  if (chars < MIN_CALIBRATION_SAMPLE || tokens < MIN_CALIBRATION_SAMPLE) return;
  const current = calibrations.get(model) ?? { chars: 0, tokens: 0 };
  calibrations.set(model, { chars: current.chars + chars, tokens: current.tokens + tokens });
}

// The provider decides how the response reaches us: some stream token by token, others deliver whole
// blocks after generating them. Dividing by the elapsed request time measures throughput the same way
// in both cases, and matches how the gateway's own request log reports speed.
function speed(session: TpsSession, now: number): number {
  const end = session.activeRequests > 0 ? now : session.endedAt ?? now;
  const elapsedMs = end - session.requestStartedAt;
  if (elapsedMs < MIN_SPEED_SPAN_MS) return 0;
  return (session.tokens * 1_000) / elapsedMs;
}

function publish(session: TpsSession, now: number, force: boolean): void {
  if (!force && now - session.lastWriteAt < WRITE_THROTTLE_MS) return;
  session.lastWriteAt = now;
  const streaming = session.activeRequests > 0;
  const state = {
    model: session.model,
    state: streaming ? "streaming" : "idle",
    tokens: session.tokens,
    tps: Math.round(speed(session, now) * 10) / 10,
    ttftMs: session.firstTokenAt === undefined ? null : session.firstTokenAt - session.requestStartedAt,
    updatedAt: now
  };
  const pendingPath = `${session.filePath}.pending`;
  try {
    writeFileSync(pendingPath, `${JSON.stringify(state)}\n`);
    renameSync(pendingPath, session.filePath);
  } catch {
    // Speed reporting is disposable: a failed write must never break the proxied response.
  }
}

function scheduleRetention(sessionId: string, session: TpsSession): void {
  clearTimeout(session.retention);
  session.retention = setTimeout(() => {
    if (sessions.get(sessionId) === session && session.activeRequests === 0) {
      sessions.delete(sessionId);
    }
  }, SESSION_RETENTION_MS);
  session.retention.unref();
}

function appendHistory(model: string, entry: Record<string, number>): void {
  try {
    appendFileSync(
      join(tpsMeterDirectory(), "history.log"),
      `${JSON.stringify({ at: new Date().toISOString(), model, ...entry })}\n`
    );
  } catch {
    // Diagnostics only.
  }
}

export function createTpsMeter(options: {
  model?: string;
  requestStartedAt: number;
  sessionIdHeader: string | string[] | undefined;
}): TpsMeter | undefined {
  const sessionId = readSessionId(options.sessionIdHeader);
  if (!sessionId) return undefined;

  const directory = tpsMeterDirectory();
  try {
    mkdirSync(directory, { mode: 0o700, recursive: true });
  } catch {
    return undefined;
  }

  const model = options.model ?? "unknown";
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      activeRequests: 0,
      filePath: join(directory, `${sessionId}.json`),
      lastWriteAt: 0,
      model,
      requestStartedAt: options.requestStartedAt,
      tokens: 0
    };
    sessions.set(sessionId, session);
  }
  const active = session;
  if (active.activeRequests === 0) {
    active.endedAt = undefined;
    active.firstTokenAt = undefined;
    active.requestStartedAt = options.requestStartedAt;
    active.tokens = 0;
  }
  active.activeRequests += 1;
  active.model = model;
  clearTimeout(active.retention);
  publish(active, Date.now(), true);

  const decoder = new StringDecoder("utf8");
  let contributed = 0;
  let estimatedChars = 0;
  let tokensFromProvider = 0;
  let reportedTokens = 0;
  let estimatedBeforeReport = 0;
  let pending = "";
  let finished = false;

  const addTokens = (total: number): void => {
    if (total <= contributed) return;
    const now = Date.now();
    active.tokens += total - contributed;
    contributed = total;
    active.firstTokenAt ??= now;
    publish(active, now, false);
  };

  const consumeEvent = (line: string): void => {
    if (!line.startsWith(SSE_DATA_PREFIX)) return;
    const payload = line.slice(SSE_DATA_PREFIX.length).trim();
    if (!payload.startsWith("{")) return;
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(payload));
    } catch {
      return;
    }
    if (!event) return;
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (!delta) return;
      const providerEstimate = delta.estimated_tokens;
      if (typeof providerEstimate === "number" && providerEstimate > 0) {
        tokensFromProvider += providerEstimate;
        addTokens(contributed + providerEstimate);
        return;
      }
      const emitted = [delta.text, delta.thinking, delta.partial_json].find((value) => typeof value === "string");
      if (typeof emitted !== "string" || emitted.length === 0) return;
      estimatedChars += emitted.length;
      addTokens(contributed + Math.max(1, Math.round(emitted.length / charsPerToken(model))));
      return;
    }
    if (event.type === "message_delta") {
      const reported = asRecord(event.usage)?.output_tokens;
      if (typeof reported === "number" && reported > 0) {
        estimatedBeforeReport = contributed;
        reportedTokens = reported;
        addTokens(reported);
      }
    }
  };

  return {
    append(chunk) {
      pending += Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        consumeEvent(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_PENDING_LINE_CHARS) {
        estimatedChars += pending.length;
        addTokens(contributed + Math.round(pending.length / charsPerToken(model)));
        pending = "";
      }
    },
    finish() {
      if (finished) return;
      finished = true;
      if (reportedTokens > 0) {
        learnCalibration(model, estimatedChars, reportedTokens - tokensFromProvider);
      }
      const endedAt = Date.now();
      active.activeRequests = Math.max(0, active.activeRequests - 1);
      if (active.activeRequests === 0) active.endedAt = endedAt;
      appendHistory(model, {
        charsPerToken: charsPerToken(model),
        elapsedMs: endedAt - active.requestStartedAt,
        estimated: estimatedBeforeReport || contributed,
        reported: reportedTokens,
        tps: speed(active, endedAt),
        ttftMs: active.firstTokenAt === undefined ? -1 : active.firstTokenAt - active.requestStartedAt
      });
      publish(active, endedAt, true);
      if (active.activeRequests === 0) scheduleRetention(sessionId, active);
    }
  };
}

// Measures the provider stream where it arrives, before the response transform chain, so local
// buffering in those transforms cannot be mistaken for the model's generation speed.
export function tpsMeteringStream(source: Readable, meter: TpsMeter): Readable {
  return source.pipe(
    new Transform({
      transform(chunk, _encoding, callback) {
        meter.append(chunk);
        callback(null, chunk);
      }
    })
  );
}
