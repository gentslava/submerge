import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_SPEED_POLICY, type Proxy as ProxyConfig } from "@submerge/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChannelConfigInput,
  ruleProviderName,
  ruleProviderRelativePath,
} from "../nodes/multiConfig.js";
import {
  coverageModelFromActiveChannels,
  evaluateDomainCoverage,
  MAX_ACTIVE_PROVIDER_COUNT,
  MAX_PROVIDER_CONTENT_BYTES,
  materializeActiveRuleProviderSnapshot,
  materializeActiveRuleProviders,
} from "./coverage.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const reference = { url: "https://rules.example/active.txt", behavior: "domain" as const };
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
      cidrs: [],
      ruleProviders: [reference],
      directPresets: { privateNetworks: false, localDomains: false },
    },
  ];
  const root = mkdtempSync(join(tmpdir(), "submerge-provider-"));
  roots.push(root);
  const path = join(root, ruleProviderRelativePath(reference));
  mkdirSync(dirname(path), { recursive: true });
  return { channels, path, providerId: ruleProviderName(reference), root };
}

describe("active provider materialization", () => {
  it("reads only the bounded cache path emitted for the active provider", () => {
    const { channels, path, providerId, root } = fixture();
    writeFileSync(path, "api.service.example\n", "utf8");

    expect(materializeActiveRuleProviders(channels, root).get(providerId)).toEqual({
      content: "api.service.example\n",
      sourceKind: "third-party",
    });
  });

  it("does not follow a provider-cache symlink", () => {
    const { channels, path, providerId, root } = fixture();
    const outside = join(root, "outside-secret.txt");
    writeFileSync(outside, "must-not-be-read\n", "utf8");
    symlinkSync(outside, path);

    expect(materializeActiveRuleProviders(channels, root).get(providerId)).toEqual({
      content: null,
      sourceKind: "third-party",
    });
  });

  it("invalidates a bounded snapshot when its provider file is replaced", () => {
    const { channels, path, root } = fixture();
    writeFileSync(path, "api.service.example\n", "utf8");
    const snapshot = materializeActiveRuleProviderSnapshot(channels, root);

    const replacement = `${path}.replacement`;
    writeFileSync(replacement, "cdn.service.example\n", "utf8");
    renameSync(replacement, path);

    expect(snapshot.isCurrent()).toBe(false);
  });

  it("treats stale and empty text provider caches as incomplete", () => {
    const { channels, path, providerId, root } = fixture();
    writeFileSync(path, "", "utf8");

    expect(materializeActiveRuleProviders(channels, root).get(providerId)?.content).toBeNull();

    writeFileSync(path, "api.service.example\n", "utf8");
    const staleAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    utimesSync(path, staleAt, staleAt);
    expect(materializeActiveRuleProviders(channels, root).get(providerId)?.content).toBeNull();
  });

  it("does not traverse a symlinked providers parent", () => {
    const { channels, providerId, root } = fixture();
    const providers = join(root, "providers");
    rmSync(providers, { recursive: true, force: true });
    const outside = mkdtempSync(join(tmpdir(), "submerge-provider-outside-"));
    roots.push(outside);
    symlinkSync(outside, providers);
    const reference = channels[1]?.ruleProviders?.[0];
    if (!reference) throw new Error("provider fixture is missing");
    writeFileSync(join(outside, `${providerId}.txt`), "must-not-be-read\n", "utf8");

    expect(materializeActiveRuleProviders(channels, root).get(providerId)?.content).toBeNull();
  });

  it("fails coverage closed when active providers exceed the aggregate count bound", () => {
    const { channels, root } = fixture();
    const defaultChannel = channels[0];
    const direct = channels[1];
    if (!defaultChannel || !direct) throw new Error("channel fixture is incomplete");
    const references = Array.from({ length: MAX_ACTIVE_PROVIDER_COUNT + 1 }, (_, index) => ({
      url: `https://rules.example/provider-${index}.txt`,
      behavior: "domain" as const,
    }));
    const boundedChannels: ChannelConfigInput[] = [
      defaultChannel,
      { ...direct, ruleProviders: references },
    ];

    const materialized = materializeActiveRuleProviders(boundedChannels, root);
    const coverage = evaluateDomainCoverage(
      "api.service.example",
      coverageModelFromActiveChannels(boundedChannels, materialized),
    );

    expect(materialized.size).toBe(MAX_ACTIVE_PROVIDER_COUNT);
    expect(coverage).toMatchObject({
      status: "incomplete",
      incompleteSourceIds: expect.arrayContaining(["active-provider-limit"]),
    });
  });

  it("stops reading provider files after the aggregate byte budget is exhausted", () => {
    const { channels, root } = fixture();
    const defaultChannel = channels[0];
    const direct = channels[1];
    if (!defaultChannel || !direct) throw new Error("channel fixture is incomplete");
    const references = Array.from({ length: 5 }, (_, index) => ({
      url: `https://rules.example/large-${index}.txt`,
      behavior: "domain" as const,
    }));
    for (const reference of references) {
      writeFileSync(
        join(root, ruleProviderRelativePath(reference)),
        Buffer.alloc(MAX_PROVIDER_CONTENT_BYTES, 0x61),
      );
    }
    const boundedChannels: ChannelConfigInput[] = [
      defaultChannel,
      { ...direct, ruleProviders: references },
    ];

    const materialized = materializeActiveRuleProviders(boundedChannels, root);
    const fourth = references[3];
    const fifth = references[4];
    if (!fourth || !fifth) throw new Error("provider fixture is incomplete");

    expect(materialized.get(ruleProviderName(fourth))?.content).not.toBeNull();
    expect(materialized.get(ruleProviderName(fifth))?.content).toBeNull();
  });
});
