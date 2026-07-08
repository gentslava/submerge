import { describe, expect, it } from "vitest";
import { validRefs } from "./RuleProviderRows";

describe("validRefs", () => {
  it("keeps well-formed http(s) rows", () => {
    expect(
      validRefs([
        { url: "https://example.com/ads.yaml", behavior: "classical" },
        { url: "http://example.com/x.list", behavior: "domain" },
      ]),
    ).toEqual([
      { url: "https://example.com/ads.yaml", behavior: "classical" },
      { url: "http://example.com/x.list", behavior: "domain" },
    ]);
  });

  it("drops a row with an empty/invalid URL (not yet committable)", () => {
    expect(validRefs([{ url: "", behavior: "classical" }])).toEqual([]);
    expect(validRefs([{ url: "not-a-url", behavior: "domain" }])).toEqual([]);
  });

  it("drops an .mrs URL paired with classical behavior (mihomo forbids it)", () => {
    expect(validRefs([{ url: "https://example.com/x.mrs", behavior: "classical" }])).toEqual([]);
    expect(validRefs([{ url: "https://example.com/x.mrs", behavior: "domain" }])).toEqual([
      { url: "https://example.com/x.mrs", behavior: "domain" },
    ]);
  });

  it("dedupes identical (url, behavior) rows", () => {
    expect(
      validRefs([
        { url: "https://x/a.yaml", behavior: "classical" },
        { url: "https://x/a.yaml", behavior: "classical" },
        { url: "https://x/a.yaml", behavior: "domain" },
      ]),
    ).toEqual([
      { url: "https://x/a.yaml", behavior: "classical" },
      { url: "https://x/a.yaml", behavior: "domain" },
    ]);
  });
});
