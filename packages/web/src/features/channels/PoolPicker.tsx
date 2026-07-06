import { type NodeItem, PSEUDO_NODE_SET } from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, KeyRound, Layers } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  dotColors,
  groupNodes,
  latencyClass,
  latencyLabel,
  latencyTextColors,
  typeBadges,
} from "@/features/nodes/nodeView";
import { warnIfNotApplied } from "@/lib/apply-toast";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  channelGroupNames,
  hasNodeMember,
  hasSourceMember,
  poolGroupCaption,
  toggleNodePool,
  toggleSourcePool,
} from "./pool";

interface PoolPickerProps {
  channelId: string;
}

// A source-derived group's key is "src-<id>" (see nodeView.groupNodes); the
// synthetic orphan bucket is "other" and has no source to bulk-toggle.
const SOURCE_KEY_RE = /^src-(\d+)$/;

/**
 * Grouped checkbox pool picker for a channel — measured against the mockup's
 * expanded channel editor (`Z7zRtE`, "Пул" row): each source is a card with a
 * bulk source-level checkbox + its expandable node list, reusing the same
 * source→node attribution as the Узлы screen (`nodeView.groupNodes`, matching
 * each node's name to a source's `proxies[]`). Self-contained: it queries
 * sources/nodes/pool and persists via `channels.setPool` itself, so the parent
 * (`ChannelCard`) only needs to pass the channel id.
 */
export function PoolPicker({ channelId }: PoolPickerProps) {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const sourcesQuery = useQuery(trpc.sources.list.queryOptions());
  const nodesQuery = useQuery(trpc.nodes.list.queryOptions());
  const poolQuery = useQuery(trpc.channels.getPool.queryOptions({ id: channelId }));
  // Needed only to derive the generated channel-group names (AUTO / ch-<id>) that
  // must be excluded below — same queryKey as RoutingScreen's channelsQuery, so
  // this normally reads straight from cache rather than firing a second request.
  const channelsQuery = useQuery(trpc.channels.list.queryOptions());

  const setPoolMutation = useMutation(
    trpc.channels.setPool.mutationOptions({
      onSuccess: (data) => {
        void qc.invalidateQueries({ queryKey: trpc.channels.list.queryKey() });
        void qc.invalidateQueries({
          queryKey: trpc.channels.getPool.queryKey({ id: channelId }),
        });
        warnIfNotApplied(data.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (
    sourcesQuery.isLoading ||
    nodesQuery.isLoading ||
    poolQuery.isLoading ||
    channelsQuery.isLoading
  ) {
    return <Skeleton className="h-[72px] w-full rounded-md" />;
  }
  if (sourcesQuery.isError || nodesQuery.isError || poolQuery.isError || channelsQuery.isError) {
    return <p className="text-xs text-text-tertiary">Не удалось загрузить пул узлов.</p>;
  }

  const sources = sourcesQuery.data ?? [];
  const excludedGroupNames = channelGroupNames(channelsQuery.data ?? []);
  const nodes = (nodesQuery.data?.all ?? []).filter(
    (n) => !PSEUDO_NODE_SET.has(n.name) && !excludedGroupNames.has(n.name),
  );
  const pool = poolQuery.data ?? [];
  const groups = groupNodes(nodes, sources);

  function persist(next: typeof pool) {
    setPoolMutation.mutate({ id: channelId, members: next });
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {groups.length === 0 ? (
        <p className="text-sub text-text-tertiary">Нет узлов — добавьте источник.</p>
      ) : (
        groups.map((g) => {
          const match = SOURCE_KEY_RE.exec(g.key);
          const sourceId = match?.[1] !== undefined ? Number(match[1]) : null;
          const sourceChecked = sourceId != null && hasSourceMember(pool, sourceId);
          const isNodeChecked = (name: string) => sourceChecked || hasNodeMember(pool, name);
          const selected = g.nodes.filter((n) => isNodeChecked(n.name)).length;

          return (
            <PoolGroup
              key={g.key}
              label={g.label}
              hwid={g.hwid}
              caption={poolGroupCaption(selected, g.nodes.length)}
              nodes={g.nodes}
              hasHeaderCheckbox={sourceId != null}
              headerChecked={sourceChecked}
              onToggleHeader={(checked) => {
                if (sourceId == null) return;
                persist(
                  toggleSourcePool(
                    pool,
                    sourceId,
                    g.nodes.map((n) => n.name),
                    checked,
                  ),
                );
              }}
              isNodeChecked={isNodeChecked}
              nodeDisabled={sourceChecked || setPoolMutation.isPending}
              onToggleNode={(name, checked) => persist(toggleNodePool(pool, name, checked))}
            />
          );
        })
      )}
    </div>
  );
}

function PoolGroup({
  label,
  hwid,
  caption,
  nodes,
  hasHeaderCheckbox,
  headerChecked,
  onToggleHeader,
  isNodeChecked,
  nodeDisabled,
  onToggleNode,
}: {
  label: string;
  hwid: boolean;
  caption: string;
  nodes: NodeItem[];
  hasHeaderCheckbox: boolean;
  headerChecked: boolean;
  onToggleHeader: (checked: boolean) => void;
  isNodeChecked: (name: string) => boolean;
  nodeDisabled: boolean;
  onToggleNode: (name: string, checked: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const GroupIcon = hwid ? KeyRound : Layers;

  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-elevated">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {hasHeaderCheckbox ? (
          <Checkbox
            checked={headerChecked}
            onCheckedChange={onToggleHeader}
            aria-label={`Включить весь источник «${label}» в пул`}
          />
        ) : (
          <span className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Развернуть" : "Свернуть"} «${label}»`}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-text-tertiary transition-transform",
              collapsed && "-rotate-90",
            )}
            aria-hidden="true"
          />
          <GroupIcon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sub font-medium text-text-primary">
            {label}
          </span>
          <span className="shrink-0 text-xs text-text-tertiary">{caption}</span>
        </button>
      </div>
      {!collapsed &&
        nodes.map((n) => {
          const checked = isNodeChecked(n.name);
          const lClass = latencyClass(n.delay);
          const sub = typeBadges(n).join(" · ");
          return (
            <div
              key={n.name}
              className="flex items-center gap-2.5 border-t border-border-subtle py-2 pr-3 pl-10"
            >
              <Checkbox
                checked={checked}
                disabled={nodeDisabled}
                onCheckedChange={(v) => onToggleNode(n.name, v)}
                aria-label={`Включить узел «${n.name}» в пул`}
              />
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="truncate text-sub font-medium text-text-primary">{n.name}</span>
                {sub !== "" && <span className="truncate text-fine text-text-tertiary">{sub}</span>}
              </div>
              <span className={cn("shrink-0 font-mono text-xs", latencyTextColors[lClass])}>
                {latencyLabel(n.delay)}
              </span>
            </div>
          );
        })}
    </div>
  );
}
