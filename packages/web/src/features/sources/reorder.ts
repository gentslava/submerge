import type { RouterOutputs } from "@/lib/trpc";

// The client-side source type — the serialized `sources.list` output, derived from
// the shared Zod contract through the router (single source of truth). This is the
// exact type the query cache holds, so reordering keeps it assignable to setQueryData.
type SourceItem = RouterOutputs["sources"]["list"][number];

// Move the item with id `activeId` to where `overId` sits, preserving the rest.
// Returns the same array reference when nothing changes (same slot, or an unknown
// id), so callers can skip a no-op mutation. Mirrors dnd-kit's arrayMove for ids.
export function reorderSourcesList(
  items: SourceItem[],
  activeId: number,
  overId: number,
): SourceItem[] {
  if (activeId === overId) return items;
  const from = items.findIndex((s) => s.id === activeId);
  const to = items.findIndex((s) => s.id === overId);
  if (from < 0 || to < 0) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}
