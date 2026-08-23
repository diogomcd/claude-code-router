import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const antigravityLanguageServerQuotaEndpoint =
  "http://127.0.0.1/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";

const antigravityLanguageServerQuotaPath =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const antigravityLanguageServerRequestTimeoutMs = 10_000;
const antigravityProcessLookupTimeoutMs = 5_000;

type AntigravityLanguageServerRuntime = {
  csrfToken: string;
  httpPort: number;
  pid: number;
};

type AntigravityLanguageServerLog = Omit<AntigravityLanguageServerRuntime, "csrfToken">;

export async function fetchAntigravityQuotaSummary(): Promise<unknown> {
  return requestAntigravityQuotaSummary(discoverAntigravityLanguageServer());
}

export function antigravityLanguageServerRuntimeForTest(
  log: string,
  commandLine: string
): AntigravityLanguageServerRuntime | undefined {
  const server = parseAntigravityLanguageServerLog(log);
  const csrfToken = parseAntigravityCsrfToken(commandLine);
  return server && csrfToken ? { ...server, csrfToken } : undefined;
}

export async function requestAntigravityQuotaSummaryForTest(
  runtime: AntigravityLanguageServerRuntime
): Promise<unknown> {
  return requestAntigravityQuotaSummary(runtime);
}

function discoverAntigravityLanguageServer(): AntigravityLanguageServerRuntime {
  const server = readAntigravityLanguageServerLog();
  if (!server) {
    throw new Error("Antigravity is not running or its language server log could not be read.");
  }
  const commandLine = readAntigravityLanguageServerCommandLine(server.pid);
  if (!commandLine) {
    throw new Error("Antigravity language server process is not running.");
  }
  const csrfToken = parseAntigravityCsrfToken(commandLine);
  if (!csrfToken) {
    throw new Error("Antigravity language server authentication token was not found.");
  }
  return { ...server, csrfToken };
}

function readAntigravityLanguageServerLog(): AntigravityLanguageServerLog | undefined {
  for (const file of antigravityLanguageServerLogCandidates()) {
    try {
      const parsed = parseAntigravityLanguageServerLog(readFileSync(file, "utf8"));
      if (parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function antigravityLanguageServerLogCandidates(): string[] {
  const configured = process.env.CCR_ANTIGRAVITY_LANGUAGE_SERVER_LOG?.trim();
  if (configured) {
    return [configured];
  }
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Logs", "Antigravity", "language_server.log")];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Antigravity", "logs", "language_server.log")];
  }
  return [
    path.join(home, ".config", "Antigravity", "logs", "language_server.log"),
    path.join(home, ".config", "antigravity", "logs", "language_server.log")
  ];
}

function parseAntigravityLanguageServerLog(log: string): AntigravityLanguageServerLog | undefined {
  const pid = lastNumericMatch(log, /Starting language server process with pid (\d+)/gi);
  const httpPort = lastNumericMatch(log, /language server listening on (?:random|\w+) port at (\d+) for HTTP\b(?!S)/gi);
  return pid && httpPort ? { httpPort, pid } : undefined;
}

function lastNumericMatch(value: string, pattern: RegExp): number | undefined {
  let result: number | undefined;
  for (const match of value.matchAll(pattern)) {
    const parsed = Number(match[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      result = parsed;
    }
  }
  return result;
}

function readAntigravityLanguageServerCommandLine(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    return successfulCommandOutput("ps", ["-ww", "-p", String(pid), "-o", "command="]);
  }
  if (process.platform === "win32") {
    return successfulCommandOutput("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`
    ]);
  }
  return undefined;
}

function successfulCommandOutput(command: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: antigravityProcessLookupTimeoutMs,
      windowsHide: true
    });
    return !result.error && result.status === 0 && result.stdout.trim() ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

function parseAntigravityCsrfToken(commandLine: string): string | undefined {
  if (!/(?:^|[\\/])language_server(?:\.exe)?(?=["'\0\s]|$)/i.test(commandLine)) {
    return undefined;
  }
  return commandLine
    .match(/(?:^|\0|\s)--csrf_token(?:\0|\s+)([^\0\s]+)/)?.[1]
    ?.replace(/^["']|["']$/g, "");
}

async function requestAntigravityQuotaSummary(runtime: AntigravityLanguageServerRuntime): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), antigravityLanguageServerRequestTimeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.httpPort}${antigravityLanguageServerQuotaPath}`, {
      body: "{}",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-codeium-csrf-token": runtime.csrfToken
      },
      method: "POST",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Antigravity language server quota request returned HTTP ${response.status}.`);
    }
    return await response.json() as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Antigravity language server")) {
      throw error;
    }
    const reason = controller.signal.aborted
      ? "request timed out"
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`Antigravity language server quota request failed: ${reason}.`);
  } finally {
    clearTimeout(timer);
  }
}
