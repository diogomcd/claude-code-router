import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUTH_FILE_PATH = () => path.join(os.homedir(), ".commandcode", "auth.json");
export const CONFIG_FILE_PATH = () => path.join(os.homedir(), ".commandcode", "config.json");

export function readCommandCodeApiKey() {
  const auth = JSON.parse(fs.readFileSync(AUTH_FILE_PATH(), "utf8"));
  if (typeof auth.apiKey !== "string" || auth.apiKey === "") {
    throw new Error("commandcode-shim: ~/.commandcode/auth.json has no apiKey field");
  }
  return auth.apiKey;
}

export function readCommandCodeModels() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH(), "utf8"));
    return typeof config.model === "string" && config.model !== "" ? [config.model] : [];
  } catch {
    return [];
  }
}

const CATALOG_FILE_SEGMENTS = ["bundled", "command-code-knowledge", "reference", "models.md"];

function catalogFileCandidates() {
  const candidates = [];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    let real;
    try {
      real = fs.realpathSync(path.join(dir, "command-code"));
    } catch {
      continue;
    }
    candidates.push(path.join(path.dirname(real), ...CATALOG_FILE_SEGMENTS));
  }
  return candidates;
}

export function parseCatalogModelIds(markdown) {
  const ids = new Set();
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([^`|]+)`\s*\|/.exec(line);
    if (match) ids.add(match[1].trim());
  }
  return [...ids];
}

export function readCommandCodeCatalogModels() {
  for (const filePath of catalogFileCandidates()) {
    try {
      const ids = parseCatalogModelIds(fs.readFileSync(filePath, "utf8"));
      if (ids.length > 0) return ids;
    } catch {}
  }
  return [];
}
