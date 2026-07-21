import type { SourceKind } from "@submerge/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import {
  effectiveRefreshIntervalMs,
  isRefreshableSource,
  type SourceRefreshCoordinator,
} from "./refresh.js";

export const SOURCE_REFRESH_PULSE_MS = 60_000;

interface SourceRefreshSchedulerDeps {
  db: Db;
  coordinator: Pick<SourceRefreshCoordinator, "refresh">;
  now?: () => number;
  pulseMs?: number;
  onError?: (error: unknown) => void;
}

interface SchedulerStarter {
  start(): void;
}

export async function startSchedulerAfter(
  prerequisite: Promise<unknown>,
  scheduler: SchedulerStarter,
  shutdownSignal: AbortSignal,
): Promise<void> {
  await prerequisite;
  if (!shutdownSignal.aborted) scheduler.start();
}

function storedTimestampMs(value: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export class SourceRefreshScheduler {
  private readonly db: Db;
  private readonly coordinator: Pick<SourceRefreshCoordinator, "refresh">;
  private readonly now: () => number;
  private readonly pulseMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentRun: { generation: number | null; promise: Promise<void> } | null = null;
  private generation = 0;

  constructor(deps: SourceRefreshSchedulerDeps) {
    this.db = deps.db;
    this.coordinator = deps.coordinator;
    this.now = deps.now ?? Date.now;
    this.pulseMs = deps.pulseMs ?? SOURCE_REFRESH_PULSE_MS;
    this.onError = deps.onError;
  }

  runOnce(): Promise<void> {
    return this.run(null);
  }

  private run(generation: number | null): Promise<void> {
    const current = this.currentRun;
    if (current) {
      if (generation === null || current.generation === generation) return current.promise;
      const runAfterCurrent = () => {
        if (generation !== this.generation || this.timer === null) return Promise.resolve();
        return this.run(generation);
      };
      return current.promise.then(runAfterCurrent, runAfterCurrent);
    }

    const task = this.execute(generation);
    this.currentRun = { generation, promise: task };
    void task.then(
      () => {
        if (this.currentRun?.promise === task) this.currentRun = null;
      },
      () => {
        if (this.currentRun?.promise === task) this.currentRun = null;
      },
    );
    return task;
  }

  start(): void {
    if (this.timer !== null) return;
    const generation = ++this.generation;
    void this.run(generation).catch((error) => this.reportError(error));
    this.scheduleNext(generation);
  }

  async stop(): Promise<void> {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.currentRun?.promise.catch(() => undefined);
  }

  private scheduleNext(generation: number): void {
    this.timer = setTimeout(async () => {
      await this.run(generation).catch((error) => this.reportError(error));
      if (this.timer !== null && this.generation === generation) this.scheduleNext(generation);
    }, this.pulseMs);
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Error reporting must not create a rejected background task.
    }
  }

  private async execute(generation: number | null): Promise<void> {
    const now = this.now();
    const rows = this.db.select().from(sources).all();
    for (const row of rows) {
      if (
        row.nextRefreshAttemptAt !== null ||
        !isRefreshableSource(row.kind as SourceKind, row.subUrl)
      )
        continue;
      const snapshotAt = storedTimestampMs(row.updatedAt) ?? now;
      this.db
        .update(sources)
        .set({ nextRefreshAttemptAt: snapshotAt + effectiveRefreshIntervalMs(row.meta ?? null) })
        .where(eq(sources.id, row.id))
        .run();
    }

    const due = this.db
      .select()
      .from(sources)
      .all()
      .filter(
        (row) =>
          isRefreshableSource(row.kind as SourceKind, row.subUrl) &&
          row.nextRefreshAttemptAt !== null &&
          row.nextRefreshAttemptAt <= now,
      )
      .sort(
        (a, b) =>
          (a.nextRefreshAttemptAt as number) - (b.nextRefreshAttemptAt as number) || a.id - b.id,
      );

    for (const row of due) {
      if (generation !== null && generation !== this.generation) return;
      try {
        await this.coordinator.refresh(row.id, "scheduled");
      } catch {
        // The coordinator persists sanitized failure/backoff state. One provider
        // must not prevent other due subscriptions from refreshing this pulse.
      }
    }
  }
}
