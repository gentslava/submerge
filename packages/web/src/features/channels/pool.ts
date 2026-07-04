import type { ChannelPoolMember } from "@submerge/shared";

// Pure pool-editing logic for the PoolPicker, kept apart from the component so it's
// unit-testable without a tRPC/query-client harness (mirrors sources/reorder.ts).
//
// The pool stores two independent kinds of membership (see channels/pool.ts on the
// server): a `source` ref covers ALL of that source's proxies, present and future
// (re-resolved on every config apply); a `node` ref pins one proxy by name. The UI
// exposes both — a source-level bulk checkbox and per-node checkboxes — but they
// are NOT merged into one flag: checking a source just adds/removes that one ref.

export function hasSourceMember(pool: ChannelPoolMember[], sourceId: number): boolean {
  const ref = String(sourceId);
  return pool.some((m) => m.kind === "source" && m.ref === ref);
}

export function hasNodeMember(pool: ChannelPoolMember[], name: string): boolean {
  return pool.some((m) => m.kind === "node" && m.ref === name);
}

// Toggle a source's bulk membership. Checking it supersedes any individual node
// picks within that source — they're now redundant (the source ref alone covers
// them, plus any node the source picks up on a future refresh) — so they're
// dropped to keep the persisted set minimal instead of accumulating dead entries.
export function toggleSourcePool(
  pool: ChannelPoolMember[],
  sourceId: number,
  nodeNamesInSource: string[],
  checked: boolean,
): ChannelPoolMember[] {
  const ref = String(sourceId);
  let next = pool.filter((m) => !(m.kind === "source" && m.ref === ref));
  if (checked) {
    next = next.filter((m) => !(m.kind === "node" && nodeNamesInSource.includes(m.ref)));
    next = [...next, { kind: "source", ref }];
  }
  return next;
}

// Toggle one node's individual membership. A no-op on any source-level ref — an
// individual pick only matters while the source itself isn't bulk-selected (the
// picker disables node checkboxes once their source is checked, so this path isn't
// reachable from the UI in that state, but it stays a pure, order-independent op).
export function toggleNodePool(
  pool: ChannelPoolMember[],
  name: string,
  checked: boolean,
): ChannelPoolMember[] {
  const next = pool.filter((m) => !(m.kind === "node" && m.ref === name));
  return checked ? [...next, { kind: "node", ref: name }] : next;
}

// Aggregate label for a source group's header: how many of its nodes are
// effectively selected (via the source ref or individually) — "часть" partial,
// "всё" every node, "—" none. Display-only; storage always keeps the two kinds
// independent (see toggle* above).
export function poolGroupCaption(selected: number, total: number): "всё" | "часть" | "—" {
  if (total === 0 || selected === 0) return "—";
  return selected === total ? "всё" : "часть";
}
