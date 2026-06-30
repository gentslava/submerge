import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Источники</h1>
        <p className="text-sm text-text-secondary">Подписки, vless и happ-ссылки</p>
      </header>

      <div className="flex flex-col gap-4">
        <SourceForm />

        <div className="rounded-xl border border-border-subtle bg-surface">
          {sourcesQuery.isLoading ? (
            <div className="flex flex-col">
              {[0, 1, 2].map((i) => (
                <div key={i} className="border-b border-border-subtle px-4 py-3 last:border-0">
                  <Skeleton className="h-5 w-full" />
                </div>
              ))}
            </div>
          ) : sourcesQuery.isError ? (
            <div className="p-8 text-center text-text-secondary">
              Не удалось загрузить источники.{" "}
              <Button variant="ghost" size="sm" onClick={() => sourcesQuery.refetch()}>
                Повторить
              </Button>
            </div>
          ) : sourcesQuery.data && sourcesQuery.data.length > 0 ? (
            sourcesQuery.data.map((source) => (
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
            <div className="flex flex-col items-center gap-3 p-8 text-center text-text-secondary">
              <span>Пока нет источников — вставьте ссылку выше.</span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const el = document.getElementById("source-value");
                  if (el instanceof HTMLElement) el.focus();
                }}
              >
                Добавить источник
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
