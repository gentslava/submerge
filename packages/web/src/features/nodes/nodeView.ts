import type { NodeItem, Source } from "@submerge/shared";

export type LatencyClass = "online" | "slow" | "timeout" | "idle";

export function latencyClass(delay: number | null): LatencyClass {
  if (delay === null) return "idle";
  if (delay <= 0) return "timeout";
  if (delay < 100) return "online";
  return "slow";
}

const PSEUDO = new Set(["AUTO", "DIRECT", "REJECT", "GLOBAL"]);

export function isPseudo(name: string): boolean {
  return PSEUDO.has(name);
}

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

// Tailwind classes per latency class — kept here so every node component stays in sync.
export const dotColors: Record<LatencyClass, string> = {
  online: "bg-online",
  slow: "bg-slow",
  timeout: "bg-timeout",
  idle: "bg-idle",
};

export const latencyTextColors: Record<LatencyClass, string> = {
  online: "text-online",
  slow: "text-slow",
  timeout: "text-timeout",
  idle: "text-text-tertiary",
};

// Type badges derived from a node: its protocol (uppercased) plus UDP when enabled.
export function typeBadges(node: NodeItem): string[] {
  const badges: string[] = [];
  if (node.type) badges.push(node.type.toUpperCase());
  if (node.udp) badges.push("UDP");
  return badges;
}

// A subscription group: the source's label + the real nodes whose name matches its
// proxies[], plus a synthetic trailing group for nodes not owned by any source.
export interface NodeGroup {
  key: string;
  label: string;
  kind: Source["kind"] | "other";
  hwid: boolean;
  nodes: NodeItem[];
}

// Build display groups by matching each node's name to a source's proxies[].
// Pseudo modes (AUTO/DIRECT/…) are excluded — they render in their own section.
export function groupNodes(nodes: NodeItem[], sources: Source[]): NodeGroup[] {
  const claimed = new Set<string>();
  const ordered = [...sources].sort((a, b) => a.sortOrder - b.sortOrder);
  const groups: NodeGroup[] = [];

  for (const src of ordered) {
    const owned = new Set(src.proxies.map((p) => p.name));
    const members = nodes.filter((n) => owned.has(n.name));
    for (const m of members) claimed.add(m.name);
    if (members.length > 0) {
      groups.push({
        key: `src-${src.id}`,
        label: src.label,
        kind: src.kind,
        hwid: src.hwid,
        nodes: members,
      });
    }
  }

  const orphans = nodes.filter((n) => !claimed.has(n.name));
  if (orphans.length > 0) {
    groups.push({ key: "other", label: "Прочие", kind: "other", hwid: false, nodes: orphans });
  }

  return groups;
}

// Format a mihomo /traffic rate (bytes per second) honestly as a throughput value.
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "0 B/с";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytesPerSec;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = v >= 100 || i === 0 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}/с`;
}
