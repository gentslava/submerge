import { describe, expect, it } from "vitest";
import { directMatcherSummaryItems, fitMatcherItems, matcherSummaryItems } from "./matcher-summary";

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
        cidrs: ["10.0.0.0/8", "2001:db8::/32"],
      }).map(({ value }) => value),
    ).toEqual([
      "OpenAI",
      "example.com",
      "ключ:ads",
      "список:rules.example.com",
      "geosite:category-ai",
      "geoip:US",
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
  });

  it("renders CIDRs as monospace summary items", () => {
    const items = matcherSummaryItems({
      presets: [],
      domains: [],
      keywords: [],
      ruleProviders: [],
      geosite: [],
      geoip: [],
      cidrs: ["10.0.0.0/8", "2001:db8::/32"],
    });

    expect(items).toEqual([
      { key: "cidr-10.0.0.0/8-0", value: "10.0.0.0/8", monospace: true },
      { key: "cidr-2001:db8::/32-1", value: "2001:db8::/32", monospace: true },
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
        cidrs: [],
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
      cidrs: [],
    });

    expect(items[0]?.value).toBe("список:http://");
  });
});

describe("directMatcherSummaryItems", () => {
  it("counts enabled system presets before custom matchers", () => {
    expect(
      directMatcherSummaryItems({
        directPresets: { privateNetworks: true, localDomains: false },
        matcher: {
          presets: [],
          domains: ["router.home.arpa"],
          keywords: [],
          ruleProviders: [],
          geosite: [],
          geoip: [],
          cidrs: ["192.168.50.0/24"],
        },
      }).map(({ value }) => value),
    ).toEqual(["Локальная сеть", "router.home.arpa", "192.168.50.0/24"]);
  });

  it("omits disabled system presets from the summary", () => {
    expect(
      directMatcherSummaryItems({
        directPresets: { privateNetworks: false, localDomains: false },
        matcher: {
          presets: [],
          domains: [],
          keywords: [],
          ruleProviders: [],
          geosite: [],
          geoip: [],
          cidrs: [],
        },
      }),
    ).toEqual([]);
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
