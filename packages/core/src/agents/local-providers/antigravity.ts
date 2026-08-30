import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  GatewayProviderConfig,
  LocalAgentProviderCandidate,
  LocalAgentProviderImportResult,
  ProviderAccountConfig,
  ProviderAccountConnectorConfig
} from "@ccr/core/contracts/app";
import { fetchWithSystemProxy } from "@ccr/core/proxy/system-proxy-fetch";
import { antigravityLanguageServerQuotaEndpoint } from "@ccr/core/providers/antigravity-account";
import { normalizeProviderBaseUrl } from "@ccr/core/providers/url";
import {
  bearerAuthPlugin,
  localAgentProviderApiKey,
  missingCandidate,
  providerInternalNamePlaceholder,
  providerPayload,
  readJsonRecord,
  readString,
  uniqueProviderName,
  uniqueStrings
} from "@ccr/core/agents/local-providers/shared";

export const antigravityDefaultBaseUrl = "https://daily-cloudcode-pa.googleapis.com";
const legacyAntigravityQuotaEndpoint = `${antigravityDefaultBaseUrl}/v1internal:retrieveUserQuotaSummary`;

const antigravityClientVersion = "2.8.1";
// Changelist do build 2.8.1 do language server oficial; o servidor valida o
// par versão/changelist e responde 403 quando o cliente não é reconhecido.
const antigravityServerChangelist = "963775910";
const accessTokenExpiryMarginMs = 60_000;
const secondsToMillisecondsThreshold = 1e12;

const antigravityKeyringService = "gemini";
const antigravityKeyringUsername = "antigravity";
const antigravityKeyringTimeoutMs = 5_000;

// Client OAuth do Gemini CLI, que o Antigravity reaproveita no login Google;
// é o client que emitiu os refresh_token gravados em ~/.gemini.
const antigravityOauthClientId = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const antigravityOauthClientSecret = "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";
const antigravityOauthTokenEndpoint = "https://oauth2.googleapis.com/token";
const antigravityRefreshTimeoutMs = 15_000;
const antigravityRefreshFailureBackoffMs = 60_000;

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
  const payload = await postAntigravityInternal("loadCodeAssist", accessToken, {
    metadata: { ideType: "ANTIGRAVITY" }
  });
  const project = findCloudAiCompanionProject(payload) ?? "";
  // Cacheia também o vazio: sem projeto o servidor responde 403 em toda geração,
  // e reinterrogar loadCodeAssist a cada request não muda o resultado.
  antigravityProjectCache.set(accessToken, {
    expiresAt: Date.now() + antigravityProjectCacheTtlMs,
    project
  });
  return project;
}

export async function fetchAntigravityModels(
  accessToken: string
): Promise<Array<{ id: string; displayName?: string }>> {
  const payload = await postAntigravityInternal("fetchAvailableModels", accessToken, {});
  const models = payload?.models;
  if (!isPlainRecord(models)) {
    return [];
  }
  return Object.entries(models).flatMap(([id, meta]) => {
    // Modelos sem displayName são internos do IDE (tab completion, roteamento
    // "tiered") e rejeitam generateContent com 400; nunca são chamáveis.
    if (!id || !isPlainRecord(meta) || !readString(meta.displayName)) {
      return [];
    }
    return [{ id, displayName: readString(meta.displayName) }];
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
  if (antigravityAccessTokenExpired(auth)) {
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
    antigravityDefaultBaseUrl,
    antigravityProviderAccountConfig()
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

export function antigravityProviderAccountConfig(): ProviderAccountConfig {
  return {
    connectors: [
      {
        auth: "none",
        endpoint: antigravityLanguageServerQuotaEndpoint,
        mapping: {
          meters: []
        },
        method: "POST",
        parser: "antigravity-quota",
        type: "http-json"
      }
    ],
    enabled: true
  };
}

export function normalizeAntigravityProviderAccountConfig(provider: GatewayProviderConfig): GatewayProviderConfig {
  if (!isLocalAntigravityProvider(provider) || !shouldUseCurrentAntigravityAccountConfig(provider.account)) {
    return provider;
  }
  const account = antigravityProviderAccountConfig();
  return {
    ...provider,
    account: {
      ...account,
      refreshIntervalMs: provider.account?.refreshIntervalMs ?? account.refreshIntervalMs
    }
  };
}

function isLocalAntigravityProvider(provider: GatewayProviderConfig): boolean {
  if (providerApiKey(provider) !== localAgentProviderApiKey) {
    return false;
  }
  const baseUrl = normalizeProviderBaseUrl(providerBaseUrl(provider)).toLowerCase();
  const name = provider.name?.trim().toLowerCase() ?? "";
  return baseUrl.includes("daily-cloudcode-pa.googleapis.com") || name.includes("antigravity");
}

function shouldUseCurrentAntigravityAccountConfig(account: ProviderAccountConfig | undefined): boolean {
  if (account?.enabled === false) {
    return false;
  }
  const connectors = account?.connectors ?? [];
  if (connectors.length === 0) {
    return true;
  }
  return connectors.every(isAntigravityAccountConnector);
}

function isAntigravityAccountConnector(connector: ProviderAccountConnectorConfig): boolean {
  if (connector.type === "standard") {
    return !connector.endpoint?.trim() && !connector.endpoints?.length && !connector.headers && !connector.id;
  }
  if (connector.type !== "http-json") {
    return false;
  }
  const endpoint = connector.endpoint.trim();
  return connector.parser === "antigravity-quota" && (
    endpoint === antigravityLanguageServerQuotaEndpoint || endpoint === legacyAntigravityQuotaEndpoint
  );
}

function providerBaseUrl(provider: GatewayProviderConfig): string {
  return provider.api_base_url || provider.baseUrl || provider.baseurl || "";
}

function providerApiKey(provider: GatewayProviderConfig): string {
  return provider.api_key || provider.apiKey || provider.apikey || "";
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
  expiryDate?: number;
  idToken?: string;
  refreshToken?: string;
  scope?: string;
  sourceFile: string;
}

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
  // O secret-tool imprime os atributos (service, username) no stderr e o
  // segredo no stdout; só o stdout não contém o username para filtrar.
  let output = "";
  try {
    const result = spawnSync("secret-tool", ["search", "--all", "service", antigravityKeyringService], {
      encoding: "utf8",
      timeout: antigravityKeyringTimeoutMs
    });
    if (result.error || result.status !== 0) {
      return undefined;
    }
    output = `${result.stderr}\n${result.stdout}`;
  } catch {
    return undefined;
  }
  if (!output.includes(`attribute.username = ${antigravityKeyringUsername}`)) {
    return undefined;
  }
  const secret = output.match(/^secret = (.+)$/m)?.[1];
  const token = secret ? parseRecord(secret)?.token : undefined;
  if (!isPlainRecord(token)) {
    return undefined;
  }
  const accessToken = readString(token.access_token);
  if (!accessToken) {
    return undefined;
  }
  return {
    accessToken,
    expiryDate: normalizeKeyringExpiry(token.expiry),
    sourceFile: antigravityKeyringSourceFile
  };
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
  if (auth?.accessToken && !antigravityAccessTokenExpired(auth)) {
    return auth;
  }
  return refreshAntigravityAuth(auth);
}

type AntigravityRefreshOutcome = {
  auth?: AntigravityTokenSet;
  failureBackoffUntil?: number;
};

// Refreshes em andamento por refresh_token, para requisições concorrentes
// compartilharem a mesma chamada em vez de dispararem um refresh cada.
const antigravityRefreshInFlight = new Map<string, Promise<AntigravityRefreshOutcome>>();
const antigravityRefreshFailures = new Map<string, number>();

function refreshTokenKey(auth: AntigravityTokenSet): string {
  const configuredFile = process.env.CCR_ANTIGRAVITY_OAUTH_FILE?.trim();
  return `${configuredFile || auth.sourceFile || ""}\n${auth.refreshToken ?? ""}`;
}

async function refreshAntigravityAuth(
  auth: AntigravityTokenSet | undefined
): Promise<AntigravityTokenSet | undefined> {
  const refreshToken = auth?.refreshToken;
  if (!refreshToken || !auth) {
    return undefined;
  }
  const key = refreshTokenKey(auth);
  const failureBackoffUntil = antigravityRefreshFailures.get(key);
  if (failureBackoffUntil !== undefined && failureBackoffUntil > Date.now()) {
    return undefined;
  }
  const inFlight = antigravityRefreshInFlight.get(key);
  if (inFlight) {
    return (await inFlight).auth;
  }
  const refresh = refreshAntigravityToken(refreshToken, auth?.sourceFile)
    .then((outcome) => {
      if (outcome.auth) {
        antigravityRefreshFailures.delete(key);
      } else {
        antigravityRefreshFailures.set(key, Date.now() + antigravityRefreshFailureBackoffMs);
      }
      return outcome;
    })
    .finally(() => antigravityRefreshInFlight.delete(key));
  antigravityRefreshInFlight.set(key, refresh);
  return (await refresh).auth;
}

async function refreshAntigravityToken(
  refreshToken: string,
  sourceFile?: string
): Promise<AntigravityRefreshOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), antigravityRefreshTimeoutMs);
  try {
    const response = await fetchWithSystemProxy(
      process.env.CCR_ANTIGRAVITY_OAUTH_TOKEN_ENDPOINT?.trim() || antigravityOauthTokenEndpoint,
      {
        body: new URLSearchParams({
          client_id: process.env.CCR_ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || antigravityOauthClientId,
          client_secret:
            process.env.CCR_ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || antigravityOauthClientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        signal: controller.signal
      }
    );
    const text = await response.text();
    if (!response.ok) {
      return {};
    }
    const payload = parseRecord(text);
    const accessToken = readString(payload?.access_token);
    if (!accessToken) {
      return {};
    }
    const auth = writeAntigravityRefreshedAuth(sourceFile, {
      accessToken,
      expiresInMs: (readNumber(payload?.expires_in) ?? 3600) * 1000,
      idToken: readString(payload?.id_token),
      refreshToken: readString(payload?.refresh_token) || refreshToken,
      scope: readString(payload?.scope)
    });
    return { auth };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function writeAntigravityRefreshedAuth(
  sourceFile: string | undefined,
  refreshed: {
    accessToken: string;
    expiresInMs: number;
    idToken?: string;
    refreshToken: string;
    scope?: string;
  }
): AntigravityTokenSet {
  const file = sourceFile?.trim() || antigravityCredentialFile();
  const record: Record<string, unknown> = {
    ...(readJsonRecord(file) ?? {}),
    access_token: refreshed.accessToken,
    expiry_date: Date.now() + refreshed.expiresInMs,
    refresh_token: refreshed.refreshToken
  };
  if (refreshed.idToken) {
    record.id_token = refreshed.idToken;
  }
  if (refreshed.scope) {
    record.scope = refreshed.scope;
  }
  // A escrita pode falhar (fs somente leitura), mas o token segue válido em
  // memória e o próximo ciclo apenas refaz o refresh.
  try {
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
  return {
    accessToken: refreshed.accessToken,
    expiryDate: record.expiry_date as number,
    idToken: refreshed.idToken,
    refreshToken: refreshed.refreshToken,
    scope: refreshed.scope,
    sourceFile: file
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function liveAntigravityAuth(sourceFile?: string): AntigravityTokenSet | undefined {
  const fileAuth = readAntigravityAuth(sourceFile);
  if (fileAuth?.accessToken && !antigravityAccessTokenExpired(fileAuth)) {
    return fileAuth;
  }
  return readAntigravityKeyringAuth() ?? fileAuth;
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

export function antigravityIdentityHeaders(): Record<string, string> {
  const nodeMajor = process.versions.node.split(".")[0];
  return {
    "user-agent": process.env.ANTIGRAVITY_IDE_USER_AGENT?.trim() || antigravityLanguageServerUserAgent(),
    "x-goog-api-client": process.env.ANTIGRAVITY_API_CLIENT_HEADER?.trim() || `gl-node/${nodeMajor}`
  };
}

function antigravityLanguageServerUserAgent(): string {
  const osType = process.platform === "darwin"
    ? "darwin"
    : process.platform === "win32"
      ? "windows"
      : "linux";
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/hub/${antigravityClientVersion} (aidev_client; os_type=${osType}; arch=${arch}; cl=${antigravityServerChangelist})`;
}
