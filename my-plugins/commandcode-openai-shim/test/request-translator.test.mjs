import test from "node:test";
import assert from "node:assert/strict";

import { buildProjectConfig, toCommandCodeRequest } from "../src/request-translator.mjs";

test("buildProjectConfig devolve exatamente as 9 chaves obrigatorias", () => {
  const config = buildProjectConfig();
  assert.deepEqual(Object.keys(config).sort(), [
    "currentBranch",
    "date",
    "environment",
    "gitStatus",
    "isGitRepo",
    "mainBranch",
    "recentCommits",
    "structure",
    "workingDir",
  ]);
});

test("buildProjectConfig aplica overrides por cima dos defaults", () => {
  const config = buildProjectConfig({ workingDir: "/x" });
  assert.equal(config.workingDir, "/x");
  assert.equal(config.isGitRepo, false);
  assert.equal(config.currentBranch, "");
  assert.equal(config.mainBranch, "");
  assert.equal(config.gitStatus, "");
  assert.deepEqual(config.recentCommits, []);
  assert.deepEqual(config.structure, []);
  assert.equal(config.environment, process.platform);
  assert.equal(config.date, new Date().toISOString().slice(0, 10));
});

test("params.stream e sempre true", () => {
  const request = toCommandCodeRequest({ model: "m", messages: [{ role: "user", content: "oi" }] });
  assert.equal(request.params.stream, true);
});

test("stream false no corpo OpenAI ainda produz params.stream true", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [{ role: "user", content: "oi" }],
    stream: false,
  });
  assert.equal(request.params.stream, true);
});

test("duas mensagens system viram params.system unido e somem de params.messages", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      { role: "system", content: "primeira" },
      { role: "user", content: "oi" },
      { role: "system", content: "segunda" },
    ],
  });
  assert.equal(request.params.system, "primeira\n\nsegunda");
  assert.equal(request.params.messages.some((m) => m.role === "system"), false);
  assert.equal(request.params.messages.length, 1);
});

test("tool OpenAI com parameters vira input_schema sem chave parameters", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [{ role: "user", content: "oi" }],
    tools: [
      {
        type: "function",
        function: { name: "buscar", description: "busca", parameters: { type: "object" } },
      },
    ],
  });
  assert.equal(request.params.tools.length, 1);
  assert.equal(request.params.tools[0].name, "buscar");
  assert.equal(request.params.tools[0].description, "busca");
  assert.deepEqual(request.params.tools[0].input_schema, { type: "object" });
  assert.equal("parameters" in request.params.tools[0], false);
});

test("tool sem description e sem parameters usa defaults", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [{ role: "user", content: "oi" }],
    tools: [{ type: "function", function: { name: "vazia" } }],
  });
  assert.equal(request.params.tools[0].description, "");
  assert.deepEqual(request.params.tools[0].input_schema, {});
});

test("assistant com tool_calls parseia arguments em objeto", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      { role: "user", content: "oi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "buscar", arguments: '{"a":1}' } },
        ],
      },
    ],
  });
  const assistant = request.params.messages[1];
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content, [
    { type: "tool-call", toolCallId: "call_1", toolName: "buscar", input: { a: 1 } },
  ]);
});

test("arguments invalido vira input {} ", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      { role: "user", content: "oi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_x", type: "function", function: { name: "f", arguments: "invalido" } },
        ],
      },
    ],
  });
  assert.deepEqual(request.params.messages[1].content[0].input, {});
});

test("mensagem tool casa tool_call_id anterior e recupera toolName", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      { role: "user", content: "oi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "buscar", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "resultado" },
    ],
  });
  const tool = request.params.messages[2];
  assert.equal(tool.role, "tool");
  assert.equal(tool.content[0].toolCallId, "call_1");
  assert.equal(tool.content[0].toolName, "buscar");
  assert.deepEqual(tool.content[0].output, { type: "text", value: "resultado" });
});

test("mensagem tool com id desconhecido usa toolName unknown", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      { role: "user", content: "oi" },
      { role: "tool", tool_call_id: "call_inexistente", content: "resultado" },
    ],
  });
  assert.equal(request.params.messages[1].content[0].toolName, "unknown");
});

test("mensagem tool com content nao string serializa com JSON.stringify", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      { role: "user", content: "oi" },
      { role: "tool", tool_call_id: "call_1", content: { valor: 42 } },
    ],
  });
  assert.equal(request.params.messages[1].content[0].output.value, '{"valor":42}');
});

test("memory, taste e skills presentes e nulos", () => {
  const request = toCommandCodeRequest({ model: "m", messages: [{ role: "user", content: "oi" }] });
  assert.equal("memory" in request, true);
  assert.equal("taste" in request, true);
  assert.equal("skills" in request, true);
  assert.equal(request.memory, null);
  assert.equal(request.taste, null);
  assert.equal(request.skills, null);
  assert.equal(request.permissionMode, "standard");
});

test("user com content string vira bloco texto", () => {
  const request = toCommandCodeRequest({ model: "m", messages: [{ role: "user", content: "oi" }] });
  assert.deepEqual(request.params.messages[0], {
    role: "user",
    content: [{ type: "text", text: "oi" }],
  });
});

test("user multimodal converte image_url em image com mimeType", () => {
  const url = "data:image/png;base64,AAAA";
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "veja" },
          { type: "image_url", image_url: { url } },
          { type: "unknown", whatever: true },
        ],
      },
    ],
  });
  assert.deepEqual(request.params.messages[0].content, [
    { type: "text", text: "veja" },
    { type: "image", image: url, mimeType: "image/png" },
  ]);
});

test("assistant apenas com texto vira bloco texto", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      { role: "user", content: "oi" },
      { role: "assistant", content: "tudo bem?" },
    ],
  });
  assert.deepEqual(request.params.messages[1], {
    role: "assistant",
    content: [{ type: "text", text: "tudo bem?" }],
  });
});

test("assistant vazio (sem texto e sem tool_calls) e omitido", () => {
  const request = toCommandCodeRequest({
    model: "m",
    messages: [
      { role: "user", content: "oi" },
      { role: "assistant", content: "" },
    ],
  });
  assert.equal(request.params.messages.length, 1);
});

test("max_tokens default e 64000 e temperature so entra quando definida", () => {
  const semTemperature = toCommandCodeRequest({
    model: "m",
    messages: [{ role: "user", content: "oi" }],
  });
  assert.equal(semTemperature.params.max_tokens, 64000);
  assert.equal("temperature" in semTemperature.params, false);

  const comTemperature = toCommandCodeRequest({
    model: "m",
    messages: [{ role: "user", content: "oi" }],
    temperature: 0.5,
    max_tokens: 128,
  });
  assert.equal(comTemperature.params.max_tokens, 128);
  assert.equal(comTemperature.params.temperature, 0.5);
});

test("model e copiado e tools ausente vira array vazio", () => {
  const request = toCommandCodeRequest({ model: "m", messages: [{ role: "user", content: "oi" }] });
  assert.equal(request.params.model, "m");
  assert.deepEqual(request.params.tools, []);
});

test("options.projectConfig e repassado a buildProjectConfig", () => {
  const request = toCommandCodeRequest(
    { model: "m", messages: [{ role: "user", content: "oi" }] },
    { projectConfig: { workingDir: "/workspace", isGitRepo: true } },
  );
  assert.equal(request.config.workingDir, "/workspace");
  assert.equal(request.config.isGitRepo, true);
});