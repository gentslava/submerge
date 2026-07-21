import type { Source, SourceKind, SubscriptionMeta } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { HappDecoderError } from "../../clients/happDecoder.js";
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

export type SourceRefreshTrigger = "manual" | "scheduled" | "enable";
export type SourceRefreshStage =
  | "fetch"
  | "decode"
  | "validate"
  | "database"
  | "config-write"
  | "unknown";

export class SourceRefreshStageError extends Error {
  readonly stage: SourceRefreshStage;

  constructor(stage: SourceRefreshStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : "source refresh failed", { cause });
    this.name = "SourceRefreshStageError";
    this.stage = stage;
  }
}

export class SourceRefreshSkippedError extends Error {
  constructor(sourceId: number) {
    super(`scheduled refresh skipped for disabled source ${sourceId}`);
    this.name = "SourceRefreshSkippedError";
  }
}

export interface SourceRefreshResult {
  source: Source;
  applied: boolean;
}

export interface SourceRefreshFailureEvent {
  sourceId: number;
  kind: SourceKind;
  trigger: SourceRefreshTrigger;
  stage: SourceRefreshStage;
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

interface InFlightRefresh {
  request: { trigger: SourceRefreshTrigger };
  promise: Promise<SourceRefreshResult>;
}

function strongerRefreshTrigger(
  current: SourceRefreshTrigger,
  incoming: SourceRefreshTrigger,
): SourceRefreshTrigger {
  const priority: Record<SourceRefreshTrigger, number> = { scheduled: 0, manual: 1, enable: 2 };
  return priority[incoming] > priority[current] ? incoming : current;
}

function errorChain(error: unknown): { names: string; messages: string; codes: string[] } {
  const names: string[] = [];
  const messages: string[] = [];
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current instanceof Error) {
      names.push(current.name.toLowerCase());
      messages.push(current.message.toLowerCase());
    }
    const value = current as { cause?: unknown; code?: unknown };
    if (typeof value.code === "string") codes.push(value.code.toUpperCase());
    current = value.cause;
  }
  return { names: names.join(" "), messages: messages.join(" "), codes };
}

function findHappDecoderError(error: unknown): HappDecoderError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current instanceof HappDecoderError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function sourceRefreshErrorCategory(error: unknown): string {
  const details = errorChain(error);
  const decoderError = findHappDecoderError(error);
  if (decoderError?.kind === "response") return "invalid-content";
  if (decoderError?.kind === "decode") return "decoder";
  if (details.codes.some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN")) return "dns";
  if (
    details.codes.some(
      (code) => code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET",
    )
  )
    return "connection-reset";
  if (details.codes.includes("ECONNREFUSED")) return "connection-refused";
  if (
    details.codes.some(
      (code) =>
        code.startsWith("ERR_TLS") ||
        code.startsWith("CERT_") ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    )
  )
    return "tls";
  if (
    details.names.includes("timeout") ||
    details.names.includes("abort") ||
    details.messages.includes("timeout") ||
    details.codes.some((code) => code.includes("TIMEOUT"))
  )
    return "timeout";
  const httpStatus = /\bhttp\s+(\d{3})\b/.exec(details.messages)?.[1];
  if (httpStatus) return `http-${httpStatus}`;
  if (decoderError?.kind === "transport") return "network";
  if (
    details.messages.includes("no nodes") ||
    details.messages.includes("no active nodes") ||
    details.messages.includes("not recognized") ||
    details.messages.includes("invalid") ||
    details.messages.includes("empty")
  )
    return "invalid-content";
  if (details.messages.includes("decode")) return "decoder";
  const stage = error instanceof SourceRefreshStageError ? error.stage : "unknown";
  if (stage === "fetch") return "network";
  if (stage === "decode") return "decoder";
  if (stage === "validate") return "invalid-content";
  if (stage === "config-write") {
    if (details.codes.some((code) => code === "EACCES" || code === "EPERM"))
      return "permission-denied";
    if (details.codes.includes("ENOSPC")) return "disk-full";
    return "config-write";
  }
  if (stage === "database") return "database";
  return "refresh-failed";
}

export class SourceRefreshCoordinator {
  private readonly db: Db;
  private readonly performRefresh: (sourceId: number) => Promise<SourceRefreshResult>;
  private readonly now: () => number;
  private readonly onFailure: ((event: SourceRefreshFailureEvent) => void) | undefined;
  private readonly inFlight = new Map<number, InFlightRefresh>();
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: SourceRefreshCoordinatorDeps) {
    this.db = deps.db;
    this.performRefresh = deps.refresh;
    this.now = deps.now ?? Date.now;
    this.onFailure = deps.onFailure;
  }

  refresh(sourceId: number, trigger: SourceRefreshTrigger): Promise<SourceRefreshResult> {
    const existing = this.inFlight.get(sourceId);
    if (existing) {
      existing.request.trigger = strongerRefreshTrigger(existing.request.trigger, trigger);
      return existing.promise;
    }

    const request = { trigger };
    const task = this.enqueue(() => this.run(sourceId, request.trigger));
    this.inFlight.set(sourceId, { request, promise: task });
    void task.then(
      () => {
        if (this.inFlight.get(sourceId)?.promise === task) this.inFlight.delete(sourceId);
      },
      () => {
        if (this.inFlight.get(sourceId)?.promise === task) this.inFlight.delete(sourceId);
      },
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
    if (trigger === "scheduled" && !row.enabled) throw new SourceRefreshSkippedError(sourceId);

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
      const stage = error instanceof SourceRefreshStageError ? error.stage : "unknown";
      const category = sourceRefreshErrorCategory(error);
      this.db
        .update(sources)
        .set({
          nextRefreshAttemptAt: nextAttemptAt,
          refreshFailures: consecutiveFailures,
          lastRefreshError: `${stage}:${category}`,
        })
        .where(eq(sources.id, sourceId))
        .run();
      this.onFailure?.({
        sourceId,
        kind: row.kind as SourceKind,
        trigger,
        stage,
        category,
        consecutiveFailures,
        nextAttemptAt,
      });
      throw error;
    }
  }
}
