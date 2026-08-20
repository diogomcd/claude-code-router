import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.commandcode.ai";
const DEFAULT_CLI_VERSION = "1.28.1";
const DEFAULT_CLI_ENVIRONMENT = "production";

export function buildUpstreamHeaders({ apiKey, cliVersion, cliEnvironment, sessionId }) {
  if (!apiKey) {
    throw new Error("apiKey is required");
  }
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "x-command-code-version": cliVersion ?? DEFAULT_CLI_VERSION,
    "x-cli-environment": cliEnvironment ?? DEFAULT_CLI_ENVIRONMENT,
    "x-session-id": sessionId ?? randomUUID(),
  };
}

export async function callCommandCode({
  baseUrl,
  body,
  apiKey,
  cliVersion,
  cliEnvironment,
  sessionId,
  signal,
  fetchImpl,
}) {
  const headers = buildUpstreamHeaders({ apiKey, cliVersion, cliEnvironment, sessionId });
  const fetchFn = fetchImpl ?? globalThis.fetch;
  const url = `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/alpha/generate`;
  const options = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
  if (signal !== undefined) {
    options.signal = signal;
  }
  return fetchFn(url, options);
}