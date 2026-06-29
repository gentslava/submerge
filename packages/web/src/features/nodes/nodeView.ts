import type { NodeItem } from "@submerge/shared";

export type LatencyClass = "online" | "slow" | "timeout" | "idle";

export function latencyClass(delay: number | null): LatencyClass {
  if (delay === null) return "idle";
  if (delay <= 0) return "timeout";
  if (delay < 100) return "online";
  return "slow";
}

const PSEUDO = new Set(["AUTO", "DIRECT", "REJECT", "GLOBAL"]);

export function splitNodes(all: NodeItem[]): { modes: NodeItem[]; nodes: NodeItem[] } {
  const modes: NodeItem[] = [];
  const nodes: NodeItem[] = [];
  for (const n of all) (PSEUDO.has(n.name) ? modes : nodes).push(n);
  return { modes, nodes };
}

export function latencyLabel(delay: number | null): string {
  if (delay === null) return "— ms";
  if (delay <= 0) return "timeout";
  return `${delay} ms`;
}
