import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  antigravityAccessTokenExpired,
  antigravityCandidate,
  antigravityCredentialFile,
  antigravityDefaultBaseUrl,
  antigravityIdentityHeaders,
  antigravityOAuthTokenUrl,
  fetchAntigravityModels,
  importAntigravityProvider,
  loadAntigravityProject,
  persistAntigravityAuth,
  readAntigravityAuth,
  resolveAntigravityAuth
} from "@ccr/core/agents/local-providers/antigravity.ts";
import {
  getLocalAgentProviderCandidates,
  importLocalAgentProvider
} from "@ccr/core/agents/local-providers/service.ts";
import { localAgentProviderApiKey } from "@ccr/core/agents/local-providers/shared.ts";

const futureExpiryMs = 4_102_444_800_000;
const pastExpiryMs = 1_000_000_000_000;

async function withAntigravityHome(run) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ccr-antigravity-"));
  const previousHome = process.env.CCR_INTERNAL_HOME_DIR;
  const previousFile = process.env.CCR_ANTIGRAVITY_OAUTH_FILE;
  process.env.CCR_INTERNAL_HOME_DIR = home;
  delete process.env.CCR_ANTIGRAVITY_OAUTH_FILE;
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
    assert.equal(auth?.refreshToken, "antigravity-refresh-token");
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

test("Antigravity resolve refreshes an expired token and rewrites the credential file", async () => {
  await withAntigravityHome(async (home) => {
    const file = writeCredentials(home, {
      access_token: "stale-access-token",
      expiry_date: pastExpiryMs,
      foo: "bar",
      id_token: "antigravity-id-token",
      refresh_token: "antigravity-refresh-token",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      token_type: "Bearer"
    });

    await withStubbedFetch(
      () => new Response(JSON.stringify({ access_token: "fresh-access-token", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
        status: 200
      }),
      async (calls) => {
        const auth = await resolveAntigravityAuth();
        assert.equal(auth?.accessToken, "fresh-access-token");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, antigravityOAuthTokenUrl);
        assert.equal(calls[0].init?.method, "POST");
        assert.match(calls[0].init?.body ?? "", /grant_type=refresh_token/);
        assert.match(calls[0].init?.body ?? "", /884354919052-36trc1jjb3tguiac32ov6cod268c5blh/);
        assert.match(calls[0].init?.body ?? "", /REDACTED/);

        const persisted = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(persisted.access_token, "fresh-access-token");
        assert.equal(persisted.id_token, "antigravity-id-token");
        assert.equal(persisted.scope, "https://www.googleapis.com/auth/cloud-platform");
        assert.equal(persisted.token_type, "Bearer");
        assert.equal(persisted.foo, "bar");
        assert.ok(persisted.expiry_date > Date.now());
        assert.equal(statSync(file).mode & 0o777, 0o600);
      }
    );
  });
});

test("Antigravity concurrent resolves share a single refresh request", async () => {
  await withAntigravityHome(async (home) => {
    writeCredentials(home, {
      access_token: "stale-access-token",
      expiry_date: pastExpiryMs,
      refresh_token: "antigravity-refresh-token"
    });

    await withStubbedFetch(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify({ access_token: "fresh-access-token", expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      },
      async (calls) => {
        const [first, second] = await Promise.all([resolveAntigravityAuth(), resolveAntigravityAuth()]);
        assert.equal(first?.accessToken, "fresh-access-token");
        assert.equal(second?.accessToken, "fresh-access-token");
        assert.equal(calls.length, 1);
      }
    );
  });
});

test("Antigravity adopts a peer-rotated credential when the refresh is rejected", async () => {
  await withAntigravityHome(async (home) => {
    writeCredentials(home, {
      access_token: "stale-access-token",
      expiry_date: pastExpiryMs,
      refresh_token: "stale-refresh-token"
    });

    await withStubbedFetch(
      () => {
        writeCredentials(home, {
          access_token: "peer-rotated-access-token",
          expiry_date: futureExpiryMs,
          refresh_token: "peer-rotated-refresh-token"
        });
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          headers: { "content-type": "application/json" },
          status: 400
        });
      },
      async (calls) => {
        const auth = await resolveAntigravityAuth();
        assert.equal(auth?.accessToken, "peer-rotated-access-token");
        assert.equal(auth?.refreshToken, "peer-rotated-refresh-token");
        assert.equal(calls.length, 1);
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
    const locked = await resolveAntigravityAuth();
    assert.equal(locked?.accessToken, "locked-access-token");
    assert.equal(antigravityAccessTokenExpired(locked), true);
  });
});

test("Antigravity persistence preserves unknown fields from the credential file", async () => {
  await withAntigravityHome(async (home) => {
    const file = writeCredentials(home, {
      access_token: "old-access-token",
      expiry_date: pastExpiryMs,
      foo: "bar",
      id_token: "antigravity-id-token",
      refresh_token: "antigravity-refresh-token",
      token_type: "Bearer"
    });

    persistAntigravityAuth({
      accessToken: "new-access-token",
      expiryDate: futureExpiryMs,
      refreshToken: "antigravity-refresh-token",
      sourceFile: file
    });

    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.access_token, "new-access-token");
    assert.equal(persisted.expiry_date, futureExpiryMs);
    assert.equal(persisted.foo, "bar");
    assert.equal(persisted.id_token, "antigravity-id-token");
    assert.equal(persisted.token_type, "Bearer");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test("Antigravity identity headers accept environment overrides", () => {
  const previousUserAgent = process.env.ANTIGRAVITY_IDE_USER_AGENT;
  const previousApiClient = process.env.ANTIGRAVITY_API_CLIENT_HEADER;
  try {
    delete process.env.ANTIGRAVITY_IDE_USER_AGENT;
    delete process.env.ANTIGRAVITY_API_CLIENT_HEADER;
    const headers = antigravityIdentityHeaders();
    assert.match(headers["user-agent"], /^antigravity-ide\//);
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
        "claude-sonnet-4-6": {}
      }
    }), { headers: { "content-type": "application/json" }, status: 200 }),
    async (calls) => {
      const models = await fetchAntigravityModels("catalog-token");
      assert.deepEqual(models.sort((a,b) => a.id.localeCompare(b.id)), [
        { id: "claude-sonnet-4-6" },
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
    assert.equal(antigravityCandidate().status, "available");

    writeCredentials(home, { access_token: "stale-token", expiry_date: pastExpiryMs });
    const locked = antigravityCandidate();
    assert.equal(locked.status, "locked");
    assert.equal(locked.importable, false);
  });
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
