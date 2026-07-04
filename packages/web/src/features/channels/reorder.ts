import type { RouterOutputs } from "@/lib/trpc";

// The client-side channel type — the serialized `channels.list` output, derived from
// the shared Zod contract through the router (single source of truth). This is the
// exact type the query cache holds, so reordering keeps it assignable to setQueryData.
// Mirrors `features/sources/reorder.ts` (same pattern, string ids instead of numbers).
type ChannelItem = RouterOutputs["channels"]["list"][number];

// Move the item with id `activeId` to where `overId` sits, preserving the rest.
// Returns the same array reference when nothing changes (same slot, or an unknown
// id), so callers can skip a no-op mutation. Mirrors dnd-kit's arrayMove for ids.
//
// Callers pass only the reorderable (non-default) subset — the Default channel is
// pinned last and never part of `items`, so `overId`/`activeId` can never resolve to
// it here; dropping "onto" Default (an id absent from `items`) safely no-ops via the
// `to < 0` guard below rather than reordering past it.
export function reorderChannelsList(
  items: ChannelItem[],
  activeId: string,
  overId: string,
): ChannelItem[] {
  if (activeId === overId) return items;
  const from = items.findIndex((c) => c.id === activeId);
  const to = items.findIndex((c) => c.id === overId);
  if (from < 0 || to < 0) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}
