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

function protobufVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(next | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function protobufBytes(field: number, value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([protobufVarint(field * 8 + 2), protobufVarint(bytes.length), bytes]);
}

function geositeDomain(type: number, value: string): Buffer {
  return Buffer.concat([protobufVarint(8), protobufVarint(type), protobufBytes(2, value)]);
}

function geositeDatabase(code: string, domains: readonly Buffer[]): Buffer {
  const site = Buffer.concat([
    protobufBytes(1, code),
    ...domains.map((domain) => protobufBytes(2, domain)),
  ]);
  return protobufBytes(1, site);
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

  it("materializes active GEOSITE categories from Mihomo's local database", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-production-geosite-coverage-"));
    roots.push(root);
    mkdirSync(join(root, "providers"));
    writeFileSync(
      join(root, "geosite.dat"),
      geositeDatabase("YOUTUBE", [
        geositeDomain(2, "video.example"),
        geositeDomain(3, "exact.video.example"),
      ]),
    );
    const active = channels();
    const target = active[1];
    if (!target) throw new Error("missing channel fixture");
    target.geosite = ["youtube"];

    const snapshot = createProductionDomainCoverageSnapshot({
      channels: active,
      managedRuleDirectory: join(root, "unused-rule-volume"),
      mihomoDirectory: root,
      managedProviderActive: false,
    });

    expect(snapshot.readCoverage("cdn.video.example")).toMatchObject({
      status: "covered",
      match: { kind: "suffix", rule: "video.example", sourceId: "channel:custom-target" },
    });
    expect(snapshot.readCoverage("unrelated.example")).toEqual({
      status: "uncovered",
      match: null,
      incompleteSourceIds: [],
    });
  });
});
