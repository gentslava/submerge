import { PSEUDO_NODE_SET } from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { warnIfNotApplied } from "@/lib/apply-toast";
import { useTRPC } from "@/lib/trpc";
import { ChannelCard } from "./ChannelCard";

/**
 * «Маршрутизация» screen — measured against the mockup's `P7RAD`/`fSRZN`. Each
 * `ChannelCard` now expands into a real editor for name + domains + pool + policy
 * + delete; the "Новый канал" create flow that opens a fresh card is a later
 * task — until then the header button has nothing to open, so it's rendered but
 * inert.
 */
export function RoutingScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const channelsQuery = useQuery(trpc.channels.list.queryOptions());
  const channels = channelsQuery.data ?? [];
  const nodesQuery = useQuery(trpc.nodes.list.queryOptions());
  // Real (pinnable) exit nodes for each card's policy editor — same derivation as
  // the Settings screen (mihomo's built-in groups/policies aren't valid pins).
  const nodeNames = (nodesQuery.data?.all ?? [])
    .map((n) => n.name)
    .filter((n) => !PSEUDO_NODE_SET.has(n));

  const invalidateChannels = () =>
    qc.invalidateQueries({ queryKey: trpc.channels.list.queryKey() });

  const updateMutation = useMutation(
    trpc.channels.update.mutationOptions({
      onSuccess: invalidateChannels,
      onError: (e) => toast.error(e.message),
    }),
  );

  const setPolicyMutation = useMutation(
    trpc.channels.setPolicy.mutationOptions({
      onSuccess: (data) => {
        void invalidateChannels();
        warnIfNotApplied(data.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const removeMutation = useMutation(
    trpc.channels.remove.mutationOptions({
      onSuccess: () => {
        void invalidateChannels();
        toast.success("Канал удалён");
      },
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
              nodeNames={nodeNames}
              busy={updateMutation.isPending && updateMutation.variables?.id === channel.id}
              onToggleEnabled={(enabled) => updateMutation.mutate({ id: channel.id, enabled })}
              onUpdateName={(name) => updateMutation.mutate({ id: channel.id, name })}
              onUpdateMatcher={(matcher) => updateMutation.mutate({ id: channel.id, matcher })}
              onUpdatePolicy={(policy) => setPolicyMutation.mutate({ id: channel.id, policy })}
              onRemove={() => removeMutation.mutate({ id: channel.id })}
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
