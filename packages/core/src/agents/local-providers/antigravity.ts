import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  LocalAgentProviderCandidate,
  LocalAgentProviderImportResult
} from "@ccr/core/contracts/app";
import { fetchWithSystemProxy } from "@ccr/core/proxy/system-proxy-fetch";
import {
  bearerAuthPlugin,
  missingCandidate,
  providerInternalNamePlaceholder,
  providerPayload,
  readJsonRecord,
  readString,
  uniqueProviderName,
  uniqueStrings
} from "@ccr/core/agents/local-providers/shared";

export const antigravityDefaultBaseUrl = "https://daily-cloudcode-pa.googleapis.com";
export const antigravityOAuthTokenUrl = "https://oauth2.googleapis.com/token";

const antigravityOauthClientId = "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com";
const antigravityOauthClientSecret = "REDACTED";
const antigravityIdeVersion = "1.0.0";
const antigravityRefreshTimeoutMs = 20_000;
const accessTokenExpiryMarginMs = 60_000;
const secondsToMillisecondsThreshold = 1e12;

const antigravityKeyringService = "gemini";
const antigravityKeyringUsername = "antigravity";
const antigravityKeyringTimeoutMs = 5_000;

const antigravityFallbackModels = ["gemini-3.1-pro-low", "gemini-3.6-flash-high", "claude-sonnet-4-6"];
const antigravityCandidateId = "antigravity-ide";
const antigravityProviderName = "Antigravity";
const antigravityProtocol = "gemini_generate_content" as const;
const antigravityProjectCacheTtlMs = 600_000;
const antigravityInternalRequestTimeoutMs = 20_000;
const maxImportedModels = 24;

const antigravityProjectCache = new Map<string, { expiresAt: number; project: string }>();

async function postAntigravityInternal(
  method: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), antigravityInternalRequestTimeoutMs);
  try {
    const response = await fetchWithSystemProxy(`${antigravityDefaultBaseUrl}/v1internal:${method}`, {
      body: JSON.stringify(body),
      headers: {
        ...antigravityIdentityHeaders(),
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      method: "POST",
      signal: controller.signal
    });
    if (!response.ok) {
      return undefined;
    }
    return parseRecord(await response.text());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function findCloudAiCompanionProject(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== "object") {
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase().includes("cloudaicompanion") && typeof child === "string" && child.trim()) {
      return child.trim();
    }
    const nested = findCloudAiCompanionProject(child, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export async function loadAntigravityProject(accessToken: string): Promise<string> {
  const cached = antigravityProjectCache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.project;
  }
  const payload = await postAntigravityInternal("loadCodeAssist", accessToken, { metadata: {} });
  const project = findCloudAiCompanionProject(payload) ?? "";
  if (project) {
    antigravityProjectCache.set(accessToken, {
      expiresAt: Date.now() + antigravityProjectCacheTtlMs,
      project
    });
  }
  return project;
}

export async function fetchAntigravityModels(
  accessToken: string
): Promise<Array<{ id: string; displayName?: string }>> {
  const payload = await postAntigravityInternal("fetchAvailableModels", accessToken, { metadata: {} });
  const models = payload?.models;
  if (!isPlainRecord(models)) {
    return [];
  }
  return Object.entries(models).flatMap(([id, meta]) => {
    if (!id) {
      return [];
    }
    const displayName = isPlainRecord(meta) ? readString(meta.displayName) : undefined;
    return [{ id, ...(displayName ? { displayName } : {}) }];
  });
}

export function antigravityCandidate(): LocalAgentProviderCandidate {
  const auth = readAntigravityAuth();
  if (!auth?.accessToken) {
    return missingCandidate(
      "antigravity",
      antigravityCandidateId,
      antigravityProviderName,
      antigravityProtocol,
      antigravityFallbackModels
    );
  }
  if (antigravityAccessTokenExpired(auth) && !auth.refreshToken) {
    return {
      detail: "Antigravity login was detected, but the access token expired. Sign in to Antigravity again, then rescan.",
      id: antigravityCandidateId,
      importable: false,
      kind: "antigravity",
      models: antigravityFallbackModels,
      name: antigravityProviderName,
      protocol: antigravityProtocol,
      sourceFile: auth.sourceFile,
      status: "locked"
    };
  }
  return {
    detail: "Antigravity login detected. Click Import to add it as a gateway provider.",
    id: antigravityCandidateId,
    importable: true,
    kind: "antigravity",
    models: antigravityFallbackModels,
    name: antigravityProviderName,
    protocol: antigravityProtocol,
    sourceFile: auth.sourceFile,
    status: "available"
  };
}

export async function importAntigravityProvider(
  candidate: LocalAgentProviderCandidate,
  providerNames: string[]
): Promise<LocalAgentProviderImportResult> {
  const auth = await resolveAntigravityAuth();
  if (!auth?.accessToken) {
    throw new Error("Antigravity login was not found or is expired.");
  }
  const project = await loadAntigravityProject(auth.accessToken);
  const discovered = await fetchAntigravityModels(auth.accessToken);
  const models = uniqueStrings([
    ...discovered.map((model) => model.id),
    ...antigravityFallbackModels
  ]).slice(0, maxImportedModels);
  const modelDisplayNames = Object.fromEntries(
    discovered.flatMap((model) => (model.displayName ? [[model.id, model.displayName]] : []))
  );
  const nextCandidate: LocalAgentProviderCandidate = {
    ...candidate,
    ...(Object.keys(modelDisplayNames).length > 0 ? { modelDisplayNames } : {}),
    models,
    protocol: antigravityProtocol
  };
  const provider = providerPayload(
    nextCandidate,
    uniqueProviderName(providerNames, antigravityProviderName),
    antigravityDefaultBaseUrl
  );
  return {
    candidate: nextCandidate,
    provider,
    providerPlugins: [
      antigravityAuthPlugin("antigravity-oauth", auth.accessToken, project),
      antigravityAuthPlugin("antigravity-oauth-internal", auth.accessToken, project, providerInternalNamePlaceholder)
    ]
  };
}

function antigravityAuthPlugin(
  suffix: string,
  token: string,
  project: string,
  providerName?: string
): Record<string, unknown> {
  return {
    ...bearerAuthPlugin(suffix, token, {}, providerName),
    antigravityOauth: { project },
    request: {
      headers: antigravityIdentityHeaders(),
      strict: true
    }
  };
}
export interface AntigravityTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  idToken?: string;
  scope?: string;
  sourceFile: string;
}

class AntigravityRefreshRejectedError extends Error {}

const antigravityRefreshInFlight = new Map<string, Promise<AntigravityTokenSet | undefined>>();

function antigravityStorageRoot(): string {
  const internalHome = process.env.CCR_INTERNAL_HOME_DIR?.trim();
  return internalHome ? path.join(internalHome, ".gemini") : path.join(os.homedir(), ".gemini");
}

export function antigravityCredentialFile(): string {
  const configured = process.env.CCR_ANTIGRAVITY_OAUTH_FILE?.trim();
  return configured || path.join(antigravityStorageRoot(), "oauth_creds.json");
}

function normalizeExpiryDate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < secondsToMillisecondsThreshold ? Math.round(value * 1000) : value;
}

export function readAntigravityAuth(sourceFile?: string): AntigravityTokenSet | undefined {
  const file = sourceFile?.trim() || antigravityCredentialFile();
  const record = readJsonRecord(file);
  if (!record) {
    return undefined;
  }
  const accessToken = readString(record.access_token) || readString(record.accessToken);
  if (!accessToken) {
    return undefined;
  }
  return {
    accessToken,
    expiryDate: normalizeExpiryDate(record.expiry_date ?? record.expiryDate),
    idToken: readString(record.id_token) || readString(record.idToken),
    refreshToken: readString(record.refresh_token) || readString(record.refreshToken),
    scope: readString(record.scope),
    sourceFile: file
  };
}

export const antigravityKeyringSourceFile = `keyring:${antigravityKeyringService}/${antigravityKeyringUsername}`;

export function readAntigravityKeyringAuth(): AntigravityTokenSet | undefined {
  let output = "";
  try {
    output = execFileSync("secret-tool", ["search", "--all", "service", antigravityKeyringService], {
      encoding: "utf8",
      timeout: antigravityKeyringTimeoutMs
    });
  } catch {
    return undefined;
  }
  for (const block of output.split(/\n\s*\n/)) {
    if (!block.includes(`attribute.username = ${antigravityKeyringUsername}`)) {
      continue;
    }
    const secret = block.match(/^secret = (.+)$/m)?.[1];
    const token = secret ? parseRecord(secret)?.token : undefined;
    if (!isPlainRecord(token)) {
      continue;
    }
    const accessToken = readString(token.access_token);
    if (!accessToken) {
      continue;
    }
    return {
      accessToken,
      expiryDate: normalizeKeyringExpiry(token.expiry),
      refreshToken: readString(token.refresh_token),
      sourceFile: antigravityKeyringSourceFile
    };
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKeyringExpiry(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function antigravityAccessTokenExpired(auth: AntigravityTokenSet): boolean {
  return auth.expiryDate === undefined || auth.expiryDate <= Date.now() + accessTokenExpiryMarginMs;
}

export async function resolveAntigravityAuth(
  reference?: { sourceFile?: string }
): Promise<AntigravityTokenSet | undefined> {
  const auth = liveAntigravityAuth(reference?.sourceFile);
  if (!auth?.refreshToken || !antigravityAccessTokenExpired(auth)) {
    return auth;
  }
  const key = auth.sourceFile;
  let refresh = antigravityRefreshInFlight.get(key);
  if (!refresh) {
    refresh = refreshAntigravityAuth(auth)
      .catch((error: unknown) => adoptPeerRotatedAntigravityAuth(auth, error))
      .finally(() => {
        antigravityRefreshInFlight.delete(key);
      });
    antigravityRefreshInFlight.set(key, refresh);
  }
  return refresh;
}

function liveAntigravityAuth(sourceFile?: string): AntigravityTokenSet | undefined {
  const fileAuth = readAntigravityAuth(sourceFile);
  if (fileAuth?.accessToken && !antigravityAccessTokenExpired(fileAuth)) {
    return fileAuth;
  }
  return readAntigravityKeyringAuth() ?? fileAuth;
}

function adoptPeerRotatedAntigravityAuth(
  auth: AntigravityTokenSet,
  error: unknown
): AntigravityTokenSet | undefined {
  if (error instanceof AntigravityRefreshRejectedError) {
    const latest = liveAntigravityAuth(
      auth.sourceFile === antigravityKeyringSourceFile ? undefined : auth.sourceFile
    );
    if (latest?.accessToken && !antigravityAccessTokenExpired(latest)) {
      return latest;
    }
  }
  return auth;
}

async function refreshAntigravityAuth(auth: AntigravityTokenSet): Promise<AntigravityTokenSet> {
  if (!auth.refreshToken) {
    return auth;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), antigravityRefreshTimeoutMs);
  try {
    const response = await fetchWithSystemProxy(antigravityOAuthTokenUrl, {
      body: new URLSearchParams({
        client_id: antigravityOauthClientId,
        client_secret: antigravityOauthClientSecret,
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken
      }).toString(),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      method: "POST",
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        throw new AntigravityRefreshRejectedError(
          `Antigravity OAuth token refresh returned HTTP ${response.status}.`
        );
      }
      throw new Error(`Antigravity OAuth token refresh returned HTTP ${response.status}.`);
    }
    const payload = parseRecord(text);
    const accessToken = readString(payload?.access_token) || readString(payload?.accessToken);
    if (!accessToken) {
      throw new Error("Antigravity OAuth token refresh returned an incomplete token response.");
    }
    const expiresIn = payload?.expires_in ?? payload?.expiresIn;
    const refreshed: AntigravityTokenSet = {
      ...auth,
      accessToken,
      expiryDate: typeof expiresIn === "number" && Number.isFinite(expiresIn)
        ? Date.now() + expiresIn * 1000
        : auth.expiryDate,
      refreshToken: readString(payload?.refresh_token) || readString(payload?.refreshToken) || auth.refreshToken,
      scope: readString(payload?.scope) || auth.scope
    };
    if (refreshed.sourceFile !== antigravityKeyringSourceFile) {
      persistAntigravityAuth(refreshed);
    }
    return refreshed;
  } finally {
    clearTimeout(timer);
  }
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function persistAntigravityAuth(auth: AntigravityTokenSet): void {
  if (!auth.accessToken || !existsSync(auth.sourceFile)) {
    return;
  }
  const original = readJsonRecord(auth.sourceFile) ?? {};
  const payload: Record<string, unknown> = {
    ...original,
    access_token: auth.accessToken
  };
  if (auth.refreshToken) {
    payload.refresh_token = auth.refreshToken;
  }
  if (auth.expiryDate !== undefined) {
    payload.expiry_date = auth.expiryDate;
  }
  if (auth.scope) {
    payload.scope = auth.scope;
  }
  const temporaryFile = `${auth.sourceFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryFile, auth.sourceFile);
    chmodSync(auth.sourceFile, 0o600);
  } catch {
    try {
      rmSync(temporaryFile, { force: true });
    } catch {
      // Best effort. The refreshed access token is still usable for this CCR run.
    }
  }
}

export function antigravityIdentityHeaders(): Record<string, string> {
  const nodeMajor = process.versions.node.split(".")[0];
  return {
    "user-agent": process.env.ANTIGRAVITY_IDE_USER_AGENT?.trim() || `antigravity-ide/${antigravityIdeVersion}`,
    "x-goog-api-client": process.env.ANTIGRAVITY_API_CLIENT_HEADER?.trim() || `gl-node/${nodeMajor}`
  };
}
