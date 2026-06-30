import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

/**
 * The current active node `now` from the shared nodes.list query (same cache
 * entry the Узлы screen reads, kept fresh by the SSE live stream). Returns null
 * while loading or when no node is selected.
 */
export function useActiveNode(): string | null {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.nodes.list.queryOptions());
  return data?.now ?? null;
}
