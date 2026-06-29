import { on } from "node:events";
import type { LiveEvent } from "@submerge/shared";
import { tracked } from "@trpc/server";
import { publicProcedure, router } from "../trpc/trpc.js";
import { LIVE_EVENT, type LiveHub } from "./hub.js";

// Monotonic SSE event id so reconnecting clients can resume via Last-Event-ID.
let seq = 0;

/**
 * Consumer-facing shape of a tracked() SSE message: a stable `id` (for
 * Last-Event-ID resume) plus the `data` payload.
 *
 * We declare this nameable type and pin the generator's yield to it so the
 * inferred router type stays portable in the emitted `.d.ts`. tRPC's own
 * `tracked()` flows through an internal `TrackedData` type that it only
 * re-exports from an `unstable-*` deep path, which trips TS2883/TS4023 under
 * `declaration: true`. At runtime we still yield real `tracked()` envelopes
 * (cast below); the SSE producer reads id+data from them identically.
 */
export interface TrackedLiveEvent {
  id: string;
  data: LiveEvent;
}

function trackEvent(event: LiveEvent): TrackedLiveEvent {
  // Real envelope at runtime (3-tuple the SSE producer understands); the public
  // type is the nameable {id,data} view so the router signature stays portable.
  return tracked(String(seq++), event) as unknown as TrackedLiveEvent;
}

async function* streamEvents(
  hub: LiveHub,
  signal: AbortSignal | undefined,
): AsyncGenerator<TrackedLiveEvent> {
  // Replay current state so a fresh subscriber is never blank.
  for (const e of hub.snapshot()) yield trackEvent(e);
  // Then forward live events until the client disconnects (signal).
  for await (const [evt] of on(hub.emitter, LIVE_EVENT, { signal })) {
    yield trackEvent(evt as LiveEvent);
  }
}

export function makeLiveRouter(hub: LiveHub) {
  return router({
    stream: publicProcedure.subscription((opts) => streamEvents(hub, opts.signal)),
  });
}
