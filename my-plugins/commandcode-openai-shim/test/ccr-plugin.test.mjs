import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { ROUTE_PREFIX, setup } from "../ccr-plugin.mjs";

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

test("setup lanca Error com a mensagem exata quando apiKey falta", () => {
  assert.throws(
    () => setup({ pluginConfig: {} }),
    { message: "commandcode-shim plugin requires apiKey in its plugin config" },
  );
});

test("setup sem argumento lanca o mesmo Error sem TypeError", () => {
  assert.throws(
    () => setup(),
    { message: "commandcode-shim plugin requires apiKey in its plugin config" },
  );
});

test("requisicao real a /commandcode/health devolve 200 com status ok", async (t) => {
  const registration = setup({ pluginConfig: { apiKey: "k" } });
  const { server, baseUrl } = await startServer(registration.gatewayRoutes[0].handler);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}${ROUTE_PREFIX}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
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
