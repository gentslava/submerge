import {
  type ChannelPolicy,
  DEFAULT_POLL_INTERVAL,
  type SetChannelPoolInput,
} from "@submerge/shared";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { PolicyEditor } from "./PolicyEditor";

// PoolPicker resets this read-only projection after writes. The server uses
// its config generator to resolve source membership and engine-assigned names.
export function ChannelPolicyEditor({
  channelId,
  policy,
  onChange,
  activeNode,
}: {
  channelId: string;
  policy: ChannelPolicy;
  onChange: (next: ChannelPolicy) => void;
  activeNode?: string;
}) {
  const trpc = useTRPC();
  const poolPending =
    useIsMutating({
      mutationKey: trpc.channels.setPool.mutationKey(),
      predicate: (mutation) =>
        (mutation.state.variables as SetChannelPoolInput | undefined)?.id === channelId,
    }) > 0;
  const nodes = useQuery(
    trpc.channels.policyNodes.queryOptions(
      { id: channelId },
      {
        refetchInterval: DEFAULT_POLL_INTERVAL * 1000,
      },
    ),
  );
  const nodeNamesUnavailable = poolPending
    ? "Сохранение пула узлов…"
    : nodes.isError
      ? "Не удалось загрузить пул узлов."
      : nodes.isPending
        ? "Загрузка пула узлов…"
        : undefined;
  const nodeNames = nodeNamesUnavailable ? [] : (nodes.data ?? []);

  return (
    <PolicyEditor
      policy={policy}
      onChange={onChange}
      nodeNames={nodeNames}
      {...(activeNode !== undefined ? { activeNode } : {})}
      {...(nodeNamesUnavailable ? { nodeNamesUnavailable } : {})}
    />
  );
}
