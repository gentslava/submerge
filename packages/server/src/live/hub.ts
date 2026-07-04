import { EventEmitter } from "node:events";
import type { LiveEvent, NodeView, TrafficSample } from "@submerge/shared";

// Event name on the emitter — shared with the SSE router (Task 5) so a typo
// can't silently break the fan-out.
export const LIVE_EVENT = "event";

export interface HubDeps {
  fetchView: () => Promise<NodeView>;
  streamTraffic: (signal: AbortSignal) => AsyncGenerator<TrafficSample>;
  getInterval: () => number; // ms between /proxies polls (settings-driven)
  // Cumulative received/sent byte totals (from /connections). Optional — when set,
  // the hub emits a `totals` event each poll for the active-node "принято/отдано".
  fetchTotals?: () => Promise<{ up: number; down: number }>;
  // Runs once per successful poll AFTER the nodeUpdate emit, with the fresh view.
  // Best-effort: the hub swallows its errors so an active controller can never
  // break live polling. Used by the channel controller to pin/switch nodes.
  afterView?: (view: NodeView) => Promise<void>;
  // Observability for the otherwise-swallowed failure paths. Called once per
  // outage streak (first poll failure / first traffic-stream failure), not per
  // retry — safe to wire straight to a logger without flooding it.
  onError?: (scope: "poll" | "traffic", err: unknown) => void;
}

export class LiveHub {
  readonly emitter = new EventEmitter();
  private deps: HubDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trafficAbort: AbortController | null = null;
  private lastView: NodeView | null = null;
  private lastHealth = false;
  private lastTotals: { up: number; down: number } | null = null;
  // NOT derivable from lastHealth: that starts false, so a cold boot against a
  // down engine would never report its first (and only logged) poll failure.
  private pollErrorReported = false;

  constructor(deps: HubDeps) {
    this.deps = deps;
    this.emitter.setMaxListeners(0); // many subscribers; cleanup is via signals
  }

  // Current state for a freshly-connected subscriber (no waiting for next poll).
  snapshot(): LiveEvent[] {
    const out: LiveEvent[] = [{ type: "health", mihomo: this.lastHealth }];
    if (this.lastView) out.push({ type: "nodeUpdate", view: this.lastView });
    if (this.lastTotals) {
      out.push({ type: "totals", up: this.lastTotals.up, down: this.lastTotals.down });
    }
    return out;
  }

  private emit(e: LiveEvent): void {
    this.emitter.emit(LIVE_EVENT, e);
  }

  async pollOnce(): Promise<void> {
    try {
      const view = await this.deps.fetchView();
      this.pollErrorReported = false;
      this.lastView = view;
      this.setHealth(true);
      this.emit({ type: "nodeUpdate", view });
      if (this.deps.afterView) {
        try {
          await this.deps.afterView(view);
        } catch {
          /* controller error — must not affect health or abort the poll */
        }
      }
      // Cumulative byte totals — best-effort, must not affect health or abort the poll.
      if (this.deps.fetchTotals) {
        try {
          const totals = await this.deps.fetchTotals();
          this.lastTotals = totals;
          this.emit({ type: "totals", up: totals.up, down: totals.down });
        } catch {
          /* /connections unavailable — keep last known totals */
        }
      }
    } catch (err) {
      if (!this.pollErrorReported) {
        this.pollErrorReported = true;
        this.deps.onError?.("poll", err);
      }
      this.setHealth(false);
    }
  }

  private setHealth(ok: boolean): void {
    this.lastHealth = ok;
    this.emit({ type: "health", mihomo: ok });
  }

  private scheduleNext(): void {
    this.timer = setTimeout(async () => {
      await this.pollOnce();
      if (this.timer !== null) this.scheduleNext(); // re-arm unless stopped
    }, this.deps.getInterval());
  }

  private async pumpTraffic(): Promise<void> {
    // Snapshot the controller for this pump's lifetime: a stop()→start() during
    // the retry sleep installs a NEW controller, and this generation must exit
    // rather than re-enter on it (avoids two concurrent pumps / duplicate events).
    const ctrl = this.trafficAbort;
    // A stream must LIVE this long to count as healthy. Resetting the backoff on
    // the first sample instead would let a flapping stream (one frame, then drop)
    // re-arm both the error report and the 1 s retry every cycle.
    const STABLE_STREAM_MS = 30_000;
    let failures = 0;
    while (this.trafficAbort === ctrl && ctrl !== null) {
      const startedAt = Date.now();
      try {
        for await (const s of this.deps.streamTraffic(ctrl.signal)) {
          this.emit({ type: "traffic", up: s.up, down: s.down });
        }
      } catch (err) {
        // stop() aborts the in-flight stream — a clean shutdown, not a failure.
        if (!ctrl.signal.aborted && failures === 0) this.deps.onError?.("traffic", err);
      }
      failures = Date.now() - startedAt >= STABLE_STREAM_MS ? 0 : failures + 1;
      // Retry with capped exponential backoff (1 s → 30 s) so a persistent
      // failure (wrong secret, engine gone) doesn't hot-loop every second.
      const delayMs = failures === 0 ? 1000 : Math.min(1000 * 2 ** (failures - 1), 30_000);
      if (this.trafficAbort === ctrl) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  start(): void {
    if (this.timer !== null) return; // already running
    void this.pollOnce();
    this.scheduleNext();
    this.trafficAbort = new AbortController();
    void this.pumpTraffic();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.trafficAbort?.abort();
    this.trafficAbort = null;
  }
}
