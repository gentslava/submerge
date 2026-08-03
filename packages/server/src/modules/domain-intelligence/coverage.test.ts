import { DEFAULT_SPEED_POLICY, type Proxy as ProxyConfig } from "@submerge/shared";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { buildMultiConfig, type ChannelConfigInput } from "../nodes/multiConfig.js";
import {
  coverageModelFromActiveChannels,
  type DomainCoverageModel,
  evaluateDomainCoverage,
  MAX_PROVIDER_CONTENT_BYTES,
  MAX_PROVIDER_ENTRIES,
  MAX_PROVIDER_LINE_LENGTH,
} from "./coverage.js";

const emptyModel: DomainCoverageModel = {
  rules: [],
  providers: [],
  opaqueMatchers: [],
};

describe("evaluateDomainCoverage", () => {
  it("finds an exact rule in the active routing model", () => {
    expect(
      evaluateDomainCoverage("API.Service.Example.", {
        ...emptyModel,
        rules: [
          {
            kind: "exact",
            value: "api.service.example",
            sourceId: "channel:media",
          },
        ],
      }),
    ).toEqual({
      status: "covered",
      match: {
        kind: "exact",
        rule: "api.service.example",
        sourceKind: "inline",
        sourceId: "channel:media",
      },
      incompleteSourceIds: [],
    });
  });

  it("matches suffix rules only on DNS label boundaries", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      rules: [{ kind: "suffix", value: "service.example", sourceId: "channel:video" }],
    };

    expect(evaluateDomainCoverage("api.service.example", model).status).toBe("covered");
    expect(evaluateDomainCoverage("service.example", model).status).toBe("covered");
    expect(evaluateDomainCoverage("notservice.example", model).status).toBe("uncovered");
  });

  it("evaluates active DOMAIN-KEYWORD rules case-insensitively", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      rules: [{ kind: "keyword", value: "Product-CDN", sourceId: "channel:assets" }],
    };

    expect(evaluateDomainCoverage("img.product-cdn.example", model)).toMatchObject({
      status: "covered",
      match: { kind: "keyword", rule: "product-cdn", sourceId: "channel:assets" },
    });
    expect(evaluateDomainCoverage("product.example", model).status).toBe("uncovered");
  });

  it("treats a bare domain-provider entry as exact custom coverage", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:custom",
          sourceKind: "custom",
          behavior: "domain",
          format: "text",
          content: "# managed rules\napi.service.example\n",
        },
      ],
    };

    expect(evaluateDomainCoverage("api.service.example", model)).toMatchObject({
      status: "covered",
      match: {
        kind: "exact",
        rule: "api.service.example",
        sourceKind: "custom",
        sourceId: "provider:custom",
      },
    });
    expect(evaluateDomainCoverage("child.api.service.example", model).status).toBe("uncovered");
  });

  it("treats +. entries as suffix coverage without excluding notblocked", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:notblocked",
          sourceKind: "notblocked",
          behavior: "domain",
          format: "text",
          content: "+.service.example\n",
        },
      ],
    };

    expect(evaluateDomainCoverage("service.example", model)).toMatchObject({
      status: "covered",
      match: { kind: "suffix", sourceKind: "notblocked" },
    });
    expect(evaluateDomainCoverage("api.service.example", model).status).toBe("covered");
    expect(evaluateDomainCoverage("notservice.example", model).status).toBe("uncovered");
  });

  it("reads a YAML domain provider payload", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:domains",
          sourceKind: "third-party",
          behavior: "domain",
          format: "yaml",
          content: "payload:\n  - exact.service.example\n  - '+.wide.service.example'\n",
        },
      ],
    };

    expect(evaluateDomainCoverage("exact.service.example", model).status).toBe("covered");
    expect(evaluateDomainCoverage("cdn.wide.service.example", model)).toMatchObject({
      status: "covered",
      match: { kind: "suffix", sourceKind: "third-party" },
    });
  });

  it.each([
    ["DOMAIN,api.service.example", "api.service.example", "exact"],
    ["DOMAIN-SUFFIX,service.example", "api.service.example", "suffix"],
    ["DOMAIN-KEYWORD,service-cdn", "img.service-cdn.example", "keyword"],
  ] as const)("evaluates classical rule %s", (entry, fqdn, kind) => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:classical",
          sourceKind: "third-party",
          behavior: "classical",
          format: "text",
          content: `${entry}\n`,
        },
      ],
    };

    expect(evaluateDomainCoverage(fqdn, model)).toMatchObject({
      status: "covered",
      match: { kind, sourceId: "provider:classical" },
    });
  });

  it.each([
    ["missing materialization", "text", null],
    ["binary mrs", "mrs", "binary-not-readable"],
    ["unknown format", "unknown", "api.service.example"],
    ["malformed yaml", "yaml", "payload: [unterminated"],
    ["invalid domain entry", "text", "not a domain\n"],
  ] as const)("blocks a recommendation for %s", (_name, format, content) => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:unknown",
          sourceKind: "third-party",
          behavior: "domain",
          format,
          content,
        },
      ],
    };

    expect(evaluateDomainCoverage("api.service.example", model)).toEqual({
      status: "incomplete",
      match: null,
      incompleteSourceIds: ["provider:unknown"],
    });
  });

  it("blocks on opaque active domain matchers and invalid inline rules", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      rules: [{ kind: "suffix", value: "bad domain", sourceId: "channel:broken" }],
      opaqueMatchers: [{ kind: "geosite", value: "youtube", sourceId: "channel:geo" }],
    };

    expect(evaluateDomainCoverage("api.service.example", model)).toEqual({
      status: "incomplete",
      match: null,
      incompleteSourceIds: ["channel:broken", "channel:geo"],
    });
  });

  it("returns definite coverage even when another active source is opaque", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      rules: [{ kind: "suffix", value: "service.example", sourceId: "channel:known" }],
      opaqueMatchers: [{ kind: "geosite", value: "private", sourceId: "channel:geo" }],
    };

    expect(evaluateDomainCoverage("api.service.example", model)).toMatchObject({
      status: "covered",
      match: { sourceId: "channel:known" },
      incompleteSourceIds: [],
    });
  });

  it("ignores IP-only providers for hostname coverage", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:ip",
          sourceKind: "third-party",
          behavior: "ipcidr",
          format: "mrs",
          content: null,
        },
      ],
    };

    expect(evaluateDomainCoverage("api.service.example", model).status).toBe("uncovered");
  });

  it.each(["DOMAIN,", "DOMAIN-REGEX,^api\\.service\\.example$", "GEOSITE,private", "not-a-rule"])(
    "marks an unsupported or malformed classical entry incomplete: %s",
    (entry) => {
      const model: DomainCoverageModel = {
        ...emptyModel,
        providers: [
          {
            sourceId: "provider:classical",
            sourceKind: "third-party",
            behavior: "classical",
            format: "text",
            content: `${entry}\n`,
          },
        ],
      };

      expect(evaluateDomainCoverage("api.service.example", model)).toEqual({
        status: "incomplete",
        match: null,
        incompleteSourceIds: ["provider:classical"],
      });
    },
  );

  it("safely ignores recognized non-domain classical rules", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:ip",
          sourceKind: "third-party",
          behavior: "classical",
          format: "text",
          content: "IP-CIDR,203.0.113.0/24,no-resolve\nDST-PORT,443\n",
        },
      ],
    };

    expect(evaluateDomainCoverage("api.service.example", model).status).toBe("uncovered");
  });

  it.each(["not-a-rule\nDOMAIN,api.service.example\n", "DOMAIN,api.service.example\nnot-a-rule\n"])(
    "validates a complete provider before trusting a matching entry",
    (content) => {
      const model: DomainCoverageModel = {
        ...emptyModel,
        providers: [
          {
            sourceId: "provider:mixed",
            sourceKind: "third-party",
            behavior: "classical",
            format: "text",
            content,
          },
        ],
      };

      expect(evaluateDomainCoverage("api.service.example", model)).toEqual({
        status: "incomplete",
        match: null,
        incompleteSourceIds: ["provider:mixed"],
      });
    },
  );

  it("rejects a YAML root sequence instead of treating it as a provider payload", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:yaml-sequence",
          sourceKind: "third-party",
          behavior: "domain",
          format: "yaml",
          content: "- api.service.example\n",
        },
      ],
    };

    expect(evaluateDomainCoverage("api.service.example", model).status).toBe("incomplete");
  });

  it.each([
    "IP-CIDR6,2620:0:2d0:200::7/32",
    "IP-ASN,13335",
    "IP-SUFFIX,8.8.8.8/24",
    "SRC-GEOIP,CN",
    "SRC-IP-ASN,9808",
    "SRC-IP-SUFFIX,192.168.1.201/8",
  ])("recognizes and validates current IP-only classical rule %s", (entry) => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:ip-classical",
          sourceKind: "third-party",
          behavior: "classical",
          format: "text",
          content: `${entry}\n`,
        },
      ],
    };

    expect(evaluateDomainCoverage("api.service.example", model).status).toBe("uncovered");
  });

  it.each(["IP-CIDR,garbage", "IP-ASN,not-a-number", "DST-PORT,70000"])(
    "rejects malformed IP-only classical rule %s",
    (entry) => {
      const model: DomainCoverageModel = {
        ...emptyModel,
        providers: [
          {
            sourceId: "provider:bad-ip",
            sourceKind: "third-party",
            behavior: "classical",
            format: "text",
            content: `${entry}\n`,
          },
        ],
      };

      expect(evaluateDomainCoverage("api.service.example", model).status).toBe("incomplete");
    },
  );

  it.each([
    ["bytes", "x".repeat(MAX_PROVIDER_CONTENT_BYTES + 1)],
    ["line length", `${"x".repeat(MAX_PROVIDER_LINE_LENGTH + 1)}\n`],
    ["entry count", ".example\n".repeat(MAX_PROVIDER_ENTRIES + 1)],
  ])("bounds provider materialization by %s", (_name, content) => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:oversized",
          sourceKind: "third-party",
          behavior: "domain",
          format: "text",
          content,
        },
      ],
    };

    expect(evaluateDomainCoverage("api.service.example", model).status).toBe("incomplete");
  });

  it("rejects nested or aliased YAML instead of expanding it", () => {
    const model: DomainCoverageModel = {
      ...emptyModel,
      providers: [
        {
          sourceId: "provider:nested",
          sourceKind: "third-party",
          behavior: "domain",
          format: "yaml",
          content: "payload: &rules\n  - api.service.example\ncopy: *rules\n",
        },
      ],
    };

    expect(evaluateDomainCoverage("api.service.example", model).status).toBe("incomplete");
  });
});

describe("coverageModelFromActiveChannels", () => {
  it("mirrors emitted domain matchers and provider identities without parsing config YAML", () => {
    const proxy: ProxyConfig = {
      name: "A",
      type: "vless",
      server: "node.example",
      port: 443,
      uuid: "u",
    };
    const channels: ChannelConfigInput[] = [
      {
        target: "proxy",
        id: "default",
        groupName: "AUTO",
        isDefault: true,
        policy: DEFAULT_SPEED_POLICY,
        domains: [],
        cidrs: [],
        proxies: [proxy],
      },
      {
        target: "direct",
        id: "direct",
        isDefault: false,
        domains: ["service.example"],
        keywords: ["assets"],
        ruleProviders: [{ url: "https://rules.example/notblocked.txt", behavior: "domain" }],
        geosite: ["private"],
        geoip: [],
        cidrs: [],
        directPresets: { privateNetworks: false, localDomains: false },
      },
    ];

    const model = coverageModelFromActiveChannels(channels, new Map());
    const generated = yaml.load(buildMultiConfig(channels)) as {
      "rule-providers": Record<string, unknown>;
    };
    const generatedProviderId = Object.keys(generated["rule-providers"])[0];

    expect(model).toMatchObject({
      rules: [
        { kind: "keyword", value: "assets", sourceId: "channel:direct" },
        { kind: "suffix", value: "service.example", sourceId: "channel:direct" },
      ],
      providers: [
        {
          sourceId: generatedProviderId,
          sourceKind: "third-party",
          behavior: "domain",
          format: "text",
          content: null,
        },
      ],
      opaqueMatchers: [{ kind: "geosite", value: "private", sourceId: "channel:direct" }],
    });
  });

  it("returns an empty coverage model when Mihomo has no exit node and emits no rules", () => {
    const channels: ChannelConfigInput[] = [
      {
        target: "proxy",
        id: "default",
        groupName: "AUTO",
        isDefault: true,
        policy: DEFAULT_SPEED_POLICY,
        domains: [],
        cidrs: [],
        proxies: [],
      },
      {
        target: "direct",
        id: "direct",
        isDefault: false,
        domains: ["ignored.example"],
        cidrs: [],
        directPresets: { privateNetworks: false, localDomains: false },
      },
    ];

    expect(coverageModelFromActiveChannels(channels, new Map())).toEqual(emptyModel);
  });

  it("uses explicit managed-provider identity instead of guessing from the URL", () => {
    const proxy: ProxyConfig = {
      name: "A",
      type: "vless",
      server: "node.example",
      port: 443,
      uuid: "u",
    };
    const channels: ChannelConfigInput[] = [
      {
        target: "proxy",
        id: "default",
        groupName: "AUTO",
        isDefault: true,
        policy: DEFAULT_SPEED_POLICY,
        domains: [],
        cidrs: [],
        proxies: [proxy],
      },
      {
        target: "direct",
        id: "direct",
        isDefault: false,
        domains: [],
        ruleProviders: [{ url: "https://rules.example/opaque-name.txt", behavior: "domain" }],
        cidrs: [],
        directPresets: { privateNetworks: false, localDomains: false },
      },
    ];
    const initial = coverageModelFromActiveChannels(channels, new Map());
    const providerId = initial.providers[0]?.sourceId ?? "missing";
    const managed = coverageModelFromActiveChannels(
      channels,
      new Map([
        [providerId, { content: "api.service.example\n", sourceKind: "notblocked" as const }],
      ]),
    );

    expect(evaluateDomainCoverage("api.service.example", managed)).toMatchObject({
      status: "covered",
      match: { sourceId: providerId, sourceKind: "notblocked" },
    });
  });
});
