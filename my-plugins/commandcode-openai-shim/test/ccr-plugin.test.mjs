import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

import { ROUTE_PREFIX, setup } from "../ccr-plugin.mjs";

const chatBody = () => ({
  model: "deepseek/deepseek-v4-flash-0731-0731",
  messages: [{ role: "user", content: "ok" }],
});

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("ROUTE_PREFIX e exportado como /commandcode", () => {
  assert.equal(ROUTE_PREFIX, "/commandcode");
});

test("setup devolve gatewayRoutes com exatamente 1 rota configurada", () => {
  const registration = setup({ pluginConfig: { apiKey: "k" } });
  assert.ok(registration);
  assert.ok(Array.isArray(registration.gatewayRoutes));
  assert.equal(registration.gatewayRoutes.length, 1);
});

test("a rota tem pathPrefix, auth, methods e handler esperados", () => {
  const registration = setup({ pluginConfig: { apiKey: "k" } });
  const route = registration.gatewayRoutes[0];

  assert.equal(route.id, "commandcode-shim");
  assert.equal(route.pathPrefix, "/commandcode");
  assert.equal(route.auth, "none");
  assert.ok(route.methods.includes("GET"));
  assert.ok(route.methods.includes("POST"));
  assert.equal(typeof route.handler, "function");
});

test("setup nao exige mais apiKey no pluginConfig; a credencial vem da CLI em cada request", () => {
  const registration = setup();
  assert.equal(registration.gatewayRoutes.length, 1);
});

test("request de chat sem auth.json valida devolve 503 credential_error", async (t) => {
  t.mock.method(fs, "readFileSync", () => {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  });
  const registration = setup();
  const { server, baseUrl } = await startServer(registration.gatewayRoutes[0].handler);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}${ROUTE_PREFIX}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(chatBody()),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.type, "credential_error");
});

test("requisicao real a /commandcode/health devolve 200 com status ok", async (t) => {
  t.mock.method(fs, "readFileSync", (filePath) => {
    if (String(filePath).endsWith("auth.json")) return JSON.stringify({ apiKey: "k" });
    return JSON.stringify({ model: "deepseek/deepseek-v4-pro" });
  });
  const registration = setup();
  const { server, baseUrl } = await startServer(registration.gatewayRoutes[0].handler);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}${ROUTE_PREFIX}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("GET /commandcode/v1/models junta catalogo da CLI e modelo configurado", async (t) => {
  t.mock.method(fs, "readFileSync", (filePath) => {
    const file = String(filePath);
    if (file.endsWith("auth.json")) return JSON.stringify({ apiKey: "k" });
    if (file.endsWith("config.json")) return JSON.stringify({ model: "deepseek/deepseek-v4-pro" });
    if (file.endsWith("models.md")) {
      return [
        "# Command Code Models",
        "| Id (use EXACTLY this) | Name |",
        "|---|---|",
        "| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro |",
        "| `moonshotai/kimi-k3` | Kimi K3 |",
      ].join("\n");
    }
    throw new Error(`unexpected read: ${file}`);
  });
  const registration = setup();
  const { server, baseUrl } = await startServer(registration.gatewayRoutes[0].handler);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}${ROUTE_PREFIX}/v1/models`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    object: "list",
    data: [
      { id: "deepseek/deepseek-v4-pro", object: "model", owned_by: "command-code" },
      { id: "moonshotai/kimi-k3", object: "model", owned_by: "command-code" },
    ],
  });
});

test("GET /commandcode/v1/models sem nada disponivel devolve lista vazia", async (t) => {
  t.mock.method(fs, "readFileSync", () => JSON.stringify({ apiKey: "k" }));
  t.mock.method(fs, "realpathSync", () => {
    throw new Error("ENOENT");
  });
  t.mock.method(fs, "realpathSync", () => {
    throw new Error("ENOENT");
  });
  const registration = setup();
  const { server, baseUrl } = await startServer(registration.gatewayRoutes[0].handler);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}${ROUTE_PREFIX}/v1/models`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object: "list", data: [] });
});

test("requisicao real a /commandcode/caminho-inexistente devolve 404", async (t) => {
  const registration = setup({ pluginConfig: { apiKey: "k" } });
  const { server, baseUrl } = await startServer(registration.gatewayRoutes[0].handler);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}${ROUTE_PREFIX}/caminho-inexistente`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.message, "Not found");
  assert.equal(body.error.type, "not_found_error");
});
