import type { TrafficSample } from "@submerge/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { RingBuffer } from "@/lib/live";
import { useTRPC, useTRPCClient } from "@/lib/trpc";

const TRAFFIC_WINDOW = 60; // last ~60 samples (~60 s at 1/s)

export interface LiveState {
  traffic: readonly TrafficSample[];
  mihomo: boolean | null;
}

export function useLive(): LiveState {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const buffer = useRef(new RingBuffer<TrafficSample>(TRAFFIC_WINDOW));
  const [state, setState] = useState<LiveState>({ traffic: [], mihomo: null });

  useEffect(() => {
    // Over httpSubscriptionLink the server's tracked() yields arrive typed as
    // { id, data }, where `data` is the LiveEvent union. Read `ev.data` directly.
    const sub = client.live.stream.subscribe(undefined, {
      onData(ev) {
        const evt = ev.data;
        if (evt.type === "nodeUpdate") {
          qc.setQueryData(trpc.nodes.list.queryKey(), evt.view);
        } else if (evt.type === "traffic") {
          buffer.current.push({ up: evt.up, down: evt.down });
          setState((s) => ({ ...s, traffic: [...buffer.current.toArray()] }));
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
