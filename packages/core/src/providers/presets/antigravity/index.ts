import { defaultProviderAccountConfig, type ProviderPreset } from "@ccr/core/providers/presets/types";

export const antigravityProviderPreset: ProviderPreset = {
  account: defaultProviderAccountConfig,
  aliases: ["antigravity", "google antigravity", "cloudcode"],
  defaultModels: ["gemini-3.1-pro-low", "gemini-3.6-flash-high", "claude-sonnet-4-6"],
  endpoints: [
    {
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      protocols: ["gemini_generate_content"]
    }
  ],
  id: "antigravity",
  name: "Antigravity",
  websiteUrl: "https://antigravity.google/"
};
