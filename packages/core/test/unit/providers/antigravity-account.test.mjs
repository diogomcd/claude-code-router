import assert from "node:assert/strict";
import test from "node:test";
import {
  antigravityLanguageServerQuotaEndpoint,
  antigravityLanguageServerRuntimeForTest,
  fetchAntigravityQuotaSummary,
  requestAntigravityQuotaSummaryForTest
} from "@ccr/core/providers/antigravity-account.ts";

const languageServerLog = `
Starting language server process with pid 1200
Language server listening on random port at 41001 for HTTPS (gRPC)
Language server listening on random port at 41002 for HTTP
`;

const languageServerCommand = [
  "/opt/Antigravity/resources/bin/language_server",
  "--standalone",
  "--csrf_token",
  "local-csrf-token"
].join("\0");

test("Antigravity language server discovery reads the HTTP port and CSRF token", () => {
  const expected = {
    csrfToken: "local-csrf-token",
    httpPort: 41002,
    pid: 1200
  };
  assert.deepEqual(antigravityLanguageServerRuntimeForTest(languageServerLog, languageServerCommand), expected);
  assert.deepEqual(
    antigravityLanguageServerRuntimeForTest(
      languageServerLog,
      '"C:\\Program Files\\Antigravity\\language_server.exe" --csrf_token "local-csrf-token"'
    ),
    expected
  );
});

test("Antigravity language server discovery rejects incomplete and unrelated processes", () => {
  assert.equal(antigravityLanguageServerRuntimeForTest("no server", languageServerCommand), undefined);
  assert.equal(
    antigravityLanguageServerRuntimeForTest(languageServerLog, "/usr/bin/other\0--csrf_token\0token"),
    undefined
  );
  assert.equal(
    antigravityLanguageServerRuntimeForTest(
      languageServerLog,
      "/opt/Antigravity/resources/bin/language_server\0--standalone"
    ),
    undefined
  );
});

test("Antigravity quota request calls the local RPC with CSRF authentication", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ init, url: String(input) });
    return new Response(JSON.stringify({ response: { groups: [] } }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  try {
    const payload = await requestAntigravityQuotaSummaryForTest({
      csrfToken: "request-csrf-token",
      httpPort: 42002,
      pid: 1300
    });
    assert.deepEqual(payload, { response: { groups: [] } });
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:42002/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
    );
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, "{}");
    assert.equal(calls[0].init?.headers["x-codeium-csrf-token"], "request-csrf-token");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Antigravity quota request reports local HTTP failures", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("forbidden", { status: 403 });
  try {
    await assert.rejects(
      () => requestAntigravityQuotaSummaryForTest({ csrfToken: "token", httpPort: 42002, pid: 1300 }),
      /language server quota request returned HTTP 403/
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Antigravity quota request adds context to connection failures", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(
      () => requestAntigravityQuotaSummaryForTest({ csrfToken: "token", httpPort: 42002, pid: 1300 }),
      /language server quota request failed: fetch failed/
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Antigravity quota discovery reports when the application is not running", async () => {
  const previousLog = process.env.CCR_ANTIGRAVITY_LANGUAGE_SERVER_LOG;
  process.env.CCR_ANTIGRAVITY_LANGUAGE_SERVER_LOG = "/missing/antigravity/language_server.log";
  try {
    await assert.rejects(() => fetchAntigravityQuotaSummary(), /Antigravity is not running/);
  } finally {
    if (previousLog === undefined) {
      delete process.env.CCR_ANTIGRAVITY_LANGUAGE_SERVER_LOG;
    } else {
      process.env.CCR_ANTIGRAVITY_LANGUAGE_SERVER_LOG = previousLog;
    }
  }
});

test("Antigravity local quota connector uses a stable semantic endpoint", () => {
  assert.equal(
    antigravityLanguageServerQuotaEndpoint,
    "http://127.0.0.1/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
  );
});
