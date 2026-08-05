import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SPEED_POLICY, type Proxy as ProxyConfig } from "@submerge/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelConfigInput } from "../nodes/multiConfig.js";
import {
  createProductionDomainCoverageSnapshot,
  hasManagedDomainRuleProviderTarget,
} from "./production.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function channels(): ChannelConfigInput[] {
  const proxy: ProxyConfig = {
    name: "A",
    type: "vless",
    server: "node.example",
    port: 443,
    uuid: "u",
  };
  return [
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
      target: "proxy",
      id: "custom-target",
      groupName: "Custom target",
      isDefault: false,
      policy: DEFAULT_SPEED_POLICY,
      domains: [],
      cidrs: [],
      proxies: [proxy],
    },
  ];
}

describe("production domain coverage", () => {
  it("uses the deployment race pool when deciding whether the managed provider is active", () => {
    const active = channels();
    const target = active[1];
    if (target?.target !== "proxy") throw new Error("missing proxy target fixture");
    target.race = [];

    expect(hasManagedDomainRuleProviderTarget(active, "custom-target")).toBe(false);
    target.race = target.proxies;
    expect(hasManagedDomainRuleProviderTarget(active, "custom-target")).toBe(true);
  });

  it("treats the marker-only managed baseline as a complete empty provider", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-production-empty-coverage-"));
    roots.push(root);
    mkdirSync(join(root, "providers"));
    const managedRuleDirectory = join(root, "separate-rule-volume");
    mkdirSync(managedRuleDirectory);
    writeFileSync(
      join(managedRuleDirectory, "custom.txt"),
      "# BEGIN SUBMERGE MANAGED\n# END SUBMERGE MANAGED\n",
      "utf8",
    );

    const snapshot = createProductionDomainCoverageSnapshot({
      channels: channels(),
      managedRuleDirectory,
      mihomoDirectory: root,
      managedProviderActive: true,
    });

    expect(snapshot.readCoverage("first.service.example")).toEqual({
      status: "uncovered",
      match: null,
      incompleteSourceIds: [],
    });
  });

  it("includes exact and suffix rules from the active managed custom provider", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-production-coverage-"));
    roots.push(root);
    mkdirSync(join(root, "providers"));
    const managedRuleDirectory = join(root, "separate-rule-volume");
    mkdirSync(managedRuleDirectory);
    writeFileSync(
      join(managedRuleDirectory, "custom.txt"),
      "+.service.example\napi.exact.example\n",
      "utf8",
    );

    const snapshot = createProductionDomainCoverageSnapshot({
      channels: channels(),
      managedRuleDirectory,
      mihomoDirectory: root,
      managedProviderActive: true,
    });

    expect(snapshot.readCoverage("cdn.service.example")).toMatchObject({
      status: "covered",
      match: { sourceId: "submerge-custom", sourceKind: "custom" },
    });
    expect(snapshot.readCoverage("api.exact.example")).toMatchObject({
      status: "covered",
      match: { sourceId: "submerge-custom", sourceKind: "custom" },
    });
  });
});
