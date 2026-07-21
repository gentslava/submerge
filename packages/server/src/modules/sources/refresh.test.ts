import type { Source, SubscriptionMeta } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { HappDecoderError } from "../../clients/happDecoder.js";
import { createDb } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  effectiveRefreshIntervalMs,
  MIN_REFRESH_INTERVAL_MS,
  refreshBackoffMs,
  SourceRefreshCoordinator,
  SourceRefreshSkippedError,
  SourceRefreshStageError,
  sourceRefreshErrorCategory,
} from "./refresh.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}

function sourceResult(
  id: number,
  meta: SubscriptionMeta | null,
): { source: Source; applied: boolean } {
  return {
    source: {
      id,
      kind: "sub",
      value: "https://provider.example/sub",
      label: "Provider",
      hwid: false,
      enabled: true,
      sortOrder: 0,
      proxies: [],
      meta,
      updatedAt: "2026-07-21 09:00:00",
      createdAt: "2026-07-20 09:00:00",
    },
    applied: true,
  };
}

describe("source refresh schedule", () => {
  it("uses the provider interval with a one-hour floor and a 24-hour fallback", () => {
    expect(effectiveRefreshIntervalMs({ updateHours: 6 })).toBe(6 * 60 * 60 * 1000);
    expect(effectiveRefreshIntervalMs({ updateHours: 0.25 })).toBe(MIN_REFRESH_INTERVAL_MS);
    expect(effectiveRefreshIntervalMs(null)).toBe(DEFAULT_REFRESH_INTERVAL_MS);
  });

  it("backs failures off from five minutes and caps the delay at six hours", () => {
    expect(refreshBackoffMs(1)).toBe(5 * 60 * 1000);
    expect(refreshBackoffMs(2)).toBe(15 * 60 * 1000);
    expect(refreshBackoffMs(3)).toBe(45 * 60 * 1000);
    expect(refreshBackoffMs(10)).toBe(6 * 60 * 60 * 1000);
  });
});

describe("SourceRefreshCoordinator", () => {
  it("stores a successful attempt and schedules from the refreshed provider interval", async () => {
    const db = freshDb();
    const row = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://provider.example/sub",
        subUrl: "https://provider.example/sub",
        label: "Provider",
        meta: { used: null, total: null, expire: null, updateHours: 6 },
        nextRefreshAttemptAt: 500_000,
        refreshFailures: 3,
        lastRefreshError: "timeout",
      })
      .returning()
      .get();
    const now = 1_000_000;
    const coordinator = new SourceRefreshCoordinator({
      db,
      now: () => now,
      refresh: async (id) =>
        sourceResult(id, { used: null, total: null, expire: null, updateHours: 2 }),
    });

    await coordinator.refresh(row.id, "scheduled");

    expect(db.select().from(sources).get()).toMatchObject({
      lastRefreshAttemptAt: now,
      lastRefreshSuccessAt: now,
      nextRefreshAttemptAt: now + 2 * 60 * 60 * 1000,
      refreshFailures: 0,
      lastRefreshError: null,
    });
  });

  it("preserves the snapshot and stores sanitized backoff after provider failures", async () => {
    const db = freshDb();
    const row = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://secret.example/sub/token",
        subUrl: "https://secret.example/sub/token",
        label: "Provider",
        proxies: [{ name: "Working", type: "vless", server: "node.example", port: 443 }],
      })
      .returning()
      .get();
    let now = 2_000_000;
    const onFailure = vi.fn();
    const coordinator = new SourceRefreshCoordinator({
      db,
      now: () => now,
      refresh: async () => {
        throw new SourceRefreshStageError(
          "fetch",
          new Error("subscription https://secret.example/sub/token returned HTTP 503"),
        );
      },
      onFailure,
    });

    await expect(coordinator.refresh(row.id, "scheduled")).rejects.toThrow("HTTP 503");
    expect(db.select().from(sources).get()).toMatchObject({
      proxies: [{ name: "Working", type: "vless", server: "node.example", port: 443 }],
      lastRefreshAttemptAt: now,
      lastRefreshSuccessAt: null,
      nextRefreshAttemptAt: now + 5 * 60 * 1000,
      refreshFailures: 1,
      lastRefreshError: "fetch:http-503",
    });
    expect(onFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: "fetch", category: "http-503" }),
    );
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("secret.example");

    now += 10_000;
    await expect(coordinator.refresh(row.id, "manual")).rejects.toThrow("HTTP 503");
    expect(db.select().from(sources).get()).toMatchObject({
      lastRefreshAttemptAt: now,
      nextRefreshAttemptAt: now + 15 * 60 * 1000,
      refreshFailures: 2,
      lastRefreshError: "fetch:http-503",
    });
  });

  it("records a safe network class from nested fetch causes", async () => {
    const db = freshDb();
    const row = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://secret.example/sub/token",
        subUrl: "https://secret.example/sub/token",
        label: "Provider",
      })
      .returning()
      .get();
    const socketError = Object.assign(new Error("socket closed by peer"), {
      code: "ECONNRESET",
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause: socketError });
    const onFailure = vi.fn();
    const coordinator = new SourceRefreshCoordinator({
      db,
      now: () => 2_000_000,
      refresh: async () => {
        throw new SourceRefreshStageError("fetch", fetchError);
      },
      onFailure,
    });

    await expect(coordinator.refresh(row.id, "scheduled")).rejects.toThrow("fetch failed");
    expect(db.select().from(sources).get()).toMatchObject({
      lastRefreshError: "fetch:connection-reset",
    });
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "fetch", category: "connection-reset" }),
    );
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("secret.example");
  });

  it("prioritizes a concrete decoder transport code over generic timeout wording", async () => {
    const db = freshDb();
    const row = db
      .insert(sources)
      .values({ kind: "happ", value: "happ://crypt5/blob", label: "Happ" })
      .returning()
      .get();
    const cause = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    const decoderError = new HappDecoderError(
      "transport",
      "happ-decoder unreachable/timeout (http://happ-decoder:8080)",
      cause,
    );
    const coordinator = new SourceRefreshCoordinator({
      db,
      refresh: async () => {
        throw new SourceRefreshStageError("decode", decoderError);
      },
    });

    await expect(coordinator.refresh(row.id, "scheduled")).rejects.toThrow(/happ-decoder/);
    expect(db.select().from(sources).get()?.lastRefreshError).toBe("decode:connection-refused");
  });

  it("uses the typed decoder outcome before incidental HTTP text", () => {
    expect(
      sourceRefreshErrorCategory(
        new SourceRefreshStageError(
          "decode",
          new HappDecoderError(
            "response",
            "happ-decoder returned an unexpected response (HTTP 200)",
          ),
        ),
      ),
    ).toBe("invalid-content");
    expect(
      sourceRefreshErrorCategory(
        new SourceRefreshStageError(
          "decode",
          new HappDecoderError("decode", "не удалось декодировать"),
        ),
      ),
    ).toBe("decoder");
  });

  it("joins duplicate source refreshes and serializes different sources", async () => {
    const db = freshDb();
    const first = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://one.example/sub",
        subUrl: "https://one.example/sub",
        label: "One",
      })
      .returning()
      .get();
    const second = db
      .insert(sources)
      .values({ kind: "happ", value: "happ://crypt5/two", label: "Two" })
      .returning()
      .get();
    let releaseFirst: (() => void) | undefined;
    const calls: number[] = [];
    const coordinator = new SourceRefreshCoordinator({
      db,
      now: () => 3_000_000,
      refresh: async (id) => {
        calls.push(id);
        if (id === first.id) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return sourceResult(id, null);
      },
    });

    const scheduled = coordinator.refresh(first.id, "scheduled");
    const joinedManual = coordinator.refresh(first.id, "manual");
    const queuedOther = coordinator.refresh(second.id, "scheduled");
    await vi.waitFor(() => expect(calls).toEqual([first.id]));

    releaseFirst?.();
    await Promise.all([scheduled, joinedManual, queuedOther]);
    expect(calls).toEqual([first.id, second.id]);
  });

  it("skips a scheduled refresh disabled while waiting in the global queue", async () => {
    const db = freshDb();
    const first = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://one.example/sub",
        subUrl: "https://one.example/sub",
        label: "One",
      })
      .returning()
      .get();
    const second = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://two.example/sub",
        subUrl: "https://two.example/sub",
        label: "Two",
      })
      .returning()
      .get();
    let releaseFirst: (() => void) | undefined;
    const calls: number[] = [];
    const coordinator = new SourceRefreshCoordinator({
      db,
      refresh: async (id) => {
        calls.push(id);
        if (id === first.id) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return sourceResult(id, null);
      },
    });

    const running = coordinator.refresh(first.id, "scheduled");
    const queued = coordinator.refresh(second.id, "scheduled");
    await vi.waitFor(() => expect(calls).toEqual([first.id]));
    db.update(sources).set({ enabled: false }).where(eq(sources.id, second.id)).run();
    releaseFirst?.();

    await running;
    await expect(queued).rejects.toBeInstanceOf(SourceRefreshSkippedError);
    expect(calls).toEqual([first.id]);
    expect(db.select().from(sources).where(eq(sources.id, second.id)).get()).toMatchObject({
      lastRefreshAttemptAt: null,
      refreshFailures: 0,
    });
  });

  it("upgrades a queued scheduled refresh when enabling the disabled source", async () => {
    const db = freshDb();
    const first = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://one.example/sub",
        subUrl: "https://one.example/sub",
        label: "One",
      })
      .returning()
      .get();
    const second = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://two.example/sub",
        subUrl: "https://two.example/sub",
        label: "Two",
      })
      .returning()
      .get();
    let releaseFirst: (() => void) | undefined;
    const calls: number[] = [];
    const coordinator = new SourceRefreshCoordinator({
      db,
      refresh: async (id) => {
        calls.push(id);
        if (id === first.id) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return sourceResult(id, null);
      },
    });

    const running = coordinator.refresh(first.id, "scheduled");
    const queuedScheduled = coordinator.refresh(second.id, "scheduled");
    await vi.waitFor(() => expect(calls).toEqual([first.id]));
    db.update(sources).set({ enabled: false }).where(eq(sources.id, second.id)).run();
    const queuedEnable = coordinator.refresh(second.id, "enable");
    releaseFirst?.();

    await running;
    await expect(Promise.all([queuedScheduled, queuedEnable])).resolves.toHaveLength(2);
    expect(calls).toEqual([first.id, second.id]);
  });
});
