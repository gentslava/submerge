import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createTrafficDashboardStore, type TrafficDashboardStore } from "@/features/traffic/store";
import { useTRPC, useTRPCClient } from "@/lib/trpc";

const LATENCY_WINDOW = 40; // active-node latency samples (one per poll)

// Per-second traffic samples arrive ~1/s — far more often than anything else.
// Routing them through React state re-rendered every live consumer each second,
// so they live in an external store instead: only components that actually
// render traffic subscribe (via useSyncExternalStore), everyone else pays zero.
export interface LiveState {
  // Stable-identity store; render it with useSyncExternalStore(traffic.subscribe, …).
  traffic: TrafficDashboardStore;
  mihomo: boolean | null;
  // Active node's latency series (ms; 0 = timeout), one sample appended per poll.
  // mihomo only keeps ~10 history entries, so we accumulate here for a longer chart.
  latency: readonly number[];
  // Cumulative bytes received/sent since mihomo started (принято / отдано).
  totals: { up: number; down: number } | null;
}

export function useLive(): LiveState {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  // Lazy initializer: useRef(createTrafficDashboardStore()) would build (and discard) a
  // whole store on every render; useState's initializer runs exactly once.
  const [traffic] = useState(createTrafficDashboardStore);
  // Accumulated latency series keyed by the active node — reset when it changes,
  // seeded from mihomo's recent history, then extended one sample per poll.
  const latency = useRef<{ name: string | null; values: number[] }>({ name: null, values: [] });
  const [state, setState] = useState<LiveState>(() => ({
    traffic,
    mihomo: null,
    latency: [],
    totals: null,
  }));

  useEffect(() => {
    // Over httpSubscriptionLink the server's tracked() yields arrive typed as
    // { id, data }, where `data` is the LiveEvent union. Read `ev.data` directly.
    const sub = client.live.stream.subscribe(undefined, {
      onData(ev) {
        const evt = ev.data;
        if (evt.type === "nodeUpdate") {
          qc.setQueryData(trpc.nodes.list.queryKey(), evt.view);
          traffic.pushNodeView(evt.view);
          const view = evt.view;
          const active = view.now === "AUTO" ? view.autoNow : view.now;
          const node = active ? view.all.find((n) => n.name === active) : undefined;
          const lat = latency.current;
          if (active !== lat.name) {
            // Active node changed → seed from its recorded check history (mihomo's
            // url-test log). 0 = timeout, kept as a failure spike.
            lat.name = active;
            lat.values = node ? node.history.slice(-LATENCY_WINDOW) : [];
          } else if (node) {
            // Same node → append ONLY when mihomo recorded a NEW check (its latest
            // history entry changed). The panel no longer probes per poll, so the chart
            // advances at mihomo's url-test (check) interval — not on every poll.
            const latest = node.history.at(-1);
            if (latest !== undefined && latest !== lat.values.at(-1)) {
              lat.values = [...lat.values, latest].slice(-LATENCY_WINDOW);
            }
          }
          setState((s) => ({ ...s, latency: lat.values }));
        } else if (evt.type === "traffic") {
          // No setState: samples go to the external store so per-second events
          // only re-render components that subscribed to it.
          traffic.pushTraffic({ up: evt.up, down: evt.down });
        } else if (evt.type === "totals") {
          traffic.pushTotals({ up: evt.up, down: evt.down });
          setState((s) => ({ ...s, totals: { up: evt.up, down: evt.down } }));
        } else {
          setState((s) => (s.mihomo === evt.mihomo ? s : { ...s, mihomo: evt.mihomo }));
        }
      },
      onError() {
        setState((s) => (s.mihomo === false ? s : { ...s, mihomo: false }));
      },
    });
    return () => sub.unsubscribe();
  }, [client, qc, trpc, traffic]);

  return state;
}
