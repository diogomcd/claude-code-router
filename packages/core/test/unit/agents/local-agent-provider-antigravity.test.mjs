import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  antigravityAccessTokenExpired,
  antigravityCandidate,
  antigravityCredentialFile,
  antigravityDefaultBaseUrl,
  antigravityIdentityHeaders,
  fetchAntigravityModels,
  importAntigravityProvider,
  loadAntigravityProject,
  normalizeAntigravityProviderAccountConfig,
  readAntigravityAuth,
  resolveAntigravityAuth
} from "@ccr/core/agents/local-providers/antigravity.ts";
import {
  getLocalAgentProviderCandidates,
  importLocalAgentProvider
} from "@ccr/core/agents/local-providers/service.ts";
import { localAgentProviderApiKey } from "@ccr/core/agents/local-providers/shared.ts";
import { antigravityLanguageServerQuotaEndpoint } from "@ccr/core/providers/antigravity-account.ts";

const futureExpiryMs = 4_102_444_800_000;
const pastExpiryMs = 1_000_000_000_000;

async function withAntigravityHome(run) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ccr-antigravity-"));
  const previousHome = process.env.CCR_INTERNAL_HOME_DIR;
  const previousFile = process.env.CCR_ANTIGRAVITY_OAUTH_FILE;
  const previousPath = process.env.PATH;
  // Remove secret-tool do PATH para os testes não lerem o keyring da máquina real.
  const isolatedPath = (previousPath ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && !existsSync(path.join(entry, "secret-tool")))
    .join(path.delimiter);
  process.env.CCR_INTERNAL_HOME_DIR = home;
  delete process.env.CCR_ANTIGRAVITY_OAUTH_FILE;
  if (isolatedPath) {
    process.env.PATH = isolatedPath;
  }
  mkdirSync(path.join(home, ".gemini"), { recursive: true });
  try {
    await run(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousHome;
    }
    if (previousFile === undefined) {
      delete process.env.CCR_ANTIGRAVITY_OAUTH_FILE;
    } else {
      process.env.CCR_ANTIGRAVITY_OAUTH_FILE = previousFile;
    }
    if (previousPath !== undefined) {
      process.env.PATH = previousPath;
    }
    rmSync(home, { force: true, recursive: true });
  }
}

function writeCredentials(home, record) {
  const file = path.join(home, ".gemini", "oauth_creds.json");
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

async function withStubbedFetch(handler, run) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ init, url: String(input) });
    return handler(calls.length, { init, url: String(input) });
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("Antigravity credentials read epoch milliseconds and normalize epoch seconds", async () => {
  await withAntigravityHome(async (home) => {
    const file = writeCredentials(home, {
      access_token: "antigravity-access-token",
      expiry_date: futureExpiryMs,
      id_token: "antigravity-id-token",
      refresh_token: "antigravity-refresh-token",
      scope: "https://www.googleapis.com/auth/cloud-platform"
    });

    const auth = readAntigravityAuth();
    assert.equal(auth?.accessToken, "antigravity-access-token");
    assert.equal(auth?.idToken, "antigravity-id-token");
    assert.equal(auth?.expiryDate, futureExpiryMs);
    assert.equal(auth?.sourceFile, file);

    writeCredentials(home, {
      access_token: "antigravity-access-token",
      expiry_date: Math.floor(futureExpiryMs / 1000)
    });
    assert.equal(readAntigravityAuth()?.expiryDate, futureExpiryMs);
  });
});

test("Antigravity access token expiry honours the refresh margin", () => {
  const sourceFile = "/tmp/ccr-antigravity-expiry.json";
  assert.equal(antigravityAccessTokenExpired({ accessToken: "token", expiryDate: futureExpiryMs, sourceFile }), false);
  assert.equal(antigravityAccessTokenExpired({ accessToken: "token", expiryDate: pastExpiryMs, sourceFile }), true);
  assert.equal(antigravityAccessTokenExpired({ accessToken: "token", sourceFile }), true);
  assert.equal(
    antigravityAccessTokenExpired({ accessToken: "token", expiryDate: Date.now() + 30_000, sourceFile }),
    true
  );
});

test("Antigravity resolve returns a live token without touching the network", async () => {
  await withAntigravityHome(async (home) => {
    writeCredentials(home, {
      access_token: "live-access-token",
      expiry_date: futureExpiryMs,
      refresh_token: "antigravity-refresh-token"
    });

    await withStubbedFetch(
      () => {
        throw new Error("network must not be used for a live token");
      },
      async (calls) => {
        const auth = await resolveAntigravityAuth();
        assert.equal(auth?.accessToken, "live-access-token");
        assert.equal(calls.length, 0);
      }
    );
  });
});

test("Antigravity resolve does not refresh or rewrite expired credentials", async () => {
  await withAntigravityHome(async (home) => {
    const file = writeCredentials(home, {
      access_token: "stale-access-token",
      expiry_date: pastExpiryMs,
      foo: "bar",
      refresh_token: "antigravity-refresh-token"
    });

    await withStubbedFetch(
      () => {
        throw new Error("Antigravity must not refresh credentials");
      },
      async (calls) => {
        assert.equal(await resolveAntigravityAuth(), undefined);
        assert.equal(calls.length, 0);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
          access_token: "stale-access-token",
          expiry_date: pastExpiryMs,
          foo: "bar",
          refresh_token: "antigravity-refresh-token"
        });
      }
    );
  });
});


test("Antigravity resolve reports missing and locked credentials without throwing", async () => {
  await withAntigravityHome(async (home) => {
    assert.equal(await resolveAntigravityAuth(), undefined);

    writeCredentials(home, { access_token: "", refresh_token: "antigravity-refresh-token" });
    assert.equal(readAntigravityAuth(), undefined);
    assert.equal(await resolveAntigravityAuth(), undefined);

    writeCredentials(home, { access_token: "locked-access-token", expiry_date: pastExpiryMs });
    assert.equal(await resolveAntigravityAuth(), undefined);
  });
});


test("Antigravity identity headers accept environment overrides", () => {
  const previousUserAgent = process.env.ANTIGRAVITY_IDE_USER_AGENT;
  const previousApiClient = process.env.ANTIGRAVITY_API_CLIENT_HEADER;
  try {
    delete process.env.ANTIGRAVITY_IDE_USER_AGENT;
    delete process.env.ANTIGRAVITY_API_CLIENT_HEADER;
    const headers = antigravityIdentityHeaders();
    assert.match(headers["user-agent"], /^antigravity\/hub\//);
    assert.match(headers["x-goog-api-client"], /^gl-node\//);

    process.env.ANTIGRAVITY_IDE_USER_AGENT = "custom-agent/9";
    process.env.ANTIGRAVITY_API_CLIENT_HEADER = "custom-client/9";
    const overridden = antigravityIdentityHeaders();
    assert.equal(overridden["user-agent"], "custom-agent/9");
    assert.equal(overridden["x-goog-api-client"], "custom-client/9");
  } finally {
    if (previousUserAgent === undefined) {
      delete process.env.ANTIGRAVITY_IDE_USER_AGENT;
    } else {
      process.env.ANTIGRAVITY_IDE_USER_AGENT = previousUserAgent;
    }
    if (previousApiClient === undefined) {
      delete process.env.ANTIGRAVITY_API_CLIENT_HEADER;
    } else {
      process.env.ANTIGRAVITY_API_CLIENT_HEADER = previousApiClient;
    }
  }
});

test("Antigravity project discovery reads the nested cloudaicompanion project and memoizes it", async () => {
  await withStubbedFetch(
    () => new Response(JSON.stringify({
      currentTier: { id: "free-tier" },
      metadata: { nested: { cloudaicompanionProject: "projects/ccr-antigravity" } }
    }), { headers: { "content-type": "application/json" }, status: 200 }),
    async (calls) => {
      const token = `memoized-token-${randomUUID()}`;
      assert.equal(await loadAntigravityProject(token), "projects/ccr-antigravity");
      assert.equal(await loadAntigravityProject(token), "projects/ccr-antigravity");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${antigravityDefaultBaseUrl}/v1internal:loadCodeAssist`);
      assert.equal(JSON.parse(calls[0].init?.body ?? "{}").metadata !== undefined, true);
    }
  );
});

test("Antigravity project discovery returns an empty project instead of throwing", async () => {
  await withStubbedFetch(
    () => new Response("nope", { status: 500 }),
    async () => {
      assert.equal(await loadAntigravityProject(`failing-token-${randomUUID()}`), "");
    }
  );
});

test("Antigravity model catalog parses the internal payload and tolerates failures", async () => {
  await withStubbedFetch(
    () => new Response(JSON.stringify({
      models: {
        "gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro Low" },
        "chat_20706": {}
      }
    }), { headers: { "content-type": "application/json" }, status: 200 }),
    async (calls) => {
      const models = await fetchAntigravityModels("catalog-token");
      assert.deepEqual(models, [
        { displayName: "Gemini 3.1 Pro Low", id: "gemini-3.1-pro-low" }
      ]);
      assert.equal(calls[0].url, `${antigravityDefaultBaseUrl}/v1internal:fetchAvailableModels`);
    }
  );

  await withStubbedFetch(
    () => new Response("boom", { status: 503 }),
    async () => {
      assert.deepEqual(await fetchAntigravityModels("catalog-token"), []);
    }
  );
});

test("Antigravity candidate reports available, locked and missing login states", async () => {
  await withAntigravityHome(async (home) => {
    assert.equal(antigravityCandidate().status, "missing");
    assert.equal(antigravityCandidate().importable, false);

    writeCredentials(home, { access_token: "live-token", expiry_date: futureExpiryMs });
    const available = antigravityCandidate();
    assert.equal(available.status, "available");
    assert.equal(available.importable, true);
    assert.equal(available.kind, "antigravity");
    assert.equal(available.protocol, "gemini_generate_content");

    writeCredentials(home, { access_token: "stale-token", expiry_date: pastExpiryMs, refresh_token: "rt" });
    const lockedWithRefreshToken = antigravityCandidate();
    assert.equal(lockedWithRefreshToken.status, "locked");
    assert.equal(lockedWithRefreshToken.importable, false);

    writeCredentials(home, { access_token: "stale-token", expiry_date: pastExpiryMs });
    const locked = antigravityCandidate();
    assert.equal(locked.status, "locked");
    assert.equal(locked.importable, false);
  });
});

test("Antigravity provider account normalization preserves explicit and custom settings", () => {
  const provider = {
    account: { refreshIntervalMs: 123_456 },
    apiKey: localAgentProviderApiKey,
    baseUrl: `${antigravityDefaultBaseUrl}/`,
    id: "antigravity",
    models: [],
    name: "Imported Google Antigravity",
    type: "gemini_generate_content"
  };
  const normalized = normalizeAntigravityProviderAccountConfig(provider);
  assert.equal(normalized.account?.enabled, true);
  assert.equal(normalized.account?.refreshIntervalMs, 123_456);
  assert.equal(normalized.account?.connectors?.[0]?.parser, "antigravity-quota");
  assert.equal(normalized.account?.connectors?.[0]?.endpoint, antigravityLanguageServerQuotaEndpoint);
  assert.equal(normalized.account?.connectors?.[0]?.auth, "none");

  const legacy = normalizeAntigravityProviderAccountConfig({
    ...provider,
    account: {
      connectors: [{
        auth: "provider-api-key",
        endpoint: `${antigravityDefaultBaseUrl}/v1internal:retrieveUserQuotaSummary`,
        mapping: { meters: [] },
        parser: "antigravity-quota",
        type: "http-json"
      }],
      enabled: true
    }
  });
  assert.equal(legacy.account?.connectors?.[0]?.endpoint, antigravityLanguageServerQuotaEndpoint);

  const disabled = normalizeAntigravityProviderAccountConfig({
    ...provider,
    account: { enabled: false }
  });
  assert.deepEqual(disabled.account, { enabled: false });

  const custom = normalizeAntigravityProviderAccountConfig({
    ...provider,
    account: {
      connectors: [{ endpoint: "https://quota.example.test", mapping: { meters: [] }, type: "http-json" }],
      enabled: true
    }
  });
  assert.equal(custom.account?.connectors?.[0]?.endpoint, "https://quota.example.test");
});

test("Antigravity import builds the gateway provider payload and both auth plugins", async () => {
  await withAntigravityHome(async (home) => {
    writeCredentials(home, { access_token: `import-token-${randomUUID()}`, expiry_date: futureExpiryMs });

    await withStubbedFetch(
      (_call, request) => {
        if (request.url.endsWith("loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "projects/ccr-antigravity" }), {
            headers: { "content-type": "application/json" },
            status: 200
          });
        }
        return new Response(JSON.stringify({ models: { "gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro Low" } } }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      },
      async () => {
        const result = await importAntigravityProvider(antigravityCandidate(), []);
        assert.equal(result.provider.name, "Antigravity");
        assert.equal(result.provider.baseUrl, antigravityDefaultBaseUrl);
        assert.equal(result.provider.protocol, "gemini_generate_content");
        assert.equal(result.provider.apiKey, localAgentProviderApiKey);
        assert.equal(result.provider.account?.enabled, true);
        assert.equal(result.provider.account?.connectors?.[0]?.parser, "antigravity-quota");
        assert.ok(result.provider.models.includes("gemini-3.1-pro-low"));
        assert.ok(result.provider.models.includes("claude-sonnet-4-6"));
        assert.equal(result.providerPlugins.length, 2);
        assert.ok(String(result.providerPlugins[0].key).endsWith("-antigravity-oauth"));
        assert.ok(String(result.providerPlugins[1].key).endsWith("-antigravity-oauth-internal"));
        assert.equal(result.providerPlugins[1].antigravityOauth.project, "projects/ccr-antigravity");
        assert.equal(result.providerPlugins[0].antigravityOauth.project, "projects/ccr-antigravity");
      }
    );
  });
});

test("Antigravity import is reachable through the local agent provider service", async () => {
  await withAntigravityHome(async (home) => {
    writeCredentials(home, { access_token: `service-token-${randomUUID()}`, expiry_date: futureExpiryMs });

    const candidate = getLocalAgentProviderCandidates().find((item) => item.kind === "antigravity");
    assert.ok(candidate);
    assert.equal(candidate.importable, true);

    await withStubbedFetch(
      () => new Response(JSON.stringify({ cloudaicompanionProject: "projects/ccr-antigravity", models: [] }), {
        headers: { "content-type": "application/json" },
        status: 200
      }),
      async () => {
        const result = await importLocalAgentProvider({ id: candidate.id, providerNames: [] });
        assert.equal(result.provider.baseUrl, antigravityDefaultBaseUrl);
        assert.equal(result.providerPlugins.length, 2);
      }
    );

    writeCredentials(home, { access_token: "stale-token", expiry_date: pastExpiryMs });
    const locked = getLocalAgentProviderCandidates().find((item) => item.kind === "antigravity");
    assert.equal(locked?.importable, false);
    await assert.rejects(() => importLocalAgentProvider({ id: locked.id, providerNames: [] }));
  });
});

test("Antigravity credential file honours the explicit environment override", async () => {
  await withAntigravityHome(async (home) => {
    const custom = path.join(home, "custom-creds.json");
    process.env.CCR_ANTIGRAVITY_OAUTH_FILE = custom;
    try {
      assert.equal(antigravityCredentialFile(), custom);
    } finally {
      delete process.env.CCR_ANTIGRAVITY_OAUTH_FILE;
    }
    assert.equal(antigravityCredentialFile(), path.join(home, ".gemini", "oauth_creds.json"));
  });
});
