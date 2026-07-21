import type { Source, SourceKind, SubscriptionMeta } from "@submerge/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sources } from "../../db/schema.js";

const HOUR_MS = 60 * 60 * 1000;

export const MIN_REFRESH_INTERVAL_MS = HOUR_MS;
export const DEFAULT_REFRESH_INTERVAL_MS = 24 * HOUR_MS;
export const MAX_REFRESH_BACKOFF_MS = 6 * HOUR_MS;

export function effectiveRefreshIntervalMs(
  meta: Pick<SubscriptionMeta, "updateHours"> | null,
): number {
  const providerInterval = meta?.updateHours;
  if (providerInterval == null || !Number.isFinite(providerInterval) || providerInterval <= 0) {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
  return Math.max(providerInterval * HOUR_MS, MIN_REFRESH_INTERVAL_MS);
}

export function refreshBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.trunc(consecutiveFailures) - 1);
  return Math.min(5 * 60 * 1000 * 3 ** exponent, MAX_REFRESH_BACKOFF_MS);
}

export function isRefreshableSource(kind: SourceKind, subUrl: string | null): boolean {
  return kind === "happ" || (kind === "sub" && subUrl !== null);
}

export type SourceRefreshTrigger = "manual" | "scheduled";

export interface SourceRefreshResult {
  source: Source;
  applied: boolean;
}

export interface SourceRefreshFailureEvent {
  sourceId: number;
  kind: SourceKind;
  trigger: SourceRefreshTrigger;
  category: string;
  consecutiveFailures: number;
  nextAttemptAt: number | null;
}

interface SourceRefreshCoordinatorDeps {
  db: Db;
  refresh: (sourceId: number) => Promise<SourceRefreshResult>;
  now?: () => number;
  onFailure?: (event: SourceRefreshFailureEvent) => void;
}

function refreshErrorCategory(error: unknown): string {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const httpStatus = /\bhttp\s+(\d{3})\b/.exec(message)?.[1];
  if (httpStatus) return `http-${httpStatus}`;
  if (name.includes("timeout") || message.includes("timeout")) return "timeout";
  if (message.includes("decode")) return "decoder";
  if (
    message.includes("no nodes") ||
    message.includes("not recognized") ||
    message.includes("invalid") ||
    message.includes("empty")
  )
    return "invalid-content";
  return "refresh-failed";
}

export class SourceRefreshCoordinator {
  private readonly db: Db;
  private readonly performRefresh: (sourceId: number) => Promise<SourceRefreshResult>;
  private readonly now: () => number;
  private readonly onFailure: ((event: SourceRefreshFailureEvent) => void) | undefined;
  private readonly inFlight = new Map<number, Promise<SourceRefreshResult>>();
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: SourceRefreshCoordinatorDeps) {
    this.db = deps.db;
    this.performRefresh = deps.refresh;
    this.now = deps.now ?? Date.now;
    this.onFailure = deps.onFailure;
  }

  refresh(sourceId: number, trigger: SourceRefreshTrigger): Promise<SourceRefreshResult> {
    const existing = this.inFlight.get(sourceId);
    if (existing) return existing;

    const task = this.enqueue(() => this.run(sourceId, trigger));
    this.inFlight.set(sourceId, task);
    void task.then(
      () => this.inFlight.delete(sourceId),
      () => this.inFlight.delete(sourceId),
    );
    return task;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation);
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async run(sourceId: number, trigger: SourceRefreshTrigger): Promise<SourceRefreshResult> {
    const row = this.db.select().from(sources).where(eq(sources.id, sourceId)).get();
    if (!row) throw new Error(`source ${sourceId} not found`);

    const attemptedAt = this.now();
    this.db
      .update(sources)
      .set({ lastRefreshAttemptAt: attemptedAt })
      .where(eq(sources.id, sourceId))
      .run();

    try {
      const result = await this.performRefresh(sourceId);
      const succeededAt = this.now();
      const nextAttemptAt = isRefreshableSource(row.kind as SourceKind, row.subUrl)
        ? succeededAt + effectiveRefreshIntervalMs(result.source.meta)
        : null;
      this.db
        .update(sources)
        .set({
          lastRefreshSuccessAt: succeededAt,
          nextRefreshAttemptAt: nextAttemptAt,
          refreshFailures: 0,
          lastRefreshError: null,
        })
        .where(eq(sources.id, sourceId))
        .run();
      return result;
    } catch (error) {
      const failedAt = this.now();
      const consecutiveFailures = row.refreshFailures + 1;
      const nextAttemptAt = isRefreshableSource(row.kind as SourceKind, row.subUrl)
        ? failedAt + refreshBackoffMs(consecutiveFailures)
        : null;
      const category = refreshErrorCategory(error);
      this.db
        .update(sources)
        .set({
          nextRefreshAttemptAt: nextAttemptAt,
          refreshFailures: consecutiveFailures,
          lastRefreshError: category,
        })
        .where(eq(sources.id, sourceId))
        .run();
      this.onFailure?.({
        sourceId,
        kind: row.kind as SourceKind,
        trigger,
        category,
        consecutiveFailures,
        nextAttemptAt,
      });
      throw error;
    }
  }
}
