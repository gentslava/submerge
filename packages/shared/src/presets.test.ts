import { describe, expect, it } from "vitest";
import { CHANNEL_PRESETS, PRESET_DOMAINS } from "./presets.js";

describe("PRESET_DOMAINS", () => {
  it("gives every registry preset at least one domain", () => {
    for (const preset of CHANNEL_PRESETS) {
      expect(
        PRESET_DOMAINS[preset.id].length,
        `preset "${preset.id}" has no domains`,
      ).toBeGreaterThan(0);
    }
  });

  it("has no domain list carrying a duplicate entry", () => {
    for (const [id, domains] of Object.entries(PRESET_DOMAINS)) {
      expect(new Set(domains).size, `preset "${id}" repeats a domain`).toBe(domains.length);
    }
  });
});
