import { EventEmitter } from "node:events";
import type { LiveEvent, NodeView, TrafficSample } from "@submerge/shared";

// Event name on the emitter — shared with the SSE router (Task 5) so a typo
// can't silently break the fan-out.
export const LIVE_EVENT = "event";

export interface HubDeps {
  fetchView: () => Promise<NodeView>;
  streamTraffic: (signal: AbortSignal) => AsyncGenerator<TrafficSample>;
  getInterval: () => number; // ms between /proxies polls (settings-driven)
}

export class LiveHub {
  readonly emitter = new EventEmitter();
  private deps: HubDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trafficAbort: AbortController | null = null;
  private lastView: NodeView | null = null;
  private lastHealth = false;

  constructor(deps: HubDeps) {
    this.deps = deps;
    this.emitter.setMaxListeners(0); // many subscribers; cleanup is via signals
  }

  // Current state for a freshly-connected subscriber (no waiting for next poll).
  snapshot(): LiveEvent[] {
    const out: LiveEvent[] = [{ type: "health", mihomo: this.lastHealth }];
    if (this.lastView) out.push({ type: "nodeUpdate", view: this.lastView });
    return out;
  }

  private emit(e: LiveEvent): void {
    this.emitter.emit(LIVE_EVENT, e);
  }

  async pollOnce(): Promise<void> {
    try {
      const view = await this.deps.fetchView();
      this.lastView = view;
      this.setHealth(true);
      this.emit({ type: "nodeUpdate", view });
    } catch {
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
    while (this.trafficAbort === ctrl && ctrl !== null) {
      try {
        for await (const s of this.deps.streamTraffic(ctrl.signal)) {
          this.emit({ type: "traffic", up: s.up, down: s.down });
        }
      } catch {
        // upstream closed/error → brief pause, then retry while still current
      }
      if (this.trafficAbort === ctrl) await new Promise((r) => setTimeout(r, 1000));
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
