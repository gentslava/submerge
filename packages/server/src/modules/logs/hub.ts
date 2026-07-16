import { EventEmitter, on } from "node:events";
import type {
  LogEvent,
  LogLevel,
  LogSource,
  LogStreamMessage,
  LogUpstreamState,
} from "@submerge/shared";

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
}

type SnapshotMessage = Extract<LogStreamMessage, { type: "snapshot" }>;
type StatusMessage = Extract<LogStreamMessage, { type: "status" }>;
type ClearMessage = Extract<LogStreamMessage, { type: "clear" }>;

export class LogHub {
  readonly emitter = new EventEmitter();
  private readonly now: () => Date;
  private readonly events: LogEvent[] = [];
  private sequence = 0;
  private upstream: LogUpstreamState = "connecting";
  private nextRetryAt: string | null = null;

  constructor(deps: LogHubDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.emitter.setMaxListeners(0);
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
}
