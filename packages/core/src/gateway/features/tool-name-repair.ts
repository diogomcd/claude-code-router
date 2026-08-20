/**
 * Keep this module focused on its named gateway boundary.
 *
 * Some models emit a truncated or differently-cased tool name ("rea", "Rea"
 * instead of "Read"). The client rejects the unknown tool, the model retries
 * the same broken name, and the turn never terminates. Repairing the name
 * against the tools the client actually declared breaks that loop.
 */
import { Readable, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";

export function declaredToolNames(body: Buffer | undefined): string[] {
  if (!body?.length) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
    return [];
  }

  const names = new Set<string>();
  for (const tool of parsed.tools) {
    if (!isRecord(tool)) {
      continue;
    }
    addToolName(names, tool.name);
    if (isRecord(tool.function)) {
      addToolName(names, tool.function.name);
    }
    if (Array.isArray(tool.functionDeclarations)) {
      for (const declaration of tool.functionDeclarations) {
        if (isRecord(declaration)) {
          addToolName(names, declaration.name);
        }
      }
    }
  }
  return [...names];
}

export function shouldRepairToolNames(input: {
  contentType: string | undefined;
  toolNames: string[];
}): boolean {
  if (input.toolNames.length === 0) {
    return false;
  }
  const contentType = input.contentType?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream") || contentType.includes("application/json");
}

export function repairToolNamesResponseStream(
  input: Readable,
  contentType: string | undefined,
  toolNames: string[]
): Readable {
  return contentType?.toLowerCase().includes("text/event-stream")
    ? repairToolNamesSseStream(input, toolNames)
    : repairToolNamesJsonStream(input, toolNames);
}

function addToolName(names: Set<string>, value: unknown): void {
  const name = stringValue(value);
  if (name) {
    names.add(name);
  }
}

function repairToolNamesJsonStream(input: Readable, toolNames: string[]): Readable {
  const chunks: Buffer[] = [];
  return input.pipe(new Transform({
    transform(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
    flush(callback) {
      const body = Buffer.concat(chunks).toString("utf8");
      this.push(repairToolNamesInJsonText(body, toolNames));
      callback();
    }
  }));
}

function repairToolNamesSseStream(input: Readable, toolNames: string[]): Readable {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return input.pipe(new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      pending = drainSseBlocks(this, pending, toolNames, false);
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      drainSseBlocks(this, pending, toolNames, true);
      pending = "";
      callback();
    }
  }));
}

function drainSseBlocks(
  stream: Transform,
  text: string,
  toolNames: string[],
  flush: boolean
): string {
  let cursor = 0;
  for (const match of text.matchAll(/\r?\n\r?\n/g)) {
    const index = match.index ?? 0;
    const delimiter = match[0];
    const block = text.slice(cursor, index);
    cursor = index + delimiter.length;
    stream.push(`${repairToolNamesInSseBlock(block, toolNames)}${delimiter}`);
  }

  const trailing = text.slice(cursor);
  if (!flush) {
    return trailing;
  }
  if (trailing) {
    stream.push(repairToolNamesInSseBlock(trailing, toolNames));
  }
  return "";
}

function repairToolNamesInSseBlock(block: string, toolNames: string[]): string {
  if (!block.trim()) {
    return block;
  }
  const data = sseBlockData(block);
  if (data === undefined) {
    return block;
  }
  const repaired = repairToolNamesInValue(data, toolNames);
  return repaired.changed ? replaceSseDataLines(block, JSON.stringify(repaired.value)) : block;
}

function repairToolNamesInJsonText(body: string, toolNames: string[]): string {
  if (!body.trim()) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return body;
  }
  const repaired = repairToolNamesInValue(parsed, toolNames);
  return repaired.changed ? JSON.stringify(repaired.value) : body;
}

function sseBlockData(block: string): unknown {
  const data = block
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function replaceSseDataLines(block: string, data: string): string {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const output: string[] = [];
  let replaced = false;
  for (const line of block.split(/\r?\n/g)) {
    if (!line.startsWith("data:")) {
      output.push(line);
      continue;
    }
    if (!replaced) {
      output.push(`data: ${data}`);
      replaced = true;
    }
  }
  return output.join(newline);
}

function repairToolNamesInValue(value: unknown, toolNames: string[]): { changed: boolean; value: unknown } {
  const state = { changed: false };
  const repaired = repairValue(value, toolNames, state);
  return { changed: state.changed, value: repaired };
}

function repairValue(value: unknown, toolNames: string[], state: { changed: boolean }): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => repairValue(item, toolNames, state));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isRecord(value)) {
    return value;
  }

  let repaired = value;
  const directName = isToolCallBlock(value)
    ? repairedToolName(stringValue(value.name), toolNames)
    : undefined;
  if (directName) {
    repaired = { ...repaired, name: directName };
    state.changed = true;
  }
  // Gemini `functionCall` and OpenAI chat `tool_calls[].function` carry the name
  // one level down. The OpenAI shape is only repaired on the chunk that opens
  // the call (the one carrying `id`); later chunks stream `arguments` and can
  // legitimately hold a partial name fragment.
  const nestedName = isRecord(value.functionCall)
    ? repairedToolName(stringValue(value.functionCall.name), toolNames)
    : undefined;
  if (nestedName && isRecord(value.functionCall)) {
    repaired = { ...repaired, functionCall: { ...value.functionCall, name: nestedName } };
    state.changed = true;
  }
  const openAiName = isRecord(value.function) && stringValue(value.id)
    ? repairedToolName(stringValue(value.function.name), toolNames)
    : undefined;
  if (openAiName && isRecord(value.function)) {
    repaired = { ...repaired, function: { ...value.function, name: openAiName } };
    state.changed = true;
  }

  for (const [key, child] of Object.entries(repaired)) {
    const repairedChild = repairValue(child, toolNames, state);
    if (repairedChild !== child) {
      repaired = { ...repaired, [key]: repairedChild };
    }
  }
  return repaired;
}

function isToolCallBlock(value: Record<string, unknown>): boolean {
  const type = stringValue(value.type);
  return type === "tool_use" || type === "function_call";
}

function repairedToolName(name: string | undefined, toolNames: string[]): string | undefined {
  if (!name || toolNames.includes(name)) {
    return undefined;
  }
  const lowered = name.toLowerCase();
  const sameNameIgnoringCase = toolNames.filter((tool) => tool.toLowerCase() === lowered);
  if (sameNameIgnoringCase.length === 1) {
    return sameNameIgnoringCase[0];
  }
  const singlePrefixMatch = toolNames.filter((tool) => tool.toLowerCase().startsWith(lowered));
  return singlePrefixMatch.length === 1 ? singlePrefixMatch[0] : undefined;
}

export const repairToolNamesInValueForTest = repairToolNamesInValue;
export const repairedToolNameForTest = repairedToolName;
