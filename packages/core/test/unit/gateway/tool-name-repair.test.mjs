import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { ClaudeCodeRouterPlugin } from "@ccr/core/gateway/claude-code-router-plugin.ts";
import {
  declaredToolNames,
  repairedToolNameForTest,
  repairToolNamesInValueForTest,
  repairToolNamesResponseStream,
  shouldRepairToolNames
} from "@ccr/core/gateway/features/tool-name-repair.ts";
import { GatewayRequestPipeline } from "@ccr/core/gateway/request/pipeline.ts";

const claudeCodeTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("truncated and miscased tool names resolve to the declared tool", () => {
  assert.equal(repairedToolNameForTest("rea", claudeCodeTools), "Read");
  assert.equal(repairedToolNameForTest("Rea", claudeCodeTools), "Read");
  assert.equal(repairedToolNameForTest("READ", claudeCodeTools), "Read");
  assert.equal(repairedToolNameForTest("bas", claudeCodeTools), "Bash");
});

test("exact, ambiguous and unknown tool names are left untouched", () => {
  assert.equal(repairedToolNameForTest("Read", claudeCodeTools), undefined);
  assert.equal(repairedToolNameForTest("G", claudeCodeTools), undefined);
  assert.equal(repairedToolNameForTest("Raed", claudeCodeTools), undefined);
  assert.equal(repairedToolNameForTest("WebFetch", claudeCodeTools), undefined);
  assert.equal(repairedToolNameForTest(undefined, claudeCodeTools), undefined);
});

test("declared tool names are read from every request protocol shape", () => {
  const anthropic = Buffer.from(JSON.stringify({ tools: [{ input_schema: {}, name: "Read" }] }));
  const openAiChat = Buffer.from(JSON.stringify({ tools: [{ function: { name: "Read" }, type: "function" }] }));
  const openAiResponses = Buffer.from(JSON.stringify({ tools: [{ name: "Read", type: "function" }] }));
  const gemini = Buffer.from(JSON.stringify({ tools: [{ functionDeclarations: [{ name: "Read" }] }] }));

  assert.deepEqual(declaredToolNames(anthropic), ["Read"]);
  assert.deepEqual(declaredToolNames(openAiChat), ["Read"]);
  assert.deepEqual(declaredToolNames(openAiResponses), ["Read"]);
  assert.deepEqual(declaredToolNames(gemini), ["Read"]);
  assert.deepEqual(declaredToolNames(Buffer.from("not-json")), []);
  assert.deepEqual(declaredToolNames(undefined), []);
});

test("repair runs only for JSON and SSE responses that declared tools", () => {
  assert.equal(shouldRepairToolNames({ contentType: "text/event-stream", toolNames: claudeCodeTools }), true);
  assert.equal(shouldRepairToolNames({ contentType: "application/json", toolNames: claudeCodeTools }), true);
  assert.equal(shouldRepairToolNames({ contentType: "text/plain", toolNames: claudeCodeTools }), false);
  assert.equal(shouldRepairToolNames({ contentType: "application/json", toolNames: [] }), false);
});

test("Anthropic SSE tool_use name is repaired across chunk boundaries", async () => {
  const toolBlock = 'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"rea","input":{}}}\n\n';
  const output = await streamText(repairToolNamesResponseStream(
    Readable.from([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"k3","content":[]}}\n\n',
      toolBlock.slice(0, 60),
      toolBlock.slice(60),
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"a\\"}"}}\n\n',
      "data: [DONE]\n\n"
    ]),
    "text/event-stream; charset=utf-8",
    claudeCodeTools
  ));

  assert.match(output, /"name":"Read"/);
  assert.doesNotMatch(output, /"name":"rea"/);
  assert.match(output, /event: content_block_start\n/);
  assert.match(output, /"partial_json"/);
  assert.match(output, /data: \[DONE\]\n\n$/);
});

test("Anthropic JSON tool_use name is repaired", async () => {
  const output = await streamText(repairToolNamesResponseStream(
    Readable.from([JSON.stringify({
      content: [
        { text: "vou ler o arquivo", type: "text" },
        { id: "toolu_1", input: { file_path: "a" }, name: "Rea", type: "tool_use" }
      ],
      role: "assistant",
      type: "message"
    })]),
    "application/json",
    claudeCodeTools
  ));

  assert.equal(JSON.parse(output).content[1].name, "Read");
});

test("OpenAI chat tool call name is repaired only on the chunk that opens the call", async () => {
  const output = await streamText(repairToolNamesResponseStream(
    Readable.from([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","index":0,"type":"function","function":{"name":"rea","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"rea","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n"
    ]),
    "text/event-stream",
    claudeCodeTools
  ));

  const events = output.split("\n\n").filter((block) => block.startsWith("data: {"));
  assert.equal(JSON.parse(events[0].slice(6)).choices[0].delta.tool_calls[0].function.name, "Read");
  assert.equal(JSON.parse(events[1].slice(6)).choices[0].delta.tool_calls[0].function.name, "rea");
});

test("OpenAI responses and Gemini tool call names are repaired", () => {
  const responses = repairToolNamesInValueForTest({
    item: { arguments: "{}", call_id: "call_1", name: "rea", type: "function_call" },
    type: "response.output_item.added"
  }, claudeCodeTools);
  const gemini = repairToolNamesInValueForTest({
    candidates: [{ content: { parts: [{ functionCall: { args: {}, name: "rea" } }] } }]
  }, claudeCodeTools);

  assert.equal(responses.changed, true);
  assert.equal(responses.value.item.name, "Read");
  assert.equal(gemini.changed, true);
  assert.equal(gemini.value.candidates[0].content.parts[0].functionCall.name, "Read");
});

test("unrelated name fields are never rewritten", () => {
  const repaired = repairToolNamesInValueForTest({
    message: { model: "rea", name: "rea" },
    type: "message_start"
  }, claudeCodeTools);

  assert.equal(repaired.changed, false);
  assert.equal(repaired.value.message.name, "rea");
});

test("gateway pipeline repairs a truncated tool name before it reaches the client", async () => {
  const config = createPipelineConfigForToolNameRepair();
  const plugin = new ClaudeCodeRouterPlugin(config);
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "core-token",
    getPlugin: () => plugin,
    getStatus: () => ({
      coreEndpoint: "http://127.0.0.1:65535",
      endpoint: "http://127.0.0.1:3456"
    })
  });
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = (message, ...args) => {
    if (String(message).startsWith("[usage] Failed to record usage:")) {
      return;
    }
    originalWarn(message, ...args);
  };
  globalThis.fetch = async () => new Response(
    [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"k3","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"rea","input":{}}}\n\n',
      "data: [DONE]\n\n"
    ].join(""),
    {
      headers: {
        "content-length": "420",
        "content-type": "text/event-stream; charset=utf-8"
      },
      status: 200
    }
  );

  try {
    const request = Readable.from([JSON.stringify({
      max_tokens: 64,
      messages: [{ content: "leia o arquivo", role: "user" }],
      model: "kimi-test/k3",
      stream: true,
      tools: [{ description: "Read a file", input_schema: { type: "object" }, name: "Read" }]
    })]);
    request.headers = {
      "content-type": "application/json",
      "user-agent": "claude-code/1.0"
    };
    request.method = "POST";
    request.url = "/v1/messages";

    const response = new CapturingResponse();
    const finished = new Promise((resolve, reject) => {
      response.once("finish", resolve);
      response.once("error", reject);
    });
    await pipeline.proxyRequest(request, response, "/v1/messages");
    await finished;

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-length"], undefined);
    assert.match(response.bodyText(), /"name":"Read"/);
    assert.doesNotMatch(response.bodyText(), /"name":"rea"/);
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

function createPipelineConfigForToolNameRepair() {
  return {
    CUSTOM_ROUTER_PATH: "",
    Providers: [
      {
        capabilities: [{ baseUrl: "http://kimi.example/v1/messages", type: "anthropic_messages" }],
        models: ["k3"],
        name: "kimi-test"
      }
    ],
    Router: {
      builtInRules: {
        "claude-code": { enabled: false },
        codex: { enabled: false }
      },
      fallback: { mode: "off", models: [], retryCount: 0 },
      rules: []
    },
    contextArchive: {
      enabled: false,
      mcpEnabled: false
    },
    observability: {
      agentAnalysis: false,
      requestLogs: false
    },
    preferredProvider: "kimi-test",
    profile: {
      enabled: false,
      profiles: []
    },
    toolHub: { enabled: false },
    virtualModelProfiles: []
  };
}

class CapturingResponse extends Writable {
  constructor() {
    super();
    this.chunks = [];
    this.headers = {};
    this.statusCode = 0;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = Object.fromEntries(
      Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])
    );
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  bodyText() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
