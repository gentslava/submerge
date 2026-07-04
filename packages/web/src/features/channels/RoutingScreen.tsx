import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc";
import { ChannelCard } from "./ChannelCard";

/**
 * «Маршрутизация» screen — measured against the mockup's `P7RAD`/`fSRZN`. Each
 * `ChannelCard` now expands into a real editor for name + domains (Task 4); the
 * pool/policy/delete rows and the "Новый канал" create flow that opens a fresh
 * card land in Task 5 — until then the header button has nothing to open, so
 * it's rendered but inert.
 */
export function RoutingScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const channelsQuery = useQuery(trpc.channels.list.queryOptions());
  const channels = channelsQuery.data ?? [];

  const updateMutation = useMutation(
    trpc.channels.update.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.channels.list.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="flex flex-col gap-5 px-4 pt-5 pb-8 md:px-8 md:pt-[26px]">
      <header className="flex w-full items-center justify-between gap-4">
        <div className="flex flex-col gap-[5px]">
          <h1 className="text-h1 text-text-primary">Маршрутизация</h1>
          <p className="text-sub text-text-secondary">Какие сайты через какие узлы</p>
        </div>
        <Button>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Новый канал
        </Button>
      </header>

      {channelsQuery.isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[70px] w-full rounded-lg" />
          ))}
        </div>
      ) : channelsQuery.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border-subtle bg-surface p-8 text-center text-text-secondary">
          <span>Не удалось загрузить каналы.</span>
          <Button variant="secondary" size="sm" onClick={() => channelsQuery.refetch()}>
            Повторить
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              busy={updateMutation.isPending && updateMutation.variables?.id === channel.id}
              onToggleEnabled={(enabled) => updateMutation.mutate({ id: channel.id, enabled })}
              onUpdateName={(name) => updateMutation.mutate({ id: channel.id, name })}
              onUpdateMatcher={(matcher) => updateMutation.mutate({ id: channel.id, matcher })}
            />
          ))}
          {channels.length === 1 && (
            <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface p-4">
              <Info className="h-5 w-5 shrink-0 text-text-tertiary" aria-hidden="true" />
              <p className="text-sub text-text-secondary">
                Пока один канал — весь трафик идёт через Default. Создайте канал, чтобы направить
                домены через отдельные узлы.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
