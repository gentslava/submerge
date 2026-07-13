import type { Channel, DecisionEntry, ProxyChannel } from "@submerge/shared";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import { ChannelController, toGroupView } from "./controller.js";
import { groupNameFor } from "./pool.js";
import { policyProbe } from "./service.js";

export interface RegistryDeps {
  listChannels: () => Channel[];
  fetchProxies: () => Promise<ProxiesResponse>;
  probe: (name: string, url: string) => Promise<number | null>;
  select: (group: string, name: string) => Promise<void>;
  clearFixed: (group: string) => Promise<void>;
  bandwidthOf?: (name: string) => number | null;
  persistReason: (channelId: string, reason: string, at: number) => void;
  now: () => number;
}

// Mutable holder so a cached ChannelController's `readChannel` always resolves to
// the latest row (e.g. after channels.setPolicy) without recreating the controller
// — recreating would drop its transient state (failures/heldSince/lastCheck) and
// break throttling/hold-window behavior across polls.
interface ChannelBox {
  current: ProxyChannel;
}

// Ticks one ChannelController per channel, every poll. Each channel gets its own
// controller instance (created lazily, cached by id) so its transient state never
// leaks across channels — the same reason ChannelController itself keeps that
// state as private fields rather than parameters.
export class ControllerRegistry {
  private controllers = new Map<string, ChannelController>();
  private boxes = new Map<string, ChannelBox>();

  constructor(private deps: RegistryDeps) {}

  private controllerFor(channel: ProxyChannel): ChannelController {
    const box = this.boxes.get(channel.id);
    if (box) box.current = channel;
    else this.boxes.set(channel.id, { current: channel });

    const existing = this.controllers.get(channel.id);
    if (existing) return existing;

    const readChannel = (): ProxyChannel => this.boxes.get(channel.id)?.current ?? channel;
    const ctrl = new ChannelController({
      readChannel,
      group: groupNameFor(channel),
      probe: this.deps.probe,
      select: this.deps.select,
      clearFixed: this.deps.clearFixed,
      ...(this.deps.bandwidthOf ? { bandwidthOf: this.deps.bandwidthOf } : {}),
      persistReason: (reason, at) => this.deps.persistReason(channel.id, reason, at),
      now: this.deps.now,
    });
    this.controllers.set(channel.id, ctrl);
    return ctrl;
  }

  async runOnce(): Promise<void> {
    const chs = this.deps.listChannels();
    // A disabled non-default channel is excluded from control entirely — it must
    // not be ticked/pinned. The Default always runs regardless of its own
    // `enabled` flag (it's the permanent catch-all).
    const active = chs
      .filter((ch): ch is ProxyChannel => ch.target === "proxy")
      .filter((ch) => ch.isDefault || ch.enabled);
    if (active.length === 0) {
      this.controllers.clear();
      this.boxes.clear();
      return;
    }
    const px = (await this.deps.fetchProxies()).proxies;
    for (const ch of active) {
      const ctrl = this.controllerFor(ch);
      const group = groupNameFor(ch);
      // Measure each node on the URL this channel's policy decides on, so the
      // decision-log delta agrees with the node cards (nodes/service.toNodeView).
      const view = toGroupView(px, group, policyProbe(ch.policy).url);
      // The group's leftover manual pin (mihomo's `fixed`), if any — the speed
      // controller clears it so an accidental pin can't freeze the latency race.
      const fixed = px[group]?.fixed ?? null;
      try {
        await ctrl.tick(view, fixed);
      } catch {
        // Best-effort: a throwing channel must not stop the others this poll.
      }
    }
    // Drop cached controllers (and their boxes) for channels that are no longer
    // live — removed OR disabled — so a re-created/re-enabled channel with the
    // same id starts from a fresh controller rather than resurrecting stale
    // transient state.
    const liveIds = new Set(active.map((ch) => ch.id));
    for (const id of this.controllers.keys()) {
      if (!liveIds.has(id)) {
        this.controllers.delete(id);
        this.boxes.delete(id);
      }
    }
  }

  recent(): DecisionEntry[] {
    const all: DecisionEntry[] = [];
    for (const ctrl of this.controllers.values()) all.push(...ctrl.recent());
    return all.sort((a, b) => b.at - a.at);
  }

  reset(channelId: string): void {
    this.controllers.get(channelId)?.reset();
  }
}
