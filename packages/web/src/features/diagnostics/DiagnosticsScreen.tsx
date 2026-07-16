import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldAlert, Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { DiagnosticsSections } from "./DiagnosticsSections";

export function DiagnosticsScreen() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const queryKey = trpc.diagnostics.run.queryKey({ force: false });
  const diagnosticsQuery = useQuery(
    trpc.diagnostics.run.queryOptions(
      { force: false },
      {
        staleTime: 0,
        refetchOnMount: "always",
        retry: false,
      },
    ),
  );
  const refreshMutation = useMutation({
    mutationFn: () => client.diagnostics.run.query({ force: true }),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
    onError: () => toast.error("Не удалось обновить результаты диагностики"),
  });

  const result = diagnosticsQuery.data;
  const initialLoading = diagnosticsQuery.isLoading && result === undefined;
  const running = diagnosticsQuery.isFetching || refreshMutation.isPending;

  return (
    <div className="responsive-page responsive-page--diagnostics page-content page-stack diagnostics-screen flex min-w-0 flex-col">
      <PageHeader
        title="Диагностика"
        subtitle="Проверка компонентов, маршрутов и доступности сервисов"
        actions={
          <Button
            type="button"
            variant="secondary"
            size="headerIcon"
            aria-label="Проверить снова"
            disabled={initialLoading || running}
            onClick={() => refreshMutation.mutate()}
            className="page-header-action diagnostics-refresh"
          >
            <RefreshCw
              aria-hidden="true"
              size={18}
              className={running ? "animate-spin motion-reduce:animate-none" : undefined}
            />
            <span className="diagnostics-refresh-label">Проверить снова</span>
          </Button>
        }
      />

      {result !== undefined ? (
        <DiagnosticsSections result={result} running={running} />
      ) : initialLoading ? (
        <InitialDiagnosticsState />
      ) : diagnosticsQuery.isError ? (
        <DiagnosticsErrorState onRetry={() => void diagnosticsQuery.refetch()} />
      ) : (
        <InitialDiagnosticsState />
      )}
    </div>
  );
}

function InitialDiagnosticsState() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col gap-3.5">
      <section className="flex items-center gap-3 rounded-lg border border-accent-border bg-accent-bg px-4 py-3.5 text-accent-text">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface/60">
          <RefreshCw
            aria-hidden="true"
            size={18}
            className="animate-spin motion-reduce:animate-none"
          />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <h2 className="text-cardtitle text-text-primary">Выполняем первичную проверку</h2>
          <span className="text-fine text-text-secondary">
            Результаты появятся после проверки компонентов и сетевых маршрутов.
          </span>
        </span>
      </section>
      <div className="diagnostics-overview-grid grid min-w-0 gap-3.5">
        {[0, 1].map((index) => (
          <Skeleton key={index} className="h-[136px] w-full rounded-lg" />
        ))}
      </div>
      <div className="diagnostics-details-grid grid min-w-0 gap-3.5">
        <Skeleton className="h-[260px] w-full rounded-lg" />
        <Skeleton className="h-[220px] w-full rounded-lg" />
        <Skeleton className="h-[190px] w-full rounded-lg" />
      </div>
    </div>
  );
}

function DiagnosticsErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-lg border border-border-subtle bg-surface p-8 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-timeout-bg text-timeout">
        <ShieldAlert aria-hidden="true" size={20} />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-cardtitle text-text-primary">Не удалось запустить диагностику</h2>
        <p className="text-sub text-text-secondary">
          Проверьте соединение с submerge и попробуйте ещё раз.
        </p>
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        <Stethoscope aria-hidden="true" size={16} />
        Повторить
      </Button>
    </section>
  );
}
