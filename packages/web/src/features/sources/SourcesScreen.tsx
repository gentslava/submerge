import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { warnIfNotApplied } from "@/lib/apply-toast";
import { pluralRu } from "@/lib/plural";
import { useTRPC } from "@/lib/trpc";
import { reorderSourcesList } from "./reorder";
import { SourceForm } from "./SourceForm";
import { SourceRow, SourceRowShell } from "./SourceRow";

export function SourcesScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const sourcesQuery = useQuery(trpc.sources.list.queryOptions());

  const toggleMutation = useMutation(
    trpc.sources.toggle.mutationOptions({
      onSuccess: (data) => {
        void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() });
        warnIfNotApplied(data.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const refreshMutation = useMutation(
    trpc.sources.refresh.mutationOptions({
      onSuccess: (data) => {
        void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() });
        toast.success("Источник обновлён");
        warnIfNotApplied(data.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const removeMutation = useMutation(
    trpc.sources.remove.mutationOptions({
      onSuccess: (data) => {
        void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() });
        toast.success("Источник удалён");
        warnIfNotApplied(data.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const sources = sourcesQuery.data ?? [];
  const count = sources.length;

  // Persist a drag reorder: the sortOrder carries to the Узлы screen (groups are
  // ordered by it). refetch on settle reconciles both screens with the server.
  const reorderMutation = useMutation(
    trpc.sources.reorder.mutationOptions({
      onSuccess: (data) => warnIfNotApplied(data.applied),
      onError: (e) => toast.error(e.message),
      onSettled: () => void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() }),
    }),
  );

  const sensors = useSensors(
    // 5px activation distance so a click on the handle still toggles/refreshes cleanly.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The row being dragged is rendered in the DragOverlay (a floating copy) so neither it
  // nor its neighbours "jump" when the list reorders on drop.
  const [activeId, setActiveId] = useState<number | null>(null);
  const activeSource = activeId != null ? sources.find((s) => s.id === activeId) : undefined;

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = reorderSourcesList(sources, Number(active.id), Number(over.id));
    if (next === sources) return;
    // Optimistic: show the new order immediately, then persist.
    qc.setQueryData(trpc.sources.list.queryKey(), next);
    reorderMutation.mutate({ ids: next.map((s) => s.id) });
  }

  // Track all in-flight mutation ids
  const pendingIds = new Set<number>([
    ...(toggleMutation.isPending && toggleMutation.variables ? [toggleMutation.variables.id] : []),
    ...(refreshMutation.isPending && refreshMutation.variables
      ? [refreshMutation.variables.id]
      : []),
    ...(removeMutation.isPending && removeMutation.variables ? [removeMutation.variables.id] : []),
  ]);

  return (
    <div className="flex flex-col gap-[22px] px-4 pt-5 pb-8 md:px-8 md:pt-[26px]">
      <header className="flex flex-col gap-[5px]">
        <h1 className="text-h1 text-text-primary">Источники</h1>
        <p className="text-sub text-text-secondary">
          Подписки и одиночные ссылки, из которых собираются узлы
        </p>
      </header>

      <SourceForm />

      <section className="flex flex-col gap-3 md:gap-0 md:overflow-hidden md:rounded-lg md:border md:border-border-subtle md:bg-surface">
        <div className="flex items-center justify-between px-0 py-1 md:px-4 md:py-3.5">
          <span className="text-section text-text-primary md:text-caption md:text-text-tertiary">
            Источники
          </span>
          {count > 0 && (
            <span className="text-xs text-text-tertiary">
              {count} {pluralRu(count, ["источник", "источника", "источников"])}
            </span>
          )}
        </div>
        <div className="hidden h-px w-full bg-border-subtle md:block" />

        {sourcesQuery.isLoading ? (
          <div className="flex flex-col gap-3 md:gap-0">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-border-subtle bg-surface p-3.5 md:rounded-none md:border-0 md:border-b md:px-4 md:last:border-0"
              >
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
            ))}
          </div>
        ) : sourcesQuery.isError ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface p-8 text-center text-text-secondary md:rounded-none md:border-0">
            <span>Не удалось загрузить источники.</span>
            <Button variant="secondary" size="sm" onClick={() => sourcesQuery.refetch()}>
              Повторить
            </Button>
          </div>
        ) : count > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={(e: DragStartEvent) => setActiveId(Number(e.active.id))}
            onDragEnd={onDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext
              items={sources.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              {sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  busy={pendingIds.has(source.id)}
                  onToggle={() => toggleMutation.mutate({ id: source.id })}
                  onRefresh={() => refreshMutation.mutate({ id: source.id })}
                  onRemove={() => removeMutation.mutate({ id: source.id })}
                />
              ))}
            </SortableContext>
            <DragOverlay modifiers={[restrictToVerticalAxis]}>
              {activeSource ? (
                <SourceRowShell
                  source={activeSource}
                  overlay
                  handle={
                    <span className="flex h-8 w-5 shrink-0 items-center justify-center text-text-secondary">
                      <GripVertical className="h-[18px] w-[18px]" aria-hidden="true" />
                    </span>
                  }
                  onToggle={() => {}}
                  onRefresh={() => {}}
                  onRemove={() => {}}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface p-10 text-center text-text-secondary md:rounded-none md:border-0">
            <span>Пока нет источников — вставьте ссылку в форму выше.</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => document.getElementById("source-value")?.focus()}
            >
              Перейти к форме
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
