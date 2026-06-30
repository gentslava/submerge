import type { TrafficSample } from "@submerge/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { RingBuffer } from "@/lib/live";
import { useTRPC, useTRPCClient } from "@/lib/trpc";

const TRAFFIC_WINDOW = 60; // last ~60 samples (~60 s at 1/s)
const LATENCY_WINDOW = 40; // active-node latency samples (one per poll)

export interface LiveState {
  traffic: readonly TrafficSample[];
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
  const buffer = useRef(new RingBuffer<TrafficSample>(TRAFFIC_WINDOW));
  // Accumulated latency series keyed by the active node — reset when it changes,
  // seeded from mihomo's recent history, then extended one sample per poll.
  const latency = useRef<{ name: string | null; values: number[] }>({ name: null, values: [] });
  const [state, setState] = useState<LiveState>({
    traffic: [],
    mihomo: null,
    latency: [],
    totals: null,
  });

  useEffect(() => {
    // Over httpSubscriptionLink the server's tracked() yields arrive typed as
    // { id, data }, where `data` is the LiveEvent union. Read `ev.data` directly.
    const sub = client.live.stream.subscribe(undefined, {
      onData(ev) {
        const evt = ev.data;
        if (evt.type === "nodeUpdate") {
          qc.setQueryData(trpc.nodes.list.queryKey(), evt.view);
          const view = evt.view;
          const active = view.now === "AUTO" ? view.autoNow : view.now;
          const node = active ? view.all.find((n) => n.name === active) : undefined;
          const lat = latency.current;
          if (active !== lat.name) {
            // Active node changed → reseed the series from its recorded history.
            lat.name = active;
            lat.values = node ? node.history.slice(-LATENCY_WINDOW) : [];
          } else if (node) {
            // Same node → append this poll's fresh measurement (0 = timeout).
            const d = node.delay != null && node.delay > 0 ? node.delay : 0;
            lat.values = [...lat.values, d].slice(-LATENCY_WINDOW);
          }
          setState((s) => ({ ...s, latency: lat.values }));
        } else if (evt.type === "traffic") {
          buffer.current.push({ up: evt.up, down: evt.down });
          setState((s) => ({ ...s, traffic: [...buffer.current.toArray()] }));
        } else if (evt.type === "totals") {
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
  }, [client, qc, trpc]);

  return state;
}
