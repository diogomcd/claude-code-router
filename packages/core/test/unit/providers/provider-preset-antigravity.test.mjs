import assert from "node:assert/strict";
import test from "node:test";
import {
  antigravityProviderPreset
} from "@ccr/core/providers/presets/antigravity/index.ts";
import {
  findProviderPresetByBaseUrl,
  providerPresets
} from "@ccr/core/providers/presets/index.ts";
import {
  normalizedProviderCapabilities
} from "@ccr/core/providers/runtime-topology.ts";

test("Antigravity preset exposes the Cloud Code Gemini endpoint", () => {
  assert.equal(providerPresets.find((preset) => preset.id === "antigravity"), antigravityProviderPreset);
  assert.equal(findProviderPresetByBaseUrl("https://daily-cloudcode-pa.googleapis.com")?.id, "antigravity");
  assert.deepEqual(antigravityProviderPreset.endpoints, [
    {
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      protocols: ["gemini_generate_content"]
    }
  ]);
});

test("Antigravity preset locks detected chat capabilities to Gemini Generate Content", () => {
  const provider = {
    api_base_url: "https://daily-cloudcode-pa.googleapis.com",
    capabilities: [
      {
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        source: "detected",
        type: "openai_chat_completions"
      },
      {
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        source: "detected",
        type: "gemini_generate_content"
      }
    ],
    name: "Antigravity"
  };

  assert.deepEqual(normalizedProviderCapabilities(provider), [
    {
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      source: "detected",
      type: "gemini_generate_content"
    }
  ]);
});

test("providers without an Antigravity preset base URL keep all detected capabilities", () => {
  const provider = {
    api_base_url: "https://proxy.example.com/v1",
    capabilities: [
      {
        baseUrl: "https://proxy.example.com/v1",
        source: "detected",
        type: "openai_chat_completions"
      },
      {
        baseUrl: "https://proxy.example.com/v1",
        source: "detected",
        type: "gemini_generate_content"
      }
    ],
    name: "Generic proxy"
  };

  assert.deepEqual(normalizedProviderCapabilities(provider), [
    {
      baseUrl: "https://proxy.example.com/v1",
      source: "detected",
      type: "openai_chat_completions"
    },
    {
      baseUrl: "https://proxy.example.com/v1",
      source: "detected",
      type: "gemini_generate_content"
    }
  ]);
});
