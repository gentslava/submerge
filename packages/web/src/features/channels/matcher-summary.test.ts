import { describe, expect, it } from "vitest";
import { fitMatcherItems, matcherSummaryItems } from "./matcher-summary";

describe("matcherSummaryItems", () => {
  it("summarizes every matcher family", () => {
    expect(
      matcherSummaryItems({
        presets: ["openai"],
        domains: ["example.com"],
        keywords: ["ads"],
        ruleProviders: [{ url: "https://rules.example.com/list.yaml", behavior: "classical" }],
        geosite: ["category-ai"],
        geoip: ["US"],
      }).map(({ value }) => value),
    ).toEqual([
      "OpenAI",
      "example.com",
      "ключ:ads",
      "список:rules.example.com",
      "geosite:category-ai",
      "geoip:US",
    ]);
  });

  it("keeps an unknown stored preset visible instead of claiming there are no rules", () => {
    expect(
      matcherSummaryItems({
        presets: ["retired-preset"],
        domains: [],
        keywords: [],
        ruleProviders: [],
        geosite: [],
        geoip: [],
      }),
    ).toEqual([
      {
        key: "preset-retired-preset-0",
        value: "preset:retired-preset",
        monospace: true,
      },
    ]);
  });

  it("formats a legacy invalid rule-provider URL without throwing", () => {
    const items = matcherSummaryItems({
      presets: [],
      domains: [],
      keywords: [],
      ruleProviders: [{ url: "http://", behavior: "domain" }],
      geosite: [],
      geoip: [],
    });

    expect(items[0]?.value).toBe("список:http://");
  });
});

describe("fitMatcherItems", () => {
  it("keeps a complete counter when selecting chips for the available width", () => {
    expect(
      fitMatcherItems({
        availableWidth: 180,
        itemWidths: [64, 68, 70],
        counterWidths: [0, 32, 32, 32],
        gap: 8,
      }),
    ).toBe(2);
  });

  it("falls back to a count when even one item cannot fit", () => {
    expect(
      fitMatcherItems({
        availableWidth: 50,
        itemWidths: [64, 68],
        counterWidths: [0, 32, 32],
        gap: 8,
      }),
    ).toBe(0);
  });
});
