import {
  type ChannelPolicy,
  DEFAULT_SPEED_POLICY,
  type Proxy as ProxyConfig,
} from "@submerge/shared";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { buildConfig } from "./config.js";
import { buildMultiConfig, type ChannelConfigInput } from "./multiConfig.js";

const px = (name: string, server = "ex.com", port = 443): ProxyConfig => ({
  name,
  type: "vless",
  server,
  port,
  uuid: "u",
});

const sticky: ChannelPolicy = {
  kind: "sticky",
  testUrl: "https://x/generate_204",
  intervalSec: 60,
  failureThreshold: 3,
  maxHoldHours: null,
  initialCriterion: "fastest",
};

const channel = (over: Partial<ChannelConfigInput>): ChannelConfigInput => ({
  id: "default",
  groupName: "AUTO",
  isDefault: true,
  policy: DEFAULT_SPEED_POLICY,
  domains: [],
  proxies: [],
  ...over,
});

// biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
const parse = (raw: string): Record<string, any> => yaml.load(raw) as Record<string, any>;

describe("buildMultiConfig — single Default channel (byte-identity)", () => {
  it("reproduces buildConfig output exactly for the default-only case", () => {
    const proxies = [px("A"), px("B")];
    const legacy = buildConfig(proxies, DEFAULT_SPEED_POLICY);
    const multi = buildMultiConfig([channel({ proxies })]);
    // The invariant: delegation makes these byte-for-byte identical.
    expect(multi).toBe(legacy);

    const cfg = parse(multi);
    const groups = cfg["proxy-groups"];
    expect(groups[0]).toMatchObject({ name: "PROXY", proxies: ["AUTO", "A", "B", "DIRECT"] });
    expect(groups[1]).toMatchObject({ name: "AUTO", type: "url-test", proxies: ["A", "B"] });
    expect(cfg.rules).toEqual(["MATCH,PROXY"]);
  });
});

describe("buildMultiConfig — multiple channels", () => {
  it("shares a node across channels and routes non-default domains", () => {
    const A = px("A", "a.com");
    const B = px("B", "b.com");
    const C = px("C", "c.com");
    const raw = buildMultiConfig([
      channel({ proxies: [A, B] }),
      channel({
        id: "media",
        groupName: "ch-media",
        isDefault: false,
        policy: sticky,
        domains: ["youtube.com"],
        proxies: [B, C],
      }),
    ]);
    const cfg = parse(raw);

    // A, B, C each defined once; B is shared between the two channels.
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["A", "B", "C"]);

    const groups = cfg["proxy-groups"];
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const auto = groups.find((g: any) => g.name === "AUTO");
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const media = groups.find((g: any) => g.name === "ch-media");
    expect(auto.type).toBe("url-test");
    expect(auto.proxies).toEqual(["A", "B"]);
    expect(media.type).toBe("select");
    expect(media.proxies).toEqual(["B", "C"]);

    expect(cfg.rules).toEqual(["DOMAIN-SUFFIX,youtube.com,ch-media", "MATCH,AUTO"]);
  });

  it("keeps same-name collapse per channel while still sharing endpoints", () => {
    const x1 = px("X", "x1.com");
    const x2 = px("X", "x2.com");
    const raw = buildMultiConfig([
      channel({ proxies: [x1, x2] }),
      channel({
        id: "media",
        groupName: "ch-media",
        isDefault: false,
        policy: sticky,
        domains: [],
        proxies: [x1],
      }),
    ]);
    const cfg = parse(raw);
    const groups = cfg["proxy-groups"];

    // Default collapses the two same-named endpoints into a subgroup.
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const auto = groups.find((g: any) => g.name === "AUTO");
    expect(auto.proxies).toEqual(["X"]);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const sub = groups.find((g: any) => g.name === "X");
    expect(sub.type).toBe("url-test");
    expect(sub.proxies).toEqual(["X #1", "X #2"]);

    // media references only the shared x1 endpoint — the collapse doesn't leak in.
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const media = groups.find((g: any) => g.name === "ch-media");
    expect(media.proxies).toEqual(["X #1"]);
    // Endpoints defined once, shared by index.
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["X #1", "X #2"]);
  });

  it("falls back to MATCH,DIRECT when no channel has any proxies", () => {
    const raw = buildMultiConfig([
      channel({ proxies: [] }),
      channel({
        id: "media",
        groupName: "ch-media",
        isDefault: false,
        policy: sticky,
        domains: ["youtube.com"],
        proxies: [],
      }),
    ]);
    const cfg = parse(raw);
    expect(cfg.proxies).toEqual([]);
    expect(cfg.rules).toEqual(["MATCH,DIRECT"]);
  });
});
