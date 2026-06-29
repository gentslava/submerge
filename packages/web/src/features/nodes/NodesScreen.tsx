import type { NodeItem } from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc";
import { ActiveNodeCard } from "./ActiveNodeCard";
import { NodeRow } from "./NodeRow";
import { splitNodes } from "./nodeView";

export function NodesScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nodesQuery = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5000 });
  const select = useMutation(
    trpc.nodes.select.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.nodes.list.queryKey() });
        toast.success("Узел выбран");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold text-text-primary">Узлы</h1>
          <p className="text-sm text-text-secondary">
            Группа PROXY · активный: {nodesQuery.data?.now ?? "—"}
          </p>
        </div>
        <Button variant="ghost" onClick={() => nodesQuery.refetch()}>
          Обновить
        </Button>
      </header>

      {nodesQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : nodesQuery.isError ? (
        <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center text-text-secondary">
          Не удалось получить узлы от mihomo.{" "}
          <Button variant="subtle" size="sm" onClick={() => nodesQuery.refetch()}>
            Повторить
          </Button>
        </div>
      ) : (
        <Body
          now={nodesQuery.data?.now ?? null}
          all={nodesQuery.data?.all ?? []}
          onSelect={(name) => select.mutate({ group: "PROXY", name })}
        />
      )}
    </div>
  );
}

function Body({
  now,
  all,
  onSelect,
}: {
  now: string | null;
  all: NodeItem[];
  onSelect: (n: string) => void;
}) {
  const { nodes } = splitNodes(all);
  return (
    <div className="flex flex-col gap-5">
      <ActiveNodeCard now={now} all={all} />
      <div className="flex flex-col rounded-xl border border-border-subtle bg-surface">
        {nodes.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">
            Нет узлов —{" "}
            <Link to="/sources" className="text-accent-text">
              добавьте источник
            </Link>
            .
          </div>
        ) : (
          nodes.map((n) => (
            <NodeRow
              key={n.name}
              item={n}
              isActive={now === n.name}
              onSelect={() => onSelect(n.name)}
            />
          ))
        )}
      </div>
    </div>
  );
}
