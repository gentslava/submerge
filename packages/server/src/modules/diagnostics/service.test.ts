import { fileURLToPath } from "node:url";
import {
  DEFAULT_SPEED_POLICY,
  type DiagnosticsResult,
  emptyChannelMatcher,
} from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { channels } from "../../db/schema.js";
import { createChannel, ensureDefaultChannel, ensureDirectChannel } from "../channels/service.js";
import { getSetting, setSetting } from "../settings/service.js";
import { DiagnosticsService, type DiagnosticsServiceDeps, SERVICE_PROBES } from "./service.js";

function freshDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
  ensureDefaultChannel(db);
  ensureDirectChannel(db);
  return db;
}

function leaf(name: string, type = "Vless") {
  return { name, type, history: [] };
}

function healthyDeps(db: Db = freshDb()): DiagnosticsServiceDeps {
  return {
    db,
    getVersion: vi.fn(async () => ({ version: "v1.19.12" })),
    healthHapp: vi.fn(async () => ({ ok: true as const })),
    getProxies: vi.fn(async () => ({
      proxies: {
        AUTO: { ...leaf("AUTO", "URLTest"), all: ["NL"], now: "NL" },
        NL: leaf("NL"),
        DIRECT: leaf("DIRECT", "Direct"),
      },
    })),
    getRuntimeConfig: vi.fn(async () => ({ mode: "rule", dns: true, ipv6: false, tun: false })),
    getExternalIpTrace: vi.fn(async () => ({ ip: "185.107.56.42", country: "NL", colo: "AMS" })),
    getDelay: vi.fn(async () => ({ delay: 48 })),
    probeThroughProxy: vi.fn(async (url: string) => ({
      status: url.includes("cdn-cgi/trace") ? 200 : 204,
    })),
    now: () => Date.parse("2026-07-16T08:00:00.000Z"),
    monotonicNow: () => 100,
    proxyEndpointFallback: "127.0.0.1:7890",
  };
}

function cachedResult(completedAt = "2026-07-16T08:00:00.000Z"): DiagnosticsResult {
  return {
    startedAt: completedAt,
    completedAt,
    durationMs: 0,
    state: "ready",
    summary: "1 из 1 маршрутов · 6 из 6 сервисов",
    components: [],
    externalIp: {
      status: "ok",
      ip: "185.107.56.42",
      country: "NL",
      colo: "AMS",
      durationMs: 1,
      route: "Default",
      node: "NL",
      detail: "Внешний IP определён",
      errorCode: null,
    },
    routes: [],
    services: [],
    config: {
      status: "ok",
      proxyEndpoint: "127.0.0.1:7890",
      mode: "rule",
      dns: true,
      ipv6: false,
      tun: false,
      errorCode: null,
    },
  };
}

describe("DiagnosticsService cache", () => {
  it("caches for five minutes, expires at the boundary, and force bypasses only completed cache", async () => {
    let now = 1_000_000;
    let runNumber = 0;
    const runner = vi.fn(async () => cachedResult(new Date(now + ++runNumber).toISOString()));
    const service = new DiagnosticsService({ ...healthyDeps(), now: () => now, runChecks: runner });

    const first = await service.run();
    expect(await service.run()).toBe(first);
    expect(runner).toHaveBeenCalledOnce();

    now += 299_999;
    expect(await service.run()).toBe(first);
    expect(runner).toHaveBeenCalledOnce();

    now += 1;
    const expired = await service.run();
    expect(expired).not.toBe(first);
    expect(runner).toHaveBeenCalledTimes(2);

    const forced = await service.run({ force: true });
    expect(forced).not.toBe(expired);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("deduplicates every in-flight call, including force", async () => {
    let resolve!: (value: DiagnosticsResult) => void;
    const runner = vi.fn(() => new Promise<DiagnosticsResult>((done) => (resolve = done)));
    const service = new DiagnosticsService({ ...healthyDeps(), runChecks: runner });

    const first = service.run();
    const second = service.run();
    const forced = service.run({ force: true });
    await Promise.resolve();
    expect(runner).toHaveBeenCalledOnce();
    resolve(cachedResult());
    await expect(Promise.all([first, second, forced])).resolves.toEqual([
      cachedResult(),
      cachedResult(),
      cachedResult(),
    ]);
  });

  it("normalizes an internal rejection, caches it, and clears in-flight state", async () => {
    const runner = vi.fn().mockRejectedValueOnce(new Error("secret=do-not-leak"));
    const service = new DiagnosticsService({ ...healthyDeps(), runChecks: runner });

    const result = await service.run();
    expect(result.state).toBe("partial");
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
    expect(await service.run()).toBe(result);
    expect(runner).toHaveBeenCalledOnce();

    runner.mockResolvedValueOnce(cachedResult());
    await expect(service.run({ force: true })).resolves.toMatchObject({ state: "ready" });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("uses the same TTL for partial results", async () => {
    let now = 2_000_000;
    const partial = { ...cachedResult(), state: "partial" as const };
    const runner = vi.fn(async () => partial);
    const service = new DiagnosticsService({ ...healthyDeps(), now: () => now, runChecks: runner });

    const first = await service.run();
    expect(first).toStrictEqual(partial);
    now += 299_999;
    expect(await service.run()).toBe(first);
    expect(runner).toHaveBeenCalledOnce();
    now += 1;
    await service.run();
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe("DiagnosticsService orchestration", () => {
  it("uses the real monotonic clock without detaching performance.now", async () => {
    const deps = healthyDeps();
    delete deps.monotonicNow;

    const result = await new DiagnosticsService(deps).run({ force: true });

    expect(result.state).toBe("ready");
    expect(result.components.map((component) => component.status)).toEqual(["ok", "ok", "ok"]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("starts independent component checks together and returns a parsed healthy result", async () => {
    const deps = healthyDeps();
    let databaseStarted = false;
    let mihomoStarted = false;
    let happStarted = false;
    deps.checkDb = vi.fn(async () => {
      databaseStarted = true;
      await Promise.resolve();
      expect(mihomoStarted).toBe(true);
      expect(happStarted).toBe(true);
    });
    deps.getVersion = vi.fn(async () => {
      mihomoStarted = true;
      await Promise.resolve();
      expect(databaseStarted).toBe(true);
      expect(happStarted).toBe(true);
      return { version: "v1.19.12" };
    });
    deps.healthHapp = vi.fn(async () => {
      happStarted = true;
      await Promise.resolve();
      expect(databaseStarted).toBe(true);
      expect(mihomoStarted).toBe(true);
      return { ok: true };
    });

    const result = await new DiagnosticsService(deps).run();
    expect(result.state).toBe("ready");
    expect(result.components.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "submerge", status: "ok" },
      { id: "mihomo", status: "ok" },
      { id: "happ-decoder", status: "ok" },
    ]);
    expect(result.summary).toBe("1 из 1 маршрутов · 6 из 6 сервисов");
  });

  it("skips every mihomo-dependent section when its version check fails", async () => {
    const deps = healthyDeps();
    deps.getVersion = vi.fn(async () => {
      throw new Error("Authorization: Bearer secret");
    });
    const result = await new DiagnosticsService(deps).run({ force: true });

    expect(result.state).toBe("mihomo-down");
    expect(result.externalIp.status).toBe("skipped");
    expect(result.routes).toEqual([]);
    expect(result.services.every((entry) => entry.status === "skipped")).toBe(true);
    expect(result.summary).toBe("0 из 0 маршрутов · 0 из 0 сервисов");
    expect(result.config.status).toBe("skipped");
    expect(deps.getProxies).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("checks enabled proxy channels in match order using current leaves and policy URLs", async () => {
    const deps = healthyDeps();
    createChannel(deps.db, {
      name: "Manual AI",
      policy: { kind: "manual", pinnedNode: "DE", onFailure: "hold" },
      matcher: { ...emptyChannelMatcher(), domains: ["chatgpt.com"] },
    });
    createChannel(deps.db, {
      name: "Streaming",
      policy: { ...DEFAULT_SPEED_POLICY, testUrl: "https://youtube.com/generate_204" },
      matcher: { ...emptyChannelMatcher(), domains: ["youtube.com"] },
    });
    deps.db.update(channels).set({ enabled: false }).where(eq(channels.id, "ch2")).run();
    deps.getProxies = vi.fn(async () => ({
      proxies: {
        AUTO: { ...leaf("AUTO", "URLTest"), all: ["nested"], now: "nested" },
        nested: { ...leaf("nested", "Selector"), all: ["NL"], now: "NL" },
        "ch-ch1": { ...leaf("ch-ch1", "Selector"), all: ["DE"], now: "DE" },
        NL: leaf("NL"),
        DE: leaf("DE"),
        DIRECT: leaf("DIRECT", "Direct"),
      },
    }));

    const result = await new DiagnosticsService(deps).run({ force: true });
    expect(result.routes.map((entry) => [entry.channelName, entry.node])).toEqual([
      ["Manual AI", "DE"],
      ["Default", "NL"],
    ]);
    expect(deps.getDelay).toHaveBeenNthCalledWith(
      1,
      "DE",
      "https://www.gstatic.com/generate_204",
      expect.objectContaining({ timeoutMs: 5000, expected: "200-399" }),
    );
    expect(deps.getDelay).toHaveBeenNthCalledWith(
      2,
      "NL",
      "https://www.gstatic.com/generate_204",
      expect.objectContaining({ timeoutMs: 5000, expected: "200-399" }),
    );
  });

  it("uses the fixed service registry and classifies each final HTTP status", async () => {
    const deps = healthyDeps();
    const statuses = [204, 204, 302, 200, 403, 503];
    deps.probeThroughProxy = vi.fn(async () => ({ status: statuses.shift() ?? 500 }));

    const result = await new DiagnosticsService(deps).run({ force: true });
    expect(deps.probeThroughProxy).toHaveBeenCalledTimes(SERVICE_PROBES.length);
    expect(deps.probeThroughProxy).toHaveBeenCalledWith(
      "https://chatgpt.com/favicon.ico",
      expect.any(AbortSignal),
    );
    expect(
      result.services.map(({ id, status, httpStatus }) => ({ id, status, httpStatus })),
    ).toEqual([
      { id: "google", status: "ok", httpStatus: 204 },
      { id: "youtube", status: "ok", httpStatus: 204 },
      { id: "telegram", status: "ok", httpStatus: 302 },
      { id: "cloudflare", status: "ok", httpStatus: 200 },
      { id: "chatgpt", status: "ok", httpStatus: 403 },
      { id: "steam", status: "failed", httpStatus: 503 },
    ]);
  });

  it.each([
    [new DOMException("deadline", "TimeoutError"), "timeout"],
    [new Error("getaddrinfo ENOTFOUND"), "unreachable"],
    [new Error("TLS handshake failed"), "unreachable"],
  ] as const)("classifies safe service failures: %s", async (error, errorCode) => {
    const deps = healthyDeps();
    deps.probeThroughProxy = vi.fn(async () => {
      throw error;
    });
    const result = await new DiagnosticsService(deps).run({ force: true });
    expect(result.services.every((entry) => entry.errorCode === errorCode)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  it("attributes external IP only when ordered local matchers prove the route", async () => {
    const deterministic = healthyDeps();
    createChannel(deterministic.db, {
      name: "Cloudflare",
      policy: { kind: "manual", pinnedNode: "DE", onFailure: "hold" },
      matcher: { ...emptyChannelMatcher(), domains: ["cloudflare.com"] },
    });
    deterministic.getProxies = vi.fn(async () => ({
      proxies: {
        AUTO: { ...leaf("AUTO", "URLTest"), all: ["NL"], now: "NL" },
        "ch-ch1": { ...leaf("ch-ch1", "Selector"), all: ["DE"], now: "DE" },
        NL: leaf("NL"),
        DE: leaf("DE"),
        DIRECT: leaf("DIRECT", "Direct"),
      },
    }));
    const attributed = await new DiagnosticsService(deterministic).run({ force: true });
    expect(attributed.externalIp).toMatchObject({ route: "Cloudflare", node: "DE" });

    const uncertain = healthyDeps();
    createChannel(uncertain.db, {
      name: "Provider first",
      policy: { kind: "manual", pinnedNode: "DE", onFailure: "hold" },
      matcher: {
        ...emptyChannelMatcher(),
        ruleProviders: [{ url: "https://example.com/rules.yaml", behavior: "domain" }],
      },
    });
    createChannel(uncertain.db, {
      name: "Cloudflare",
      policy: { kind: "manual", pinnedNode: "DE", onFailure: "hold" },
      matcher: { ...emptyChannelMatcher(), domains: ["cloudflare.com"] },
    });
    uncertain.getProxies = vi.fn(async () => ({
      proxies: {
        AUTO: { ...leaf("AUTO", "URLTest"), all: ["NL"], now: "NL" },
        "ch-ch1": { ...leaf("ch-ch1", "Selector"), all: ["DE"], now: "DE" },
        "ch-ch2": { ...leaf("ch-ch2", "Selector"), all: ["DE"], now: "DE" },
        NL: leaf("NL"),
        DE: leaf("DE"),
        DIRECT: leaf("DIRECT", "Direct"),
      },
    }));
    const fallback = await new DiagnosticsService(uncertain).run({ force: true });
    expect(fallback.externalIp).toMatchObject({
      route: "через mihomo · текущие правила",
      node: null,
    });
  });

  it("never exceeds six concurrent operations", async () => {
    const deps = healthyDeps();
    for (let index = 0; index < 8; index++) {
      createChannel(deps.db, {
        name: `Channel ${index}`,
        policy: { kind: "manual", pinnedNode: "NL", onFailure: "hold" },
        matcher: { ...emptyChannelMatcher(), domains: [`service-${index}.example.com`] },
      });
    }
    deps.getProxies = vi.fn(async () => ({
      proxies: {
        AUTO: { ...leaf("AUTO", "URLTest"), all: ["NL"], now: "NL" },
        ...Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `ch-ch${index + 1}`,
            { ...leaf(`ch-ch${index + 1}`, "Selector"), all: ["NL"], now: "NL" },
          ]),
        ),
        NL: leaf("NL"),
        DIRECT: leaf("DIRECT", "Direct"),
      },
    }));
    let active = 0;
    let maximum = 0;
    const watched = async <T>(value: T): Promise<T> => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return value;
    };
    deps.getRuntimeConfig = vi.fn(() =>
      watched({ mode: "rule", dns: true, ipv6: false, tun: false }),
    );
    deps.getExternalIpTrace = vi.fn(() =>
      watched({ ip: "185.107.56.42", country: "NL", colo: "AMS" }),
    );
    deps.getDelay = vi.fn(() => watched({ delay: 48 }));
    deps.probeThroughProxy = vi.fn((url: string) =>
      watched({ status: url.includes("cdn-cgi/trace") ? 200 : 204 }),
    );

    await new DiagnosticsService(deps).run({ force: true });
    expect(maximum).toBe(6);
  });

  it("applies five-second operation and fifteen-second overall deadlines", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("deadline", "TimeoutError")),
        milliseconds,
      );
      return controller.signal;
    });
    try {
      const deps = healthyDeps();
      for (let index = 0; index < 20; index++) {
        createChannel(deps.db, {
          name: `Stalled ${index}`,
          policy: { kind: "manual", pinnedNode: "NL", onFailure: "hold" },
          matcher: { ...emptyChannelMatcher(), domains: [`stalled-${index}.example.com`] },
        });
      }
      deps.getProxies = vi.fn(async () => ({
        proxies: {
          AUTO: { ...leaf("AUTO", "URLTest"), all: ["NL"], now: "NL" },
          ...Object.fromEntries(
            Array.from({ length: 20 }, (_, index) => [
              `ch-ch${index + 1}`,
              { ...leaf(`ch-ch${index + 1}`, "Selector"), all: ["NL"], now: "NL" },
            ]),
          ),
          NL: leaf("NL"),
          DIRECT: leaf("DIRECT", "Direct"),
        },
      }));
      const stalled = () => new Promise<never>(() => undefined);
      deps.getRuntimeConfig = vi.fn(stalled);
      deps.getExternalIpTrace = vi.fn(stalled);
      deps.getDelay = vi.fn(stalled);
      deps.probeThroughProxy = vi.fn(stalled);

      const pending = new DiagnosticsService(deps).run({ force: true });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
      expect(result.routes.some((entry) => entry.errorCode === "timeout")).toBe(true);
      expect(result.services.some((entry) => entry.errorCode === "timeout")).toBe(true);
      expect(
        vi.mocked(deps.getDelay).mock.calls.length +
          vi.mocked(deps.probeThroughProxy).mock.calls.length,
      ).toBeLessThan(27);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses deterministic result timestamps and duration", async () => {
    const deps = healthyDeps();
    const epochs = [Date.parse("2026-07-16T08:00:00.000Z"), Date.parse("2026-07-16T08:00:02.000Z")];
    const monotonic = [10, 10, 20, 20, 30, 30, 40, 40, 50, 50, 60, 60, 70, 70, 80, 80, 90, 90, 110];
    deps.now = () => epochs.shift() ?? Date.parse("2026-07-16T08:00:02.000Z");
    deps.monotonicNow = () => monotonic.shift() ?? 110;
    const result = await new DiagnosticsService(deps).run({ force: true });
    expect(result.startedAt).toBe("2026-07-16T08:00:00.000Z");
    expect(result.completedAt).toBe("2026-07-16T08:00:02.000Z");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports the configured proxy endpoint without creating an HWID", async () => {
    const deps = healthyDeps();
    setSetting(deps.db, "proxyEndpoint", "10.0.0.2:7890");
    const result = await new DiagnosticsService(deps).run({ force: true });
    expect(result.config.proxyEndpoint).toBe("10.0.0.2:7890");
    expect(getSetting(deps.db, "hwid")).toBeUndefined();
  });

  it("skips proxy exits when no real nodes exist while still probing DIRECT services", async () => {
    const deps = healthyDeps();
    deps.getProxies = vi.fn(async () => ({
      proxies: {
        AUTO: { ...leaf("AUTO", "Selector"), all: ["DIRECT"], now: "DIRECT" },
        DIRECT: leaf("DIRECT", "Direct"),
      },
    }));
    const result = await new DiagnosticsService(deps).run({ force: true });
    expect(result.state).toBe("no-nodes");
    expect(result.externalIp.status).toBe("skipped");
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({ node: "DIRECT", status: "ok" });
    expect(deps.getDelay).not.toHaveBeenCalled();
    expect(deps.probeThroughProxy).toHaveBeenCalledTimes(6);
  });

  it("keeps Default DIRECT but skips non-default routes when no real nodes exist", async () => {
    const deps = healthyDeps();
    createChannel(deps.db, {
      name: "Custom",
      policy: { kind: "manual", pinnedNode: "DIRECT", onFailure: "hold" },
      matcher: { ...emptyChannelMatcher(), domains: ["example.com"] },
    });
    deps.getProxies = vi.fn(async () => ({
      proxies: {
        AUTO: { ...leaf("AUTO", "Selector"), all: ["DIRECT"], now: "DIRECT" },
        "ch-ch1": { ...leaf("ch-ch1", "Selector"), all: ["DIRECT"], now: "DIRECT" },
        DIRECT: leaf("DIRECT", "Direct"),
      },
    }));

    const result = await new DiagnosticsService(deps).run({ force: true });
    expect(result.routes).toEqual([
      expect.objectContaining({ channelName: "Custom", status: "skipped" }),
      expect.objectContaining({ channelName: "Default", node: "DIRECT", status: "ok" }),
    ]);
    expect(result.summary).toBe("1 из 1 маршрутов · 6 из 6 сервисов");
    expect(deps.getDelay).not.toHaveBeenCalled();
  });

  it("returns a safe result when SQLite and settings reads fail", async () => {
    const deps = healthyDeps();
    deps.db = new Proxy(deps.db, {
      get() {
        throw new Error("sqlite secret/raw failure");
      },
    });
    deps.checkDb = vi.fn(async () => {
      throw new Error("sqlite secret/raw failure");
    });

    const result = await new DiagnosticsService(deps).run({ force: true });
    expect(result.state).toBe("partial");
    expect(result.components.find((component) => component.id === "submerge")?.status).toBe(
      "failed",
    );
    expect(result.config.proxyEndpoint).toBe("127.0.0.1:7890");
    expect(JSON.stringify(result)).not.toContain("secret/raw");
  });

  it("never serializes credentials, query strings, headers, trace bodies, or raw exceptions", async () => {
    const deps = healthyDeps();
    deps.db
      .update(channels)
      .set({
        policy: {
          ...DEFAULT_SPEED_POLICY,
          testUrl: "https://user:password@example.com/path?token=top-secret#fragment",
        },
      })
      .where(eq(channels.id, "default"))
      .run();
    deps.getDelay = vi.fn(async () => {
      throw new Error("Authorization: Bearer abc; token=top-secret; trace=raw-body");
    });
    deps.getExternalIpTrace = vi.fn(async () => {
      throw new Error("ip=1.2.3.4&secret=value");
    });

    const result = await new DiagnosticsService(deps).run({ force: true });
    const serialized = JSON.stringify(result);
    expect(result.routes[0]?.targetHost).toBe("example.com");
    expect(serialized).not.toMatch(/password|top-secret|Bearer|raw-body|secret=value|\/path/u);
  });
});
