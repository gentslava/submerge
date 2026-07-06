import type { ChannelMatcher } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import { PRESET_DOMAINS, resolveMatcherDomains } from "./presets.js";

function matcher(overrides: Partial<ChannelMatcher>): ChannelMatcher {
  return { presets: [], domains: [], ...overrides };
}

describe("resolveMatcherDomains", () => {
  it("expands a known preset after the custom domains", () => {
    const result = resolveMatcherDomains(matcher({ presets: ["youtube"], domains: ["ex.com"] }));
    expect(result).toEqual(["ex.com", ...PRESET_DOMAINS.youtube]);
  });

  it("dedupes a custom domain that repeats a preset domain, keeping first position", () => {
    const result = resolveMatcherDomains(
      matcher({ presets: ["youtube"], domains: ["youtube.com"] }),
    );
    expect(result).toEqual(PRESET_DOMAINS.youtube);
    expect(result.filter((d) => d === "youtube.com")).toHaveLength(1);
  });

  it("ignores unknown preset ids without throwing", () => {
    const result = resolveMatcherDomains(matcher({ presets: ["not-a-real-preset"], domains: [] }));
    expect(result).toEqual([]);
  });

  it("returns an empty array for an empty matcher", () => {
    expect(resolveMatcherDomains(matcher({}))).toEqual([]);
  });

  it("unions multiple presets in CHANNEL_PRESETS order regardless of matcher order", () => {
    const result = resolveMatcherDomains(matcher({ presets: ["discord", "telegram"] }));
    expect(result).toEqual([...PRESET_DOMAINS.telegram, ...PRESET_DOMAINS.discord]);
  });

  it("expands a single-service preset added by a later category (ai, messengers, ...)", () => {
    expect(resolveMatcherDomains(matcher({ presets: ["openai"] }))).toEqual(PRESET_DOMAINS.openai);
    expect(resolveMatcherDomains(matcher({ presets: ["whatsapp"] }))).toEqual(
      PRESET_DOMAINS.whatsapp,
    );
    expect(resolveMatcherDomains(matcher({ presets: ["steam"] }))).toEqual(PRESET_DOMAINS.steam);
  });
});
