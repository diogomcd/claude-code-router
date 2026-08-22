import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { antigravityOauthProjectPatch, AntigravityProjectField, draftHasAntigravityOauthPlugin, readAntigravityOauthProject } from "@ccr/ui/pages/home/components/providers.tsx";
import { createProviderDraft } from "@ccr/ui/pages/home/shared/index.tsx";

const antigravityPlugin = {
  auth: { headers: { authorization: "Bearer token" } },
  antigravityOauth: { project: "my-project" },
  key: "ccr-local-agent-__CCR_PROVIDER_NAME_SLUG__-antigravity-oauth"
};

test("AntigravityProjectField renders when the draft carries an antigravity oauth plugin", () => {
  const draft = {
    ...createProviderDraft([]),
    providerPlugins: [antigravityPlugin]
  };
  const html = renderToStaticMarkup(
    React.createElement(AntigravityProjectField, {
      customEndpoint: true,
      draft,
      onChange: () => undefined
    })
  );

  assert.match(html, /Antigravity project/);
  assert.match(html, /value="my-project"/);
});

test("AntigravityProjectField is absent without an antigravity plugin or endpoint", () => {
  const draft = createProviderDraft([]);
  const html = renderToStaticMarkup(
    React.createElement(AntigravityProjectField, {
      customEndpoint: true,
      draft,
      onChange: () => undefined
    })
  );

  assert.equal(html, "");
});

test("typing a project persists antigravityOauth.project on the saved plugins", () => {
  let saved: unknown[] = [];
  const draft = {
    ...createProviderDraft([]),
    providerPlugins: [antigravityPlugin]
  };
  const element = React.createElement(AntigravityProjectField, {
    customEndpoint: true,
    draft,
    onChange: (patch) => {
      if (patch.providerPlugins) {
        saved = patch.providerPlugins;
      }
    }
  });

  renderToStaticMarkup(element);
  const patched = antigravityOauthProjectPatch(draft.providerPlugins, "edited-project");

  assert.equal(readAntigravityOauthProject(patched), "edited-project");
  assert.deepEqual(saved, []);
});

test("project patch preserves unrelated plugin fields and plugins", () => {
  const otherPlugin = { key: "ccr-local-agent-other-suffix", request: { strict: true } };
  const patched = antigravityOauthProjectPatch([antigravityPlugin, otherPlugin], "next-project");

  assert.equal(patched.length, 2);
  assert.equal(readAntigravityOauthProject(patched), "next-project");
  const first = patched[0] as Record<string, unknown>;
  const auth = first.auth as Record<string, unknown>;
  assert.deepEqual(auth.headers, { authorization: "Bearer token" });
  assert.deepEqual(patched[1], otherPlugin);
});

test("draft without antigravity plugins reports absence for the field gate", () => {
  assert.equal(draftHasAntigravityOauthPlugin(createProviderDraft([]).providerPlugins), false);
  assert.equal(draftHasAntigravityOauthPlugin([antigravityPlugin]), true);
});
