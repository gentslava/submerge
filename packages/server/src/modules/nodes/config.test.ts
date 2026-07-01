import type { ChannelPolicy, Proxy as ProxyConfig } from "@submerge/shared";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { buildConfig, dedupeNames, groupProxies } from "./config.js";

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
  it("drops a true duplicate (same server:port); leftover single stays single", () => {
    const r = groupProxies([px("A", "1.1.1.1"), px("A", "1.1.1.1")]);
    expect(r).toEqual([{ kind: "single", proxy: px("A", "1.1.1.1") }]);
  });
  it("places a group at the position of its first member", () => {
    const r = groupProxies([px("A", "1.1.1.1"), px("B"), px("A", "2.2.2.2")]);
    expect(r.map((e) => (e.kind === "group" ? e.base : e.proxy.name))).toEqual(["A", "B"]);
  });
});

describe("buildConfig", () => {
  it("emits PROXY + AUTO groups and a MATCH rule for a populated config", () => {
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(buildConfig([proxy("A"), proxy("B")])) as Record<string, any>;
    expect(cfg["mixed-port"]).toBe(7890);
    expect(cfg.secret).toBe("");
    const groups = cfg["proxy-groups"];
    expect(groups[0].name).toBe("PROXY");
    expect(groups[0].proxies).toEqual(["AUTO", "A", "B", "DIRECT"]);
    expect(groups[1].name).toBe("AUTO");
    expect(groups[1].proxies).toEqual(["A", "B"]);
    expect(cfg.rules).toEqual(["MATCH,PROXY"]);
  });
  it("falls back to DIRECT when there are no proxies", () => {
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(buildConfig([])) as Record<string, any>;
    expect(cfg["proxy-groups"][0].proxies).toEqual(["AUTO", "DIRECT"]);
    expect(cfg["proxy-groups"][1].proxies).toEqual(["DIRECT"]);
    expect(cfg.rules).toEqual(["MATCH,DIRECT"]);
  });
});

describe("buildConfig collapses same-named nodes", () => {
  it("emits a url-test subgroup and references it from PROXY/AUTO", () => {
    const raw = buildConfig([px("A", "1.1.1.1"), px("A", "2.2.2.2"), px("B")]);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(raw) as Record<string, any>;
    const groups = cfg["proxy-groups"];
    expect(groups[0].proxies).toEqual(["AUTO", "A", "B", "DIRECT"]);
    expect(groups[1].name).toBe("AUTO");
    expect(groups[1].proxies).toEqual(["A", "B"]);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const sub = groups.find((g: any) => g.name === "A");
    expect(sub.type).toBe("url-test");
    expect(sub.proxies).toEqual(["A #1", "A #2"]);
    // real servers carry the member names, base name is a group only
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["A #1", "A #2", "B"]);
  });
  it("renames a group that collides with a reserved name", () => {
    const raw = buildConfig([px("AUTO", "1.1.1.1"), px("AUTO", "2.2.2.2")]);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(raw) as Record<string, any>;
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const names = cfg["proxy-groups"].map((g: any) => g.name);
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

describe("buildConfig policy mapping", () => {
  it("maps speed.reevaluateWhileHealthy=true to AUTO lazy=false + tolerance", () => {
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(buildConfig([proxy("A")], speed())) as Record<string, any>;
    const auto = cfg["proxy-groups"].find((g: any) => g.name === "AUTO");
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
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(buildConfig([proxy("A"), proxy("B")], sticky)) as Record<string, any>;
    const auto = cfg["proxy-groups"].find((g: any) => g.name === "AUTO");
    expect(auto.type).toBe("select");
    expect(auto.proxies).toEqual(["A", "B"]);
    expect(auto.tolerance).toBeUndefined();
  });
});
