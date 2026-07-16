import { EventEmitter, on } from "node:events";
import type {
  LogEvent,
  LogLevel,
  LogSource,
  LogStreamMessage,
  LogUpstreamState,
} from "@submerge/shared";
import type { MihomoLogFrame } from "../../clients/mihomo.js";

export const LOG_CAPACITY = 500;
export const LOG_STREAM_EVENT = "message";

export interface LogDraft {
  source: LogSource;
  level: LogLevel;
  message: string;
  fields?: Record<string, string | number | boolean>;
}

interface LogHubDeps {
  now?: () => Date;
  openLogStream?: (signal: AbortSignal) => Promise<AsyncGenerator<MihomoLogFrame>>;
}

type SnapshotMessage = Extract<LogStreamMessage, { type: "snapshot" }>;
type StatusMessage = Extract<LogStreamMessage, { type: "status" }>;
type ClearMessage = Extract<LogStreamMessage, { type: "clear" }>;

export class LogHub {
  readonly emitter = new EventEmitter();
  private readonly now: () => Date;
  private readonly openLogStream?: LogHubDeps["openLogStream"];
  private readonly events: LogEvent[] = [];
  private sequence = 0;
  private upstream: LogUpstreamState = "connecting";
  private nextRetryAt: string | null = null;
  private captureAbort: AbortController | null = null;

  constructor(deps: LogHubDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.openLogStream = deps.openLogStream;
    this.emitter.setMaxListeners(0);
  }

  start(): void {
    if (this.captureAbort) return;
    if (!this.openLogStream) throw new Error("LogHub requires openLogStream to start capture");
    const controller = new AbortController();
    this.captureAbort = controller;
    this.setUpstream("connecting", null);
    void this.pump(controller);
  }

  stop(): void {
    const controller = this.captureAbort;
    if (!controller) return;
    this.captureAbort = null;
    controller.abort();
    this.setUpstream("connecting", null);
  }

  push(draft: LogDraft): LogEvent {
    const cursor = this.nextCursor();
    const event: LogEvent = {
      ...draft,
      id: cursor,
      time: this.now().toISOString(),
    };
    this.events.push(event);
    if (this.events.length > LOG_CAPACITY) this.events.splice(0, this.events.length - LOG_CAPACITY);
    this.emit({ type: "append", cursor, event });
    return event;
  }

  snapshot(): SnapshotMessage {
    return {
      type: "snapshot",
      cursor: this.sequence,
      upstream: this.upstream,
      nextRetryAt: this.nextRetryAt,
      events: [...this.events],
    };
  }

  clear(): ClearMessage {
    const cursor = this.nextCursor();
    this.events.length = 0;
    const message: ClearMessage = { type: "clear", cursor };
    this.emit(message);
    return message;
  }

  setUpstream(upstream: LogUpstreamState, nextRetryAt: string | null): StatusMessage | null {
    if ((upstream === "reconnecting") !== (nextRetryAt !== null)) {
      throw new Error("nextRetryAt is required only while reconnecting");
    }
    if (this.upstream === upstream && this.nextRetryAt === nextRetryAt) return null;

    this.upstream = upstream;
    this.nextRetryAt = nextRetryAt;
    const message: StatusMessage = {
      type: "status",
      cursor: this.nextCursor(),
      upstream,
      nextRetryAt,
    };
    this.emit(message);
    return message;
  }

  async *messages(signal?: AbortSignal): AsyncGenerator<LogStreamMessage> {
    if (signal?.aborted) return;
    const live = signal
      ? on(this.emitter, LOG_STREAM_EVENT, { signal })
      : on(this.emitter, LOG_STREAM_EVENT);
    try {
      yield this.snapshot();
      for await (const [message] of live) yield message as LogStreamMessage;
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    } finally {
      await live.return?.();
    }
  }

  private nextCursor(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private emit(message: LogStreamMessage): void {
    this.emitter.emit(LOG_STREAM_EVENT, message);
  }

  private async pump(controller: AbortController): Promise<void> {
    const openLogStream = this.openLogStream;
    if (!openLogStream) return;
    const stableStreamMs = 30_000;
    let failures = 0;

    while (this.captureAbort === controller && !controller.signal.aborted) {
      this.setUpstream("connecting", null);
      let openedAt: number | null = null;
      try {
        const stream = await openLogStream(controller.signal);
        if (this.captureAbort !== controller || controller.signal.aborted) return;
        openedAt = this.now().getTime();
        this.setUpstream("live", null);
        for await (const frame of stream) {
          if (this.captureAbort !== controller || controller.signal.aborted) return;
          this.push({ source: "mihomo", ...frame });
        }
      } catch {
        // A failed open/read is handled by the same reconnect path as clean EOF.
        // stop() aborts the generation and is intentionally not surfaced as an outage.
        if (this.captureAbort !== controller || controller.signal.aborted) return;
      }

      if (this.captureAbort !== controller || controller.signal.aborted) return;
      if (openedAt !== null && this.now().getTime() - openedAt >= stableStreamMs) failures = 0;
      failures += 1;
      const delayMs = Math.min(1000 * 2 ** (failures - 1), 30_000);
      const nextRetryAt = new Date(this.now().getTime() + delayMs).toISOString();
      this.setUpstream("reconnecting", nextRetryAt);
      await waitForRetry(delayMs, controller.signal);
    }
  }
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
  });
}
