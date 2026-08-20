import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNdjsonEventParser } from "../src/response-translator.mjs";
import { aggregateCompletion } from "../src/completion-aggregator.mjs";

const FIXTURE_PATH = new URL("./fixtures/alpha-generate-stream.ndjson", import.meta.url);
const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");

const options = { id: "chatcmpl-test", model: "deepseek/deepseek-v4-flash-0731-0731-0731-0731", created: 1787177733 };

const parseFixture = () => {
  const parser = createNdjsonEventParser();
  return [...parser.push(FIXTURE), ...parser.flush()];
};

test("aggregating the whole fixture produces content ok", () => {
  const completion = aggregateCompletion(parseFixture(), options);
  assert.equal(completion.choices[0].message.content, "ok");
});

test("aggregating the whole fixture produces non-empty reasoning_content", () => {
  const completion = aggregateCompletion(parseFixture(), options);
  const reasoning = completion.choices[0].message.reasoning_content;
  assert.equal(typeof reasoning, "string");
  assert.ok(reasoning.length > 0);
});

test("aggregating the whole fixture produces finish_reason stop", () => {
  const completion = aggregateCompletion(parseFixture(), options);
  assert.equal(completion.choices[0].finish_reason, "stop");
});

test("aggregating the whole fixture produces the expected usage", () => {
  const completion = aggregateCompletion(parseFixture(), options);
  const usage = completion.usage;
  assert.equal(usage.prompt_tokens, 7641);
  assert.equal(usage.completion_tokens, 33);
  assert.equal(usage.total_tokens, 7674);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 7552);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 31);
});

test("no reasoning-delta leaves the reasoning_content key out", () => {
  const events = [
    { type: "start" },
    { type: "text-delta", id: "txt-0", text: "oi" },
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1 } },
  ];
  const message = aggregateCompletion(events, options).choices[0].message;
  assert.equal("reasoning_content" in message, false);
});

test("no tool-call leaves the tool_calls key out", () => {
  const events = [
    { type: "text-delta", id: "txt-0", text: "oi" },
    { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1 } },
  ];
  const message = aggregateCompletion(events, options).choices[0].message;
  assert.equal("tool_calls" in message, false);
});

test("two tool-call events produce two items in order with string arguments", () => {
  const events = [
    { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "Lisboa" } },
    { type: "tool-call", toolCallId: "call_2", toolName: "get_weather", input: { city: "Porto" } },
    { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 1 } },
  ];
  const toolCalls = aggregateCompletion(events, options).choices[0].message.tool_calls;
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].id, "call_1");
  assert.equal(toolCalls[0].function.name, "get_weather");
  assert.equal(typeof toolCalls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: "Lisboa" });
  assert.equal(toolCalls[1].id, "call_2");
  assert.deepEqual(JSON.parse(toolCalls[1].function.arguments), { city: "Porto" });
});

test("a string input is used as-is without double stringifying", () => {
  const events = [
    { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: '{"city":"Lisboa"}' },
    { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 1 } },
  ];
  const toolCalls = aggregateCompletion(events, options).choices[0].message.tool_calls;
  assert.equal(toolCalls[0].function.arguments, '{"city":"Lisboa"}');
});

test("finishReason tool-calls maps to finish_reason tool_calls", () => {
  const completion = aggregateCompletion(
    [{ type: "finish", finishReason: "tool-calls", totalUsage: {} }],
    options,
  );
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
});

test("an empty list produces empty content, stop and zeroed usage", () => {
  const completion = aggregateCompletion([], options);
  assert.equal(completion.choices[0].message.content, "");
  assert.equal(completion.choices[0].finish_reason, "stop");
  assert.deepEqual(completion.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
});

test("an error event throws with the message and statusCode", () => {
  assert.throws(
    () => aggregateCompletion([{ type: "error", error: { message: "x", statusCode: 429 } }], options),
    (err) => err instanceof Error && err.message === "x" && err.statusCode === 429,
  );
});

test("an error with a string message throws with the string and null statusCode", () => {
  assert.throws(
    () => aggregateCompletion([{ type: "error", error: "boom" }], options),
    (err) => err instanceof Error && err.message === "boom" && err.statusCode === null,
  );
});

test("an error without a message falls back to Stream error", () => {
  assert.throws(
    () => aggregateCompletion([{ type: "error" }], options),
    (err) => err instanceof Error && err.message === "Stream error",
  );
});

test("the completion object carries object id model and created", () => {
  const completion = aggregateCompletion(parseFixture(), options);
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.id, "chatcmpl-test");
  assert.equal(completion.model, "deepseek/deepseek-v4-flash-0731-0731-0731-0731");
  assert.equal(completion.created, 1787177733);
  assert.equal(completion.choices[0].index, 0);
});
