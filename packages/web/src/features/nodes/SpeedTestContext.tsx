import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTRPC } from "@/lib/trpc";

interface SpeedTestValue {
  // Cached download throughput (Mbps) for a node, or null when never measured.
  mbpsOf: (name: string) => number | null;
  // Nodes with a measurement currently running (drive the row spinner).
  testing: ReadonlySet<string>;
  // Ask to run a test for a node (opens the traffic-cost confirmation).
  request: (name: string) => void;
}

const Ctx = createContext<SpeedTestValue | null>(null);

// Null when there's no provider (component used outside the Nodes screen) — callers
// treat that as "speed test unavailable" and render nothing.
export function useSpeedTest(): SpeedTestValue | null {
  return useContext(Ctx);
}

// Owns the bandwidth cache query, the (serialized, server-side) speed-test mutation,
// and the traffic-cost confirmation. Kept as a provider so NodeRow can consume it
// without threading callbacks through NodeList/NodeGroup.
export function SpeedTestProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const bandwidthQuery = useQuery(trpc.nodes.bandwidth.queryOptions());
  const [testing, setTesting] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<string | null>(null); // node awaiting confirmation

  const speedTest = useMutation(
    trpc.nodes.speedTest.mutationOptions({
      onSuccess: (res, vars) => {
        void qc.invalidateQueries({ queryKey: trpc.nodes.bandwidth.queryKey() });
        toast.success(`${vars.name}: ${res.mbps.toFixed(1)} Мбит/с`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const mark = (name: string, on: boolean) =>
    setTesting((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const value = useMemo<SpeedTestValue>(() => {
    const byName = new Map((bandwidthQuery.data ?? []).map((b) => [b.nodeName, b.mbps]));
    return {
      mbpsOf: (name) => byName.get(name) ?? null,
      testing,
      request: (name) => setPending(name),
    };
  }, [bandwidthQuery.data, testing]);

  async function runConfirmed(name: string) {
    setPending(null);
    mark(name, true);
    try {
      await speedTest.mutateAsync({ name });
    } finally {
      mark(name, false);
    }
  }

  return (
    <Ctx.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title="Запустить тест скорости?"
        description={`Тест скачает ~25 МБ через «${pending ?? ""}» — это расходует трафик подписки. Запускать по необходимости.`}
        confirmLabel="Запустить"
        onConfirm={() => {
          if (pending) void runConfirmed(pending);
        }}
        onClose={() => setPending(null)}
      />
    </Ctx.Provider>
  );
}
