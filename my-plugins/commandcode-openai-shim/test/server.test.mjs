import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createShimServer } from "../src/server.mjs";

const FIXTURE_PATH = new URL("./fixtures/alpha-generate-stream.ndjson", import.meta.url);
const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");

const API_KEY = "test-key";
const CLI_VERSION = "1.28.1";
const CLI_ENVIRONMENT = "production";

function startServer(createServer) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function collectRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function startFakeUpstream(options = {}) {
  const { status = 200, body = FIXTURE } = options;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const rawBody = await collectRequest(req);
    requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: rawBody === "" ? null : JSON.parse(rawBody),
    });
    res.writeHead(status, { "content-type": "text/event-stream" });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function startShim(upstreamBaseUrl, fetchImpl) {
  return startServer(() =>
    createShimServer({
      apiKey: API_KEY,
      baseUrl: upstreamBaseUrl,
      cliVersion: CLI_VERSION,
      cliEnvironment: CLI_ENVIRONMENT,
      fetchImpl,
    }),
  );
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

const chatBody = () => ({
  model: "deepseek/deepseek-v4-flash-0731-0731",
  messages: [{ role: "user", content: "ok" }],
});

const parseSseLine = (line) => JSON.parse(line.slice(6));

const deltaContentFromChunks = (text) => {
  let content = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const delta = parseSseLine(line).choices[0].delta;
    if (delta.content) content += delta.content;
  }
  return content;
};

test("GET /health devolve 200 com status ok", async (t) => {
  const { server, baseUrl } = await startServer(() => createShimServer({ apiKey: API_KEY }));
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("GET /v1/chat/completions devolve 404 com o formato de erro padronizado", async (t) => {
  const { server, baseUrl } = await startServer(() => createShimServer({ apiKey: API_KEY }));
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.message, "Not found");
  assert.equal(body.error.type, "not_found_error");
  assert.equal(body.error.code, null);
});

test("POST /v1/chat/completions com corpo invalido devolve 400 invalid_request_error", async (t) => {
  const { server, baseUrl } = await startServer(() => createShimServer({ apiKey: API_KEY }));
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{nao-json",
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.message, "Invalid JSON body");
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.code, null);
});

test("streaming devolve text/event-stream e termina com data [DONE]", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => closeServer(upstream.server));
  const shim = await startShim(upstream.baseUrl);
  t.after(() => closeServer(shim.server));

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...chatBody(), stream: true }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);

  const text = await response.text();
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("streaming concatena delta.content como ok", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => closeServer(upstream.server));
  const shim = await startShim(upstream.baseUrl);
  t.after(() => closeServer(shim.server));

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...chatBody(), stream: true }),
  });

  assert.equal(deltaContentFromChunks(await response.text()), "ok");
});

test("nao-streaming devolve chat.completion com content ok", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => closeServer(upstream.server));
  const shim = await startShim(upstream.baseUrl);
  t.after(() => closeServer(shim.server));

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody()),
  });

  assert.equal(response.headers.get("content-type"), "application/json");
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "ok");
});

test("nao-streaming devolve a contagem de tokens esperada", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => closeServer(upstream.server));
  const shim = await startShim(upstream.baseUrl);
  t.after(() => closeServer(shim.server));

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody()),
  });

  const body = await response.json();
  assert.equal(body.usage.prompt_tokens, 7641);
  assert.equal(body.usage.total_tokens, 7674);
});

test("o upstream falso recebe a requisicao em /alpha/generate com x-command-code-version", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => closeServer(upstream.server));
  const shim = await startShim(upstream.baseUrl);
  t.after(() => closeServer(shim.server));

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody()),
  });
  assert.equal(response.status, 200);

  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].url, "/alpha/generate");
  assert.equal(upstream.requests[0].headers["x-command-code-version"], CLI_VERSION);
});

test("o upstream falso recebe params.stream true mesmo com stream false", async (t) => {
  const upstream = await startFakeUpstream();
  t.after(() => closeServer(upstream.server));
  const shim = await startShim(upstream.baseUrl);
  t.after(() => closeServer(shim.server));

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...chatBody(), stream: false }),
  });
  assert.equal(response.status, 200);

  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].body.params.stream, true);
});

test("upstream 403 faz o shim responder 403 com upstream_error e code 403", async (t) => {
  const upstream = await startFakeUpstream({ status: 403, body: "forbidden" });
  t.after(() => closeServer(upstream.server));
  const shim = await startShim(upstream.baseUrl);
  t.after(() => closeServer(shim.server));

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody()),
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.message, "forbidden");
  assert.equal(body.error.type, "upstream_error");
  assert.equal(body.error.code, 403);
});

test("stream com evento de erro no caminho nao-streaming devolve 429 com a mensagem do erro", async (t) => {
  const errorBody = '{"type":"error","error":{"message":"x","statusCode":429}}\n';
  const upstream = await startFakeUpstream({ body: errorBody });
  t.after(() => closeServer(upstream.server));
  const shim = await startShim(upstream.baseUrl);
  t.after(() => closeServer(shim.server));

  const response = await fetch(`${shim.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody()),
  });

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.message, "x");
  assert.equal(body.error.type, "upstream_error");
  assert.equal(body.error.code, 429);
});