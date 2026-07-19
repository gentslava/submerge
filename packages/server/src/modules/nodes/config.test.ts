import type { ChannelPolicy, Proxy as ProxyConfig } from "@submerge/shared";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { dedupeNames, groupProxies } from "./config.js";
import { buildDefaultConfig } from "./config.test-support.js";

const proxy = (name: string): ProxyConfig => ({
  name,
  type: "vless",
  server: "ex.com",
  port: 443,
  uuid: "u",
});

describe("dedupeNames", () => {
  it("leaves unique names untouched", () => {
    expect(dedupeNames([proxy("A"), proxy("B")]).map((p) => p.name)).toEqual(["A", "B"]);
  });
  it("disambiguates duplicates deterministically", () => {
    expect(dedupeNames([proxy("A"), proxy("A"), proxy("A")]).map((p) => p.name)).toEqual([
      "A",
      "A-2",
      "A-3",
    ]);
  });
  it("tracks each name independently", () => {
    expect(
      dedupeNames([proxy("A"), proxy("B"), proxy("A"), proxy("B")]).map((p) => p.name),
    ).toEqual(["A", "B", "A-2", "B-2"]);
  });
  it("skips a suffix already taken by a pre-existing name", () => {
    expect(dedupeNames([proxy("A-2"), proxy("A"), proxy("A")]).map((p) => p.name)).toEqual([
      "A-2",
      "A",
      "A-3",
    ]);
  });
});

const px = (name: string, server = "ex.com", port = 443): ProxyConfig => ({
  name,
  type: "vless",
  server,
  port,
  uuid: "u",
});

type ParsedConfigGroup = {
  name: string;
  type?: string;
  proxies?: string[];
  lazy?: boolean;
  tolerance?: number;
  url?: string;
  interval?: number;
};

type ParsedConfig = {
  "mixed-port": number;
  secret: string;
  "proxy-groups": ParsedConfigGroup[];
  rules: string[];
  proxies: Array<{ name: string }>;
};

function parseConfig(raw: string): ParsedConfig {
  return yaml.load(raw) as ParsedConfig;
}

function groupNamed(config: ParsedConfig, name: string): ParsedConfigGroup {
  const group = config["proxy-groups"].find((candidate) => candidate.name === name);
  if (!group) throw new Error(`missing ${name} group`);
  return group;
}

describe("groupProxies", () => {
  it("keeps unique names as singles, order preserved", () => {
    const r = groupProxies([px("A"), px("B")]);
    expect(r).toEqual([
      { kind: "single", proxy: px("A") },
      { kind: "single", proxy: px("B") },
    ]);
  });
  it("collapses same-name distinct endpoints into a group", () => {
    const r = groupProxies([px("A", "1.1.1.1"), px("A", "2.2.2.2")]);
    expect(r).toEqual([
      { kind: "group", base: "A", members: [px("A", "1.1.1.1"), px("A", "2.2.2.2")] },
    ]);
  });
  it("drops a fully identical duplicate; leftover single stays single", () => {
    const r = groupProxies([px("A", "1.1.1.1"), px("A", "1.1.1.1")]);
    expect(r).toEqual([{ kind: "single", proxy: px("A", "1.1.1.1") }]);
  });
  it("keeps same-address profiles distinct when their credentials differ", () => {
    const first = { ...px("A", "1.1.1.1"), uuid: "first" };
    const second = { ...px("A", "1.1.1.1"), uuid: "second" };
    expect(groupProxies([first, second])).toEqual([
      { kind: "group", base: "A", members: [first, second] },
    ]);
  });
  it("places a group at the position of its first member", () => {
    const r = groupProxies([px("A", "1.1.1.1"), px("B"), px("A", "2.2.2.2")]);
    expect(r.map((e) => (e.kind === "group" ? e.base : e.proxy.name))).toEqual(["A", "B"]);
  });
});

describe("buildDefaultConfig", () => {
  it("emits PROXY + AUTO groups and a MATCH rule for a populated config", () => {
    const cfg = parseConfig(buildDefaultConfig([proxy("A"), proxy("B")]));
    expect(cfg["mixed-port"]).toBe(7890);
    expect(cfg.secret).toBe("");
    expect(groupNamed(cfg, "PROXY").proxies).toEqual(["AUTO", "A", "B", "DIRECT"]);
    expect(groupNamed(cfg, "AUTO").proxies).toEqual(["A", "B"]);
    expect(cfg.rules).toEqual(["DOMAIN,speed.cloudflare.com,PROBE", "MATCH,PROXY"]);
  });
  it("falls back to DIRECT when there are no proxies", () => {
    const cfg = parseConfig(buildDefaultConfig([]));
    expect(groupNamed(cfg, "PROXY").proxies).toEqual(["AUTO", "DIRECT"]);
    expect(groupNamed(cfg, "AUTO").proxies).toEqual(["DIRECT"]);
    expect(cfg.rules).toEqual(["MATCH,DIRECT"]);
  });
});

describe("buildDefaultConfig collapses same-named nodes", () => {
  it("emits a url-test subgroup and references it from PROXY/AUTO", () => {
    const raw = buildDefaultConfig([px("A", "1.1.1.1"), px("A", "2.2.2.2"), px("B")]);
    const cfg = parseConfig(raw);
    expect(groupNamed(cfg, "PROXY").proxies).toEqual(["AUTO", "A", "B", "DIRECT"]);
    expect(groupNamed(cfg, "AUTO").proxies).toEqual(["A", "B"]);
    const sub = groupNamed(cfg, "A");
    expect(sub.type).toBe("url-test");
    expect(sub.proxies).toEqual(["A #1", "A #2"]);
    // real servers carry the member names, base name is a group only
    expect(cfg.proxies.map((proxy) => proxy.name)).toEqual(["A #1", "A #2", "B"]);
  });
  it("renames a group that collides with a reserved name", () => {
    const raw = buildDefaultConfig([px("AUTO", "1.1.1.1"), px("AUTO", "2.2.2.2")]);
    const cfg = parseConfig(raw);
    const names = cfg["proxy-groups"].map((group) => group.name);
    expect(names).toContain("AUTO-2"); // the collapsed provider group, guarded
    expect(names[1]).toBe("AUTO"); // the system AUTO group is untouched
  });
});

const speed = (over: Partial<Extract<ChannelPolicy, { kind: "speed" }>> = {}): ChannelPolicy => ({
  kind: "speed",
  testUrl: "https://x/generate_204",
  intervalSec: 300,
  toleranceMs: 50,
  reevaluateWhileHealthy: true,
  ...over,
});

describe("buildDefaultConfig policy mapping", () => {
  it("maps speed.reevaluateWhileHealthy=true to AUTO lazy=false + tolerance", () => {
    const cfg = parseConfig(buildDefaultConfig([proxy("A")], speed()));
    const auto = groupNamed(cfg, "AUTO");
    expect(auto.type).toBe("url-test");
    expect(auto.lazy).toBe(false);
    expect(auto.tolerance).toBe(50);
    expect(auto.url).toBe("https://x/generate_204");
    expect(auto.interval).toBe(300);
  });

  it("makes AUTO a select group for a sticky policy (server pins it)", () => {
    const sticky: ChannelPolicy = {
      kind: "sticky",
      testUrl: "https://x/generate_204",
      intervalSec: 60,
      failureThreshold: 3,
      maxHoldHours: null,
      initialCriterion: "fastest",
    };
    const cfg = parseConfig(buildDefaultConfig([proxy("A"), proxy("B")], sticky));
    const auto = groupNamed(cfg, "AUTO");
    expect(auto.type).toBe("select");
    expect(auto.proxies).toEqual(["A", "B"]);
    expect(auto.tolerance).toBeUndefined();
  });
});
