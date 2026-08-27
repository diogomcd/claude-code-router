/**
 * Context compression via a local Headroom proxy (`/v1/compress`).
 *
 * Extracted to follow the gateway feature boundary: keep this module focused on
 * compressing the conversation `messages` before the request goes upstream.
 *
 * The feature is opt-in and fail-open: any misconfiguration, unreachable
 * Headroom, timeout, or compression error returns `undefined` and the request
 * proceeds uncompressed, so the gateway keeps working with Headroom off.
 */
import type { AppConfig } from "@ccr/core/contracts/app";
import { readHeader } from "@ccr/core/gateway/http/io";
import { serializeJsonBody, takeJsonObject } from "@ccr/core/gateway/http/body";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";
import { ModelRegistry } from "@ccr/core/routing/model-registry";
import type { IncomingHttpHeaders } from "node:http";

export type ContextCompressionPreparation = {
  body: Buffer;
  diagnostic: string;
  tokensSaved: number;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_TOKENS = 8_000;
const COMPRESSIBLE_PATH_PATTERN = /\/(v1\/)?(messages|chat\/completions|responses)$/;

type HeadroomCompressResponse = {
  compression_ratio?: number;
  compression_skipped?: boolean;
  messages?: unknown;
  tokens_after?: number;
  tokens_before?: number;
  tokens_saved?: number;
};

export async function prepareContextCompressionRequest(input: {
  body?: Buffer;
  config: AppConfig;
  headers?: IncomingHttpHeaders;
  method: string;
  path: string;
  routedModel?: string;
}): Promise<ContextCompressionPreparation | undefined> {
  const settings = readContextCompressionSettings(input.config);
  if (!settings) {
    return undefined;
  }
  if ((input.method || "GET").toUpperCase() !== "POST" || !COMPRESSIBLE_PATH_PATTERN.test(input.path)) {
    return undefined;
  }
  // Claude Code rewrites its own history every turn; compressing it busts the
  // upstream prompt cache and costs more than the savings.
  if (isClaudeCodeUserAgent(input.headers)) {
    return undefined;
  }
  if (!input.body || input.body.length === 0) {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = takeJsonObject(input.body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return undefined;
  }
  if (isExcludedProvider(input.config, settings.excludeProviders, input.routedModel ?? stringValue(parsed.model))) {
    return undefined;
  }

  const tokensBefore = estimateMessageTokens(parsed.messages);
  if (tokensBefore < settings.minTokens) {
    return undefined;
  }

  const compressed = await callHeadroomCompress({
    baseUrl: settings.baseUrl,
    messages: parsed.messages,
    model: input.routedModel ?? stringValue(parsed.model) ?? "claude-sonnet-4",
    timeoutMs: settings.timeoutMs
  });
  if (!compressed || !Array.isArray(compressed.messages) || compressed.messages.length === 0) {
    return undefined;
  }

  const tokensSaved = typeof compressed.tokens_saved === "number" && compressed.tokens_saved > 0
    ? Math.round(compressed.tokens_saved)
    : 0;
  const ratio = typeof compressed.compression_ratio === "number" ? compressed.compression_ratio : 1;
  // Ignore no-op responses so we never rewrite a body Headroom chose to skip.
  if (compressed.compression_skipped === true || tokensSaved === 0 || ratio >= 1) {
    return undefined;
  }

  const next = { ...parsed, messages: compressed.messages };
  return {
    body: serializeJsonBody(next),
    diagnostic: `saved=${tokensSaved} ratio=${ratio.toFixed(3)}`,
    tokensSaved
  };
}

function readContextCompressionSettings(config: AppConfig): { baseUrl: string; excludeProviders: string[]; minTokens: number; timeoutMs: number } | undefined {
  const plugin = config.plugins?.find((item) => item.enabled !== false && item.id === "context-compression");
  if (!plugin) {
    return undefined;
  }
  const pluginConfig = isRecord(plugin.config) ? plugin.config : {};
  return {
    baseUrl: stringValue(pluginConfig.baseUrl) || DEFAULT_BASE_URL,
    excludeProviders: normalizeProviderNames(pluginConfig.excludeProviders),
    minTokens: numberValue(pluginConfig.minTokens) ?? DEFAULT_MIN_TOKENS,
    timeoutMs: numberValue(pluginConfig.timeoutMs) ?? DEFAULT_TIMEOUT_MS
  };
}

function isClaudeCodeUserAgent(headers: IncomingHttpHeaders | undefined): boolean {
  const userAgent = readHeader(headers?.["user-agent"]);
  if (!userAgent) {
    return false;
  }
  return userAgent.toLowerCase().includes("claude");
}

function normalizeProviderNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => stringValue(item)?.trim().toLowerCase())
    .filter((name): name is string => Boolean(name));
}

// The routed selector may omit the provider, so resolve it through the same
// registry the router uses instead of string-matching the model name.
function isExcludedProvider(config: AppConfig, excluded: string[], selector: string | undefined): boolean {
  if (excluded.length === 0 || !selector) {
    return false;
  }
  const resolved = new ModelRegistry(config).resolve(selector);
  if (resolved?.kind !== "provider") {
    return false;
  }
  return excluded.includes(resolved.provider.name.trim().toLowerCase());
}

async function callHeadroomCompress(input: {
  baseUrl: string;
  messages: unknown[];
  model: string;
  timeoutMs: number;
}): Promise<HeadroomCompressResponse | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/v1/compress`, {
      body: JSON.stringify({ messages: input.messages, model: input.model }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as HeadroomCompressResponse;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// Rough char heuristic, mirrors the estimator used by the router so the
// minTokens gate stays cheap and does not need a tokenizer.
function estimateMessageTokens(messages: unknown[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message)?.length ?? 0;
  }
  return Math.ceil(chars / 4);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
