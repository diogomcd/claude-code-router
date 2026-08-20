import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { buildUpstreamHeaders, callCommandCode } from "../src/upstream-client.mjs";

function startFakeServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
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

test("buildUpstreamHeaders devolve as 5 chaves esperadas, todas em minusculas", () => {
  const headers = buildUpstreamHeaders({ apiKey: "k" });
  assert.deepEqual(Object.keys(headers).sort(), [
    "authorization",
    "content-type",
    "x-cli-environment",
    "x-command-code-version",
    "x-session-id",
  ]);
  for (const key of Object.keys(headers)) {
    assert.equal(key, key.toLowerCase());
  }
});

test("buildUpstreamHeaders usa Bearer com a apiKey", () => {
  const headers = buildUpstreamHeaders({ apiKey: "k" });
  assert.equal(headers.authorization, "Bearer k");
});

test("buildUpstreamHeaders gera x-session-id diferente a cada chamada", () => {
  const first = buildUpstreamHeaders({ apiKey: "k" });
  const second = buildUpstreamHeaders({ apiKey: "k" });
  assert.notEqual(first["x-session-id"], second["x-session-id"]);
});

test("buildUpstreamHeaders respeita sessionId informado", () => {
  const headers = buildUpstreamHeaders({ apiKey: "k", sessionId: "s" });
  assert.equal(headers["x-session-id"], "s");
});

test("buildUpstreamHeaders lanca Error quando apiKey falta", () => {
  assert.throws(() => buildUpstreamHeaders({}), { message: "apiKey is required" });
  assert.throws(() => buildUpstreamHeaders({ apiKey: "" }), { message: "apiKey is required" });
});

test("buildUpstreamHeaders usa defaults de cliVersion e cliEnvironment", () => {
  const headers = buildUpstreamHeaders({ apiKey: "k" });
  assert.equal(headers["x-command-code-version"], "1.28.1");
  assert.equal(headers["x-cli-environment"], "production");
});

test("buildUpstreamHeaders respeita cliVersion e cliEnvironment informados", () => {
  const headers = buildUpstreamHeaders({ apiKey: "k", cliVersion: "2.0.0", cliEnvironment: "staging" });
  assert.equal(headers["x-command-code-version"], "2.0.0");
  assert.equal(headers["x-cli-environment"], "staging");
});

test("callCommandCode faz POST em /alpha/generate com os 5 headers e o corpo JSON", async (t) => {
  let captured;
  const { server, baseUrl } = await startFakeServer(async (req, res) => {
    const body = await collectRequest(req);
    captured = { url: req.url, method: req.method, headers: req.headers, body };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('{"ok":true}\n');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const body = { model: "m", messages: [{ role: "user", content: "oi" }] };
  const response = await callCommandCode({
    baseUrl,
    body,
    apiKey: "k",
    cliVersion: "1.28.1",
    cliEnvironment: "production",
    sessionId: "sessao-1",
  });

  assert.equal(captured.method, "POST");
  assert.equal(captured.url, "/alpha/generate");
  assert.equal(captured.headers.authorization, "Bearer k");
  assert.equal(captured.headers["content-type"], "application/json");
  assert.equal(captured.headers["x-command-code-version"], "1.28.1");
  assert.equal(captured.headers["x-cli-environment"], "production");
  assert.equal(captured.headers["x-session-id"], "sessao-1");
  assert.equal(captured.body, JSON.stringify(body));
  assert.deepEqual(JSON.parse(captured.body), body);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}\n');
});

test("callCommandCode usa a mesma URL com e sem barra final", async (t) => {
  const urls = [];
  const { server, baseUrl } = await startFakeServer(async (req, res) => {
    urls.push(req.url);
    res.writeHead(200);
    res.end();
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await callCommandCode({ baseUrl, body: {}, apiKey: "k" });
  await callCommandCode({ baseUrl: `${baseUrl}/`, body: {}, apiKey: "k" });

  assert.deepEqual(urls, ["/alpha/generate", "/alpha/generate"]);
});

test("callCommandCode devolve a Response sem ler o corpo", async (t) => {
  const { server, baseUrl } = await startFakeServer(async (req, res) => {
    await collectRequest(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('{"event":"done"}\n');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await callCommandCode({ baseUrl, body: {}, apiKey: "k" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"event":"done"}\n');
});

test("callCommandCode usa fetchImpl no lugar de globalThis.fetch", async (t) => {
  const { server, baseUrl } = await startFakeServer(async (req, res) => {
    await collectRequest(req);
    res.writeHead(200);
    res.end();
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let calledWith;
  const fakeFetch = async (url, options) => {
    calledWith = { url, options };
    return globalThis.fetch(url, options);
  };

  const body = { model: "m" };
  await callCommandCode({ baseUrl, body, apiKey: "k", fetchImpl: fakeFetch });

  assert.equal(calledWith.url, `${baseUrl}/alpha/generate`);
  assert.equal(calledWith.options.method, "POST");
  assert.equal(calledWith.options.body, JSON.stringify(body));
  assert.equal(calledWith.options.headers.authorization, "Bearer k");
});

test("callCommandCode repassa signal quando informado", async (t) => {
  const controller = new AbortController();
  const { server, baseUrl } = await startFakeServer(async (req, res) => {
    await collectRequest(req);
    res.writeHead(200);
    res.end();
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let capturedOptions;
  const fakeFetch = async (url, options) => {
    capturedOptions = options;
    return globalThis.fetch(url, options);
  };

  await callCommandCode({
    baseUrl,
    body: {},
    apiKey: "k",
    signal: controller.signal,
    fetchImpl: fakeFetch,
  });

  assert.equal(capturedOptions.signal, controller.signal);
});
test("callCommandCode sem baseUrl usa a URL de producao da Command Code", async () => {
  let capturedUrl;
  const fakeFetch = async (url) => {
    capturedUrl = url;
    return new Response("", { status: 200 });
  };

  await callCommandCode({ body: { model: "m" }, apiKey: "k", fetchImpl: fakeFetch });

  assert.equal(capturedUrl, "https://api.commandcode.ai/alpha/generate");
});
