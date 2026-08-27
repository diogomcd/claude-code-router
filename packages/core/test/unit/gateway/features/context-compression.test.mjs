import test from "node:test";
import assert from "node:assert/strict";

import { prepareContextCompressionRequest } from "../../../../src/gateway/features/context-compression.js";

const PATH = "/v1/messages";

function configWith(pluginConfig = {}) {
  return {
    plugins: [{ id: "context-compression", enabled: true, config: pluginConfig }]
  };
}

function bigMessages(repetitions = 400) {
  const line = "2026-08-20 10:00:00 INFO worker processed batch status=ok rows=13 ";
  return [
    { role: "user", content: "Analise estes logs:\n" + line.repeat(repetitions) }
  ];
}

function requestBody(messages) {
  return Buffer.from(JSON.stringify({ model: "claude-sonnet-4", messages }));
}

test("returns undefined when the feature is not configured", async () => {
  const result = await prepareContextCompressionRequest({
    body: requestBody(bigMessages()),
    config: { plugins: [] },
    method: "POST",
    path: PATH
  });
  assert.equal(result, undefined);
});

test("returns undefined when the plugin is disabled", async () => {
  const result = await prepareContextCompressionRequest({
    body: requestBody(bigMessages()),
    config: { plugins: [{ id: "context-compression", enabled: false, config: {} }] },
    method: "POST",
    path: PATH
  });
  assert.equal(result, undefined);
});

test("returns undefined for non-POST or non-chat paths", async () => {
  const config = configWith();
  assert.equal(
    await prepareContextCompressionRequest({ body: requestBody(bigMessages()), config, method: "GET", path: PATH }),
    undefined
  );
  assert.equal(
    await prepareContextCompressionRequest({ body: requestBody(bigMessages()), config, method: "POST", path: "/v1/models" }),
    undefined
  );
});

test("returns undefined when the body has no messages", async () => {
  const result = await prepareContextCompressionRequest({
    body: Buffer.from(JSON.stringify({ model: "claude-sonnet-4" })),
    config: configWith(),
    method: "POST",
    path: PATH
  });
  assert.equal(result, undefined);
});

test("returns undefined when below the minTokens gate without calling Headroom", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not be called");
  };
  try {
    const result = await prepareContextCompressionRequest({
      body: requestBody([{ role: "user", content: "oi" }]),
      config: configWith({ minTokens: 100000 }),
      method: "POST",
      path: PATH
    });
    assert.equal(result, undefined);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails open when Headroom is unreachable", async () => {
  const result = await prepareContextCompressionRequest({
    body: requestBody(bigMessages()),
    config: configWith({ baseUrl: "http://127.0.0.1:59999", timeoutMs: 2000 }),
    method: "POST",
    path: PATH
  });
  assert.equal(result, undefined);
});

test("replaces messages when Headroom compresses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/v1/compress"));
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, "claude-routed");
    return new Response(
      JSON.stringify({
        compression_ratio: 0.5,
        messages: [{ role: "user", content: "compressed" }],
        tokens_after: 50,
        tokens_before: 100,
        tokens_saved: 50
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const result = await prepareContextCompressionRequest({
      body: requestBody(bigMessages()),
      config: configWith({ minTokens: 1 }),
      method: "POST",
      path: PATH,
      routedModel: "claude-routed"
    });
    assert.ok(result);
    assert.equal(result.tokensSaved, 50);
    const body = JSON.parse(result.body.toString());
    assert.deepEqual(body.messages, [{ role: "user", content: "compressed" }]);
    assert.equal(body.model, "claude-sonnet-4");
    assert.match(result.diagnostic, /saved=50/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips Claude Code user agent without calling Headroom", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not be called");
  };
  try {
    const config = configWith({ minTokens: 1 });
    for (const userAgent of ["claude-cli/2.4.0 (external, cli)", "claude-vscode/1.2.3"]) {
      const result = await prepareContextCompressionRequest({
        body: requestBody(bigMessages()),
        config,
        headers: { "user-agent": userAgent },
        method: "POST",
        path: PATH
      });
      assert.equal(result, undefined);
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("compresses requests without a Claude user agent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        compression_ratio: 0.5,
        messages: [{ role: "user", content: "compressed" }],
        tokens_saved: 50
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  try {
    const result = await prepareContextCompressionRequest({
      body: requestBody(bigMessages()),
      config: configWith({ minTokens: 1 }),
      headers: { "user-agent": "opencode/1.0.0" },
      method: "POST",
      path: PATH
    });
    assert.ok(result);
    const body = JSON.parse(result.body.toString());
    assert.deepEqual(body.messages, [{ role: "user", content: "compressed" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips providers listed in excludeProviders without calling Headroom", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not be called");
  };
  try {
    const config = {
      Providers: [
        { name: "Verboo", api_base_url: "https://verboo.example/v1", api_key: "x", models: ["qwen3.8-27b"] },
        { name: "Hetzner", api_base_url: "https://hetzner.example/v1", api_key: "x", models: ["Qwen3.8-27B"] }
      ],
      plugins: [{
        id: "context-compression",
        enabled: true,
        config: { excludeProviders: ["verboo"], minTokens: 1 }
      }]
    };
    const result = await prepareContextCompressionRequest({
      body: requestBody(bigMessages()),
      config,
      method: "POST",
      path: PATH,
      routedModel: "Verboo/qwen3.8-27b"
    });
    assert.equal(result, undefined);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("compresses providers that are not excluded", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        compression_ratio: 0.5,
        messages: [{ role: "user", content: "compressed" }],
        tokens_saved: 50
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  try {
    const config = {
      Providers: [
        { name: "Verboo", api_base_url: "https://verboo.example/v1", api_key: "x", models: ["qwen3.8-27b"] },
        { name: "Hetzner", api_base_url: "https://hetzner.example/v1", api_key: "x", models: ["other-model"] }
      ],
      plugins: [{
        id: "context-compression",
        enabled: true,
        config: { excludeProviders: ["verboo"], minTokens: 1 }
      }]
    };
    const result = await prepareContextCompressionRequest({
      body: requestBody(bigMessages()),
      config,
      method: "POST",
      path: PATH,
      routedModel: "Hetzner/other-model"
    });
    assert.ok(result);
    assert.equal(result.tokensSaved, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns undefined on a no-op (skipped) Headroom response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ compression_ratio: 1, compression_skipped: true, messages: bigMessages(1), tokens_saved: 0 }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  try {
    const result = await prepareContextCompressionRequest({
      body: requestBody(bigMessages()),
      config: configWith({ minTokens: 1 }),
      method: "POST",
      path: PATH
    });
    assert.equal(result, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
