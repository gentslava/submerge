import type { Source } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { SourceRefreshScheduler, startSchedulerAfter } from "./scheduler.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}

function result(id: number): { source: Source; applied: boolean } {
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
      meta: null,
      updatedAt: "2026-07-21 12:00:00",
      createdAt: "2026-07-20 12:00:00",
    },
    applied: true,
  };
}

afterEach(() => vi.useRealTimers());

describe("SourceRefreshScheduler", () => {
  it("does not start after its prerequisite settles when shutdown was requested", async () => {
    let resolvePrerequisite: (() => void) | undefined;
    const prerequisite = new Promise<void>((resolve) => (resolvePrerequisite = resolve));
    const scheduler = { start: vi.fn() };
    const shutdown = new AbortController();

    const starting = startSchedulerAfter(prerequisite, scheduler, shutdown.signal);
    shutdown.abort();
    resolvePrerequisite?.();
    await starting;
    expect(scheduler.start).not.toHaveBeenCalled();

    await startSchedulerAfter(Promise.resolve(), scheduler, new AbortController().signal);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
  });

  it("restores missing schedules and refreshes overdue subscriptions in due/id order", async () => {
    const db = freshDb();
    const a = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://a.example/sub",
        subUrl: "https://a.example/sub",
        label: "A",
        meta: { used: null, total: null, expire: null, updateHours: 2 },
        updatedAt: "2026-07-21 08:00:00",
      })
      .returning()
      .get();
    const b = db
      .insert(sources)
      .values({
        kind: "happ",
        value: "happ://crypt5/b",
        label: "B",
        meta: { used: null, total: null, expire: null, updateHours: 1 },
        updatedAt: "2026-07-21 07:00:00",
      })
      .returning()
      .get();
    const disabled = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://disabled.example/sub",
        subUrl: "https://disabled.example/sub",
        label: "Disabled",
        enabled: false,
        meta: { used: null, total: null, expire: null, updateHours: 2 },
        updatedAt: "2026-07-21 08:00:00",
        nextRefreshAttemptAt: 1_000,
      })
      .returning()
      .get();
    const future = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://future.example/sub",
        subUrl: "https://future.example/sub",
        label: "Future",
        meta: { used: null, total: null, expire: null, updateHours: 6 },
        updatedAt: "2026-07-21 11:00:00",
      })
      .returning()
      .get();
    const inline = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "proxies:\n  - {name: Inline, type: vless, server: node.example, port: 443}",
        label: "Inline",
        updatedAt: "2026-07-20 00:00:00",
      })
      .returning()
      .get();
    const vless = db
      .insert(sources)
      .values({
        kind: "vless",
        value: "vless://id@node.example:443#Manual",
        label: "Manual",
        updatedAt: "2026-07-20 00:00:00",
      })
      .returning()
      .get();
    const calls: number[] = [];
    const coordinator = {
      refresh: vi.fn(async (id: number) => {
        calls.push(id);
        if (id === b.id) throw new Error("provider failed");
        return result(id);
      }),
    };
    const now = Date.UTC(2026, 6, 21, 12, 0, 0);
    const scheduler = new SourceRefreshScheduler({ db, coordinator, now: () => now });

    await scheduler.runOnce();

    expect(calls).toEqual([b.id, a.id]);
    const rows = db.select().from(sources).all();
    expect(rows.find((row) => row.id === b.id)?.nextRefreshAttemptAt).toBe(
      Date.UTC(2026, 6, 21, 8, 0, 0),
    );
    expect(rows.find((row) => row.id === a.id)?.nextRefreshAttemptAt).toBe(
      Date.UTC(2026, 6, 21, 10, 0, 0),
    );
    expect(rows.find((row) => row.id === disabled.id)?.nextRefreshAttemptAt).toBe(1_000);
    expect(rows.find((row) => row.id === future.id)?.nextRefreshAttemptAt).toBe(
      Date.UTC(2026, 6, 21, 17, 0, 0),
    );
    expect(rows.find((row) => row.id === vless.id)?.nextRefreshAttemptAt).toBeNull();
    expect(rows.find((row) => row.id === inline.id)?.nextRefreshAttemptAt).toBeNull();
  });

  it("joins overlapping pulses", async () => {
    const db = freshDb();
    const row = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://provider.example/sub",
        subUrl: "https://provider.example/sub",
        label: "Provider",
        nextRefreshAttemptAt: 1_000,
      })
      .returning()
      .get();
    let release: (() => void) | undefined;
    const coordinator = {
      refresh: vi.fn(async (id: number) => {
        await new Promise<void>((resolve) => (release = resolve));
        return result(id);
      }),
    };
    const scheduler = new SourceRefreshScheduler({ db, coordinator, now: () => 2_000 });

    const first = scheduler.runOnce();
    const overlapping = scheduler.runOnce();
    await vi.waitFor(() => expect(coordinator.refresh).toHaveBeenCalledTimes(1));
    release?.();
    await Promise.all([first, overlapping]);
    expect(coordinator.refresh).toHaveBeenCalledWith(row.id, "scheduled");
  });

  it("runs immediately on start and stop cancels later pulses", async () => {
    vi.useFakeTimers();
    const db = freshDb();
    db.insert(sources)
      .values({
        kind: "sub",
        value: "https://provider.example/sub",
        subUrl: "https://provider.example/sub",
        label: "Provider",
        nextRefreshAttemptAt: 1_000,
      })
      .run();
    const coordinator = { refresh: vi.fn(async (id: number) => result(id)) };
    const scheduler = new SourceRefreshScheduler({
      db,
      coordinator,
      now: () => 2_000,
      pulseMs: 60_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.refresh).toHaveBeenCalledTimes(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(coordinator.refresh).toHaveBeenCalledTimes(1);
  });

  it("waits for the active refresh and starts no later due row while stopping", async () => {
    vi.useFakeTimers();
    const db = freshDb();
    const first = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://one.example/sub",
        subUrl: "https://one.example/sub",
        label: "One",
        nextRefreshAttemptAt: 1_000,
      })
      .returning()
      .get();
    db.insert(sources)
      .values({
        kind: "sub",
        value: "https://two.example/sub",
        subUrl: "https://two.example/sub",
        label: "Two",
        nextRefreshAttemptAt: 1_000,
      })
      .run();
    let releaseFirst: (() => void) | undefined;
    const calls: number[] = [];
    const coordinator = {
      refresh: vi.fn(async (id: number) => {
        calls.push(id);
        if (id === first.id) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return result(id);
      }),
    };
    const scheduler = new SourceRefreshScheduler({
      db,
      coordinator,
      now: () => 2_000,
      pulseMs: 60_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = scheduler.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseFirst?.();
    await stopping;
    expect(calls).toEqual([first.id]);
  });

  it("reports unexpected execution failures", async () => {
    vi.useFakeTimers();
    const db = freshDb();
    const onError = vi.fn();
    const scheduler = new SourceRefreshScheduler({
      db,
      coordinator: { refresh: vi.fn() },
      onError,
    });
    db.$client.close();

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("does not start another due refresh after stop and resumes cleanly on restart", async () => {
    vi.useFakeTimers();
    const db = freshDb();
    const first = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://one.example/sub",
        subUrl: "https://one.example/sub",
        label: "One",
        nextRefreshAttemptAt: 1_000,
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
        nextRefreshAttemptAt: 1_000,
      })
      .returning()
      .get();
    let releaseFirst: (() => void) | undefined;
    const calls: number[] = [];
    const coordinator = {
      refresh: vi.fn(async (id: number) => {
        calls.push(id);
        if (id === first.id) {
          await new Promise<void>((resolve) => (releaseFirst = resolve));
          db.update(sources)
            .set({ nextRefreshAttemptAt: 10_000 })
            .where(eq(sources.id, second.id))
            .run();
        }
        db.update(sources).set({ nextRefreshAttemptAt: 10_000 }).where(eq(sources.id, id)).run();
        return result(id);
      }),
    };
    const scheduler = new SourceRefreshScheduler({
      db,
      coordinator,
      now: () => 2_000,
      pulseMs: 60_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([first.id]);

    scheduler.stop();
    scheduler.start();
    const newlyDue = db
      .insert(sources)
      .values({
        kind: "sub",
        value: "https://new.example/sub",
        subUrl: "https://new.example/sub",
        label: "New",
        nextRefreshAttemptAt: 1_000,
      })
      .returning()
      .get();
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(calls).toEqual([first.id, newlyDue.id]));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([first.id, newlyDue.id]);
    scheduler.stop();
  });
});
