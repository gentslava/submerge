import type { Source } from "@submerge/shared";

// Move the source with id `activeId` to where `overId` sits, preserving the rest.
// Returns the same array reference when nothing changes (same slot, or an unknown
// id), so callers can skip a no-op mutation. Mirrors dnd-kit's arrayMove for ids.
export function reorderSourcesList(sources: Source[], activeId: number, overId: number): Source[] {
  if (activeId === overId) return sources;
  const from = sources.findIndex((s) => s.id === activeId);
  const to = sources.findIndex((s) => s.id === overId);
  if (from < 0 || to < 0) return sources;
  const next = sources.slice();
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}
