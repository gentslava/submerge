import { describe, expect, it } from "vitest";
import { type DomainFilterPolicy, deriveDomainCandidate, serializeDomainRule } from "./model.js";

const emptyPolicy: DomainFilterPolicy = {
  excludedTlds: [],
  neverAddDomains: [],
  neverAddSuffixes: [],
  nonWidenableSuffixes: [],
  telemetryPatterns: [],
};

describe("deriveDomainCandidate", () => {
  it("derives a registrable site without crossing an ICANN suffix", () => {
    expect(deriveDomainCandidate("www.api.service.co.uk", emptyPolicy, "site")).toMatchObject({
      fqdn: "www.api.service.co.uk",
      registrableSite: "service.co.uk",
      publicSuffix: "co.uk",
      excluded: false,
      eligibleScopes: ["exact", "site"],
      selectedScope: "site",
      proposedRule: "+.service.co.uk",
    });
  });

  it("uses the PSL private section instead of widening across tenants", () => {
    expect(deriveDomainCandidate("api.tenant.github.io", emptyPolicy, "site")).toMatchObject({
      registrableSite: "tenant.github.io",
      publicSuffix: "github.io",
      eligibleScopes: ["exact", "site"],
      proposedRule: "+.tenant.github.io",
    });
  });

  it("keeps a public or private suffix itself exact-only", () => {
    expect(deriveDomainCandidate("co.uk", emptyPolicy, "site")).toMatchObject({
      registrableSite: null,
      publicSuffix: "co.uk",
      excluded: false,
      eligibleScopes: ["exact"],
      selectedScope: "exact",
      proposedRule: "co.uk",
      siteUnavailableReason: "public-suffix",
    });
    expect(deriveDomainCandidate("github.io", emptyPolicy, "site")).toMatchObject({
      registrableSite: null,
      publicSuffix: "github.io",
      eligibleScopes: ["exact"],
      siteUnavailableReason: "public-suffix",
    });
  });

  it("normalizes IDNA before deriving and filtering", () => {
    expect(
      deriveDomainCandidate(
        "WWW.\u041F\u0440\u0438\u043C\u0435\u0440.\u0420\u0424.",
        { ...emptyPolicy, excludedTlds: ["\u0440\u0444"] },
        "site",
      ),
    ).toMatchObject({
      fqdn: "www.xn--e1afmkfd.xn--p1ai",
      registrableSite: "xn--e1afmkfd.xn--p1ai",
      excluded: true,
      exclusionReason: "excluded-tld",
      eligibleScopes: [],
      selectedScope: null,
      proposedRule: null,
    });
  });

  it.each([
    "api.example.ru",
    "api.example.su",
    "api.\u043F\u0440\u0438\u043C\u0435\u0440.\u0440\u0444",
  ])("excludes configured TLDs: %s", (fqdn) => {
    expect(
      deriveDomainCandidate(
        fqdn,
        { ...emptyPolicy, excludedTlds: ["ru", "su", "xn--p1ai"] },
        "exact",
      )?.exclusionReason,
    ).toBe("excluded-tld");
  });

  it("keeps exact-domain and suffix never-add policies distinct", () => {
    const policy: DomainFilterPolicy = {
      ...emptyPolicy,
      neverAddDomains: ["only.blocked.example"],
      neverAddSuffixes: ["blocked.example"],
    };

    expect(deriveDomainCandidate("only.blocked.example", policy, "site")?.exclusionReason).toBe(
      "never-add-domain",
    );
    expect(deriveDomainCandidate("child.blocked.example", policy, "site")?.exclusionReason).toBe(
      "never-add-suffix",
    );
    expect(deriveDomainCandidate("only.blocked.example.net", policy, "site")?.excluded).toBe(false);
  });

  it("matches telemetry patterns by complete label, not substring", () => {
    const policy = { ...emptyPolicy, telemetryPatterns: ["telemetry", "track*"] };

    expect(
      deriveDomainCandidate("telemetry.product.example", policy, "exact")?.exclusionReason,
    ).toBe("telemetry-pattern");
    expect(deriveDomainCandidate("tracker.product.example", policy, "exact")?.exclusionReason).toBe(
      "telemetry-pattern",
    );
    expect(deriveDomainCandidate("nottelemetry.product.example", policy, "exact")?.excluded).toBe(
      false,
    );
  });

  it("matches dotted telemetry patterns at every complete-label offset", () => {
    const policy = {
      ...emptyPolicy,
      telemetryPatterns: ["telemetry.*", "*.analytics.*"],
    };

    expect(
      deriveDomainCandidate("telemetry.client.example", policy, "exact")?.exclusionReason,
    ).toBe("telemetry-pattern");
    expect(
      deriveDomainCandidate("api.analytics.client.example", policy, "exact")?.exclusionReason,
    ).toBe("telemetry-pattern");
    expect(deriveDomainCandidate("nottelemetry.client.example", policy, "exact")?.excluded).toBe(
      false,
    );
    expect(
      deriveDomainCandidate("api.notanalytics.client.example", policy, "exact")?.excluded,
    ).toBe(false);
  });

  it.each([
    ["URL-shaped suffix", { neverAddSuffixes: ["example.com/path"] }],
    ["percent-encoded domain", { neverAddDomains: ["%65xample.com"] }],
    ["host with a port", { nonWidenableSuffixes: ["vercel.app:443"] }],
    ["embedded control character", { nonWidenableSuffixes: ["vercel.\napp"] }],
    ["malformed telemetry pattern", { telemetryPatterns: ["telemetry/**"] }],
  ])("fails closed for an invalid policy entry: %s", (_description, override) => {
    const candidate = deriveDomainCandidate(
      "api.tenant.vercel.app",
      { ...emptyPolicy, ...override },
      "site",
    );

    expect(candidate).toMatchObject({
      excluded: true,
      exclusionReason: "invalid-policy",
      eligibleScopes: [],
      selectedScope: null,
      proposedRule: null,
    });
  });

  it("locks a shared-hosting candidate to exact scope without excluding it", () => {
    expect(
      deriveDomainCandidate(
        "api.tenant.vercel.app",
        { ...emptyPolicy, nonWidenableSuffixes: ["vercel.app"] },
        "site",
      ),
    ).toEqual({
      fqdn: "api.tenant.vercel.app",
      registrableSite: "tenant.vercel.app",
      publicSuffix: "vercel.app",
      excluded: false,
      exclusionReason: null,
      eligibleScopes: ["exact"],
      selectedScope: "exact",
      proposedRule: "api.tenant.vercel.app",
      siteUnavailableReason: "non-widenable-suffix",
    });
  });

  it("matches protected suffixes only on DNS label boundaries", () => {
    const policy = { ...emptyPolicy, nonWidenableSuffixes: ["vercel.app"] };

    expect(
      deriveDomainCandidate("tenant.vercel.app.evil.example", policy, "site")
        ?.siteUnavailableReason,
    ).toBeNull();
  });

  it("honors the preferred scope when both scopes are eligible", () => {
    expect(deriveDomainCandidate("api.service.example", emptyPolicy, "exact")).toMatchObject({
      selectedScope: "exact",
      proposedRule: "api.service.example",
    });
    expect(deriveDomainCandidate("api.service.example", emptyPolicy, "site")).toMatchObject({
      selectedScope: "site",
      proposedRule: "+.service.example",
    });
  });

  it("fails closed for an invalid observed hostname", () => {
    expect(deriveDomainCandidate("https://example.com/path", emptyPolicy, "site")).toBeNull();
  });
});

describe("serializeDomainRule", () => {
  it("serializes exact and site rules without a degenerate host suffix", () => {
    expect(
      serializeDomainRule(
        { fqdn: "www.service.example", registrableSite: "service.example" },
        "exact",
      ),
    ).toBe("www.service.example");
    expect(
      serializeDomainRule(
        { fqdn: "www.service.example", registrableSite: "service.example" },
        "site",
      ),
    ).toBe("+.service.example");
  });

  it("refuses site serialization without a registrable boundary", () => {
    expect(() =>
      serializeDomainRule({ fqdn: "co.uk", registrableSite: null }, "site"),
    ).toThrowError("site scope requires a registrable site");
  });

  it.each([
    "safe.example\nmalicious.example",
    "safe.example,malicious.example",
    "https://safe.example/path",
  ])("refuses unsafe exact-rule input: %s", (fqdn) => {
    expect(() => serializeDomainRule({ fqdn, registrableSite: null }, "exact")).toThrowError(
      "invalid rule hostname",
    );
  });

  it("refuses an unsafe or mismatched site boundary", () => {
    expect(() =>
      serializeDomainRule(
        { fqdn: "api.service.example", registrableSite: "service.example\nmalicious.example" },
        "site",
      ),
    ).toThrowError("invalid registrable site");
    expect(() =>
      serializeDomainRule(
        { fqdn: "api.service.example", registrableSite: "other.example" },
        "site",
      ),
    ).toThrowError("registrable site does not match hostname");
  });
});
