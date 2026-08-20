import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNdjsonEventParser,
  createOpenAiStreamMapper,
} from "../src/response-translator.mjs";

const FIXTURE_PATH = new URL("./fixtures/alpha-generate-stream.ndjson", import.meta.url);
const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");

const options = { id: "chatcmpl-test", model: "deepseek/deepseek-v4-flash-0731-0731", created: 1787177733 };

const parseSseLine = (line) => JSON.parse(line.slice(6));

const mapFixture = () => {
  const parser = createNdjsonEventParser();
  const mapper = createOpenAiStreamMapper(options);
  const lines = [];
  for (const event of parser.push(FIXTURE)) lines.push(...mapper.map(event));
  lines.push(...mapper.flush());
  return lines;
};

test("push with the whole fixture returns 41 events", () => {
  const parser = createNdjsonEventParser();
  assert.equal(parser.push(FIXTURE).length, 41);
});

test("push in 7-byte chunks returns the same 41 events in order", () => {
  const parser = createNdjsonEventParser();
  const events = [];
  for (let i = 0; i < FIXTURE.length; i += 7) {
    events.push(...parser.push(FIXTURE.slice(i, i + 7)));
  }
  events.push(...parser.flush());
  assert.equal(events.length, 41);
  const whole = createNdjsonEventParser().push(FIXTURE);
  assert.deepEqual(events, whole);
});

test("a JSON line split across push calls is only emitted once completed", () => {
  const parser = createNdjsonEventParser();
  assert.deepEqual(parser.push('{"type":"reasoning-delta","id":"r0","text":"o'), []);
  assert.deepEqual(parser.push('k"}\n'), [{ type: "reasoning-delta", id: "r0", text: "ok" }]);
});

test("an invalid line is dropped without throwing", () => {
  const parser = createNdjsonEventParser();
  assert.deepEqual(parser.push('{"type":"text-delta","id":"t0","text":"ok"}\n{nao-json\n'), [
    { type: "text-delta", id: "t0", text: "ok" },
  ]);
  assert.deepEqual(parser.flush(), []);
});

test("flush emits a valid JSON left in the buffer", () => {
  const parser = createNdjsonEventParser();
  assert.deepEqual(parser.push('{"type":"start"}\n{"type":"finish"}'), [
    { type: "start" },
  ]);
  assert.deepEqual(parser.flush(), [{ type: "finish" }]);
});

test("first chunk carries delta.role assistant and later chunks do not repeat it", () => {
  const parser = createNdjsonEventParser();
  const mapper = createOpenAiStreamMapper(options);
  const lines = [];
  for (const event of parser.push(FIXTURE)) lines.push(...mapper.map(event));

  const firstWithDelta = lines.map(parseSseLine).find((c) => c.choices[0].delta.role);
  assert.equal(firstWithDelta.choices[0].delta.role, "assistant");

  let seenRole = false;
  for (const line of lines) {
    const delta = parseSseLine(line).choices[0].delta;
    if (delta.role) {
      assert.equal(delta.role, "assistant");
      assert.equal(seenRole, false, "role must appear only once across chunks");
      seenRole = true;
    }
  }
  assert.equal(seenRole, true);
});

test("text-delta maps to delta.content and reasoning-delta to delta.reasoning_content", () => {
  const mapper = createOpenAiStreamMapper(options);
  const textChunks = mapper.map({ type: "text-delta", id: "txt-0", text: "ok" }).map(parseSseLine);
  assert.equal(textChunks[0].choices[0].delta.content, "ok");

  const reasoningChunks = mapper.map({ type: "reasoning-delta", id: "r0", text: "O" }).map(parseSseLine);
  assert.equal(reasoningChunks[0].choices[0].delta.reasoning_content, "O");
});

test("mapping the fixture produces the concatenated text ok", () => {
  const parser = createNdjsonEventParser();
  const mapper = createOpenAiStreamMapper(options);
  let content = "";
  for (const event of parser.push(FIXTURE)) {
    for (const line of mapper.map(event)) {
      const delta = parseSseLine(line).choices[0].delta;
      if (delta.content) content += delta.content;
    }
  }
  assert.equal(content, "ok");
});

test("finish produces finish_reason stop and the usage mapping", () => {
  const mapper = createOpenAiStreamMapper(options);
  const lines = mapper.map({
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: {
      inputTokens: 7641,
      inputTokenDetails: { noCacheTokens: 89, cacheReadTokens: 7552 },
      outputTokens: 33,
      outputTokenDetails: { textTokens: 2, reasoningTokens: 31 },
      totalTokens: 7674,
      reasoningTokens: 31,
      cachedInputTokens: 7552,
    },
  });
  assert.equal(lines.length, 1);
  const chunk = parseSseLine(lines[0]);
  assert.equal(chunk.choices[0].finish_reason, "stop");
  assert.equal(chunk.usage.prompt_tokens, 7641);
  assert.equal(chunk.usage.completion_tokens, 33);
  assert.equal(chunk.usage.total_tokens, 7674);
  assert.equal(chunk.usage.prompt_tokens_details.cached_tokens, 7552);
  assert.equal(chunk.usage.completion_tokens_details.reasoning_tokens, 31);
});

test("finishReason tool-calls maps to finish_reason tool_calls", () => {
  const mapper = createOpenAiStreamMapper(options);
  const chunk = parseSseLine(mapper.map({ type: "finish", finishReason: "tool-calls" })[0]);
  assert.equal(chunk.choices[0].finish_reason, "tool_calls");
});

test("two consecutive tool-call events produce indexes 0 and 1 with JSON-string arguments", () => {
  const mapper = createOpenAiStreamMapper(options);
  const first = parseSseLine(mapper.map({
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "get_weather",
    input: { city: "Lisboa" },
  })[0]);
  const second = parseSseLine(mapper.map({
    type: "tool-call",
    toolCallId: "call_2",
    toolName: "get_weather",
    input: { city: "Porto" },
  })[0]);

  const toolCall1 = first.choices[0].delta.tool_calls[0];
  assert.equal(toolCall1.index, 0);
  assert.equal(toolCall1.id, "call_1");
  assert.equal(toolCall1.type, "function");
  assert.equal(toolCall1.function.name, "get_weather");
  assert.equal(typeof toolCall1.function.arguments, "string");
  assert.deepEqual(JSON.parse(toolCall1.function.arguments), { city: "Lisboa" });

  const toolCall2 = second.choices[0].delta.tool_calls[0];
  assert.equal(toolCall2.index, 1);
  assert.equal(toolCall2.id, "call_2");
});

test("a string input is used as-is without double stringifying", () => {
  const mapper = createOpenAiStreamMapper(options);
  const chunk = parseSseLine(mapper.map({
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "get_weather",
    input: '{"city":"Lisboa"}',
  })[0]);
  assert.equal(chunk.choices[0].delta.tool_calls[0].function.arguments, '{"city":"Lisboa"}');
});

test("mapper flush returns data [DONE] as the last line", () => {
  const lines = mapFixture();
  assert.equal(lines[lines.length - 1], "data: [DONE]\n\n");
});

test("mapper flush after finish does not repeat the final chunk", () => {
  const mapper = createOpenAiStreamMapper(options);
  mapper.map({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1 } });
  assert.deepEqual(mapper.flush(), ["data: [DONE]\n\n"]);
});

test("error with a message object produces the upstream error chunk", () => {
  const mapper = createOpenAiStreamMapper(options);
  const lines = mapper.map({ type: "error", error: { message: "x", statusCode: 429, isRetryable: true } });
  assert.equal(lines.length, 1);
  const chunk = parseSseLine(lines[0]);
  assert.equal(chunk.error.message, "x");
  assert.equal(chunk.error.type, "upstream_error");
  assert.equal(chunk.error.code, 429);
});

test("error with a string message keeps the string and null code", () => {
  const mapper = createOpenAiStreamMapper(options);
  const chunk = parseSseLine(mapper.map({ type: "error", error: "boom" })[0]);
  assert.equal(chunk.error.message, "boom");
  assert.equal(chunk.error.code, null);
});

test("error without a message falls back to Stream error", () => {
  const mapper = createOpenAiStreamMapper(options);
  const chunk = parseSseLine(mapper.map({ type: "error" })[0]);
  assert.equal(chunk.error.message, "Stream error");
});

test("abort ends the sequence as finish_reason stop without usage", () => {
  const mapper = createOpenAiStreamMapper(options);
  const chunk = parseSseLine(mapper.map({ type: "abort" })[0]);
  assert.equal(chunk.choices[0].finish_reason, "stop");
  assert.equal(chunk.usage, undefined);
});

test("start events and unknown types are ignored", () => {
  const mapper = createOpenAiStreamMapper(options);
  assert.deepEqual(mapper.map({ type: "start" }), []);
  assert.deepEqual(mapper.map({ type: "provider-metadata", providerMetadata: {} }), []);
  assert.deepEqual(mapper.map({ type: "unknown-thing" }), []);
});

test("delta chunks carry the id object model created and index 0", () => {
  const mapper = createOpenAiStreamMapper(options);
  const chunk = parseSseLine(mapper.map({ type: "text-delta", id: "txt-0", text: "ok" })[0]);
  assert.equal(chunk.id, "chatcmpl-test");
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(chunk.created, 1787177733);
  assert.equal(chunk.model, "deepseek/deepseek-v4-flash-0731-0731");
  assert.equal(chunk.choices[0].index, 0);
  assert.equal(chunk.choices[0].finish_reason, null);
});