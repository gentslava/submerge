import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pluralRu } from "@/lib/plural";
import { useTRPC } from "@/lib/trpc";
import { SourceForm } from "./SourceForm";
import { SourceRow } from "./SourceRow";

export function SourcesScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const sourcesQuery = useQuery(trpc.sources.list.queryOptions());

  const toggleMutation = useMutation(
    trpc.sources.toggle.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const refreshMutation = useMutation(
    trpc.sources.refresh.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() });
        toast.success("Источник обновлён");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const removeMutation = useMutation(
    trpc.sources.remove.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.sources.list.queryKey() });
        toast.success("Источник удалён");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // Track all in-flight mutation ids
  const pendingIds = new Set<number>([
    ...(toggleMutation.isPending && toggleMutation.variables ? [toggleMutation.variables.id] : []),
    ...(refreshMutation.isPending && refreshMutation.variables
      ? [refreshMutation.variables.id]
      : []),
    ...(removeMutation.isPending && removeMutation.variables ? [removeMutation.variables.id] : []),
  ]);

  const sources = sourcesQuery.data ?? [];
  const count = sources.length;

  return (
    <div className="flex flex-col gap-[22px] px-8 pt-[26px] pb-8">
      <header className="flex flex-col gap-[5px]">
        <h1 className="text-h1 text-text-primary">Источники</h1>
        <p className="text-sub text-text-secondary">
          Подписки и одиночные ссылки, из которых собираются узлы
        </p>
      </header>

      <SourceForm />

      <section className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface">
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="text-caption text-text-tertiary">СПИСОК ИСТОЧНИКОВ</span>
          {count > 0 && (
            <span className="text-xs text-text-tertiary">
              {count} {pluralRu(count, ["источник", "источника", "источников"])}
            </span>
          )}
        </div>
        <div className="h-px w-full bg-border-subtle" />

        {sourcesQuery.isLoading ? (
          <div className="flex flex-col">
            {[0, 1, 2].map((i) => (
              <div key={i} className="border-b border-border-subtle px-4 py-3.5 last:border-0">
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
            ))}
          </div>
        ) : sourcesQuery.isError ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center text-text-secondary">
            <span>Не удалось загрузить источники.</span>
            <Button variant="secondary" size="sm" onClick={() => sourcesQuery.refetch()}>
              Повторить
            </Button>
          </div>
        ) : count > 0 ? (
          sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              busy={pendingIds.has(source.id)}
              onToggle={() => toggleMutation.mutate({ id: source.id })}
              onRefresh={() => refreshMutation.mutate({ id: source.id })}
              onRemove={() => removeMutation.mutate({ id: source.id })}
            />
          ))
        ) : (
          <div className="flex flex-col items-center gap-3 p-10 text-center text-text-secondary">
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
