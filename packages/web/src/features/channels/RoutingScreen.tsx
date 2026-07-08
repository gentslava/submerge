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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type Channel,
  type ChannelPolicy,
  DEFAULT_AUTO_TEST_URL,
  PSEUDO_NODE_SET,
} from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, GripVertical, Info, Plus } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { warnIfNotApplied } from "@/lib/apply-toast";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ChannelCard } from "./ChannelCard";
import { reorderChannelsList } from "./reorder";

// Seed for a freshly created channel — a working speed policy so it's immediately
// controllable, and an empty matcher/pool the admin fills in via the editor that
// opens right after creation. Faster interval + tighter tolerance than the Default's
// (60s vs 300s) since a purpose-built channel more likely wants snappier failover.
const NEW_CHANNEL_SEED_POLICY: ChannelPolicy = {
  kind: "speed",
  testUrl: DEFAULT_AUTO_TEST_URL,
  intervalSec: 60,
  toleranceMs: 50,
  reevaluateWhileHealthy: true,
};

/**
 * «Маршрутизация» screen — measured against the mockup's `P7RAD`/`fSRZN` (main
 * layout) and `HXRTv` (create / disabled / mobile-390 states). Each `ChannelCard`
 * expands into a real editor for name + domains + pool + policy + delete.
 * «Новый канал» creates a real channel (seeded policy + empty matcher) and opens
 * it expanded. Reorder is drag (desktop, grip-handle) / ↑↓ arrows (mobile, below
 * `md`) over the non-default channels only — the Default channel is pinned last
 * and rendered outside the sortable list entirely, so it can never be dragged
 * onto or reordered.
 */
export function RoutingScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const channelsQuery = useQuery(trpc.channels.list.queryOptions());
  const channels = channelsQuery.data ?? [];
  const nonDefaultChannels = channels.filter((c) => !c.isDefault);
  const defaultChannel = channels.find((c) => c.isDefault);
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
      onSuccess: (data) => {
        void invalidateChannels();
        warnIfNotApplied(data.applied);
      },
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
      onSuccess: (data) => {
        void invalidateChannels();
        toast.success("Канал удалён");
        warnIfNotApplied(data.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // Tracks the just-created channel so its card mounts expanded (see ChannelCard's
  // `initiallyExpanded`) — the admin lands straight in the editor instead of a
  // second click to expand what they just made.
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const createMutation = useMutation(
    trpc.channels.create.mutationOptions({
      onSuccess: (res) => {
        void invalidateChannels();
        setJustCreatedId(res.channel.id);
        warnIfNotApplied(res.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  function handleCreate() {
    createMutation.mutate({
      name: "Новый канал",
      policy: NEW_CHANNEL_SEED_POLICY,
    });
  }

  // Persist a reorder (drag or arrow-button): `next` is the new non-default order;
  // the Default channel is appended back on top for the optimistic cache write since
  // the server always keeps it last regardless (see channels/service.ts reorderChannels).
  const reorderMutation = useMutation(
    trpc.channels.reorder.mutationOptions({
      onSuccess: (data) => warnIfNotApplied(data.applied),
      onError: (e) => toast.error(e.message),
      onSettled: invalidateChannels,
    }),
  );

  function commitReorder(next: Channel[]) {
    if (next === nonDefaultChannels) return;
    qc.setQueryData(
      trpc.channels.list.queryKey(),
      defaultChannel ? [...next, defaultChannel] : next,
    );
    reorderMutation.mutate({ ids: next.map((c) => c.id) });
  }

  function moveChannel(channel: Channel, direction: -1 | 1) {
    const index = nonDefaultChannels.findIndex((c) => c.id === channel.id);
    const neighbor = nonDefaultChannels[index + direction];
    if (index < 0 || !neighbor) return;
    commitReorder(reorderChannelsList(nonDefaultChannels, channel.id, neighbor.id));
  }

  const sensors = useSensors(
    // 5px activation distance so a click on the handle still toggles/expands cleanly.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The card being dragged renders in the DragOverlay (a floating copy) so neither it
  // nor its neighbours "jump" when the list reorders on drop — same pattern as Источники.
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeChannel =
    activeId != null ? nonDefaultChannels.find((c) => c.id === activeId) : undefined;

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    commitReorder(reorderChannelsList(nonDefaultChannels, String(active.id), String(over.id)));
  }

  return (
    <div className="flex flex-col gap-5 px-4 pt-5 pb-8 md:px-8 md:pt-[26px]">
      <header className="flex w-full items-center justify-between gap-4">
        <div className="flex flex-col gap-[5px]">
          <h1 className="text-h1 text-text-primary">Маршрутизация</h1>
          <p className="text-sub text-text-secondary">Какие сайты через какие узлы</p>
        </div>
        <Button onClick={handleCreate} disabled={createMutation.isPending}>
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
            onDragEnd={onDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext
              items={nonDefaultChannels.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {nonDefaultChannels.map((channel, index) => (
                <SortableChannelCard
                  key={channel.id}
                  channel={channel}
                  canMoveUp={index > 0}
                  canMoveDown={index < nonDefaultChannels.length - 1}
                  nodeNames={nodeNames}
                  busy={updateMutation.isPending && updateMutation.variables?.id === channel.id}
                  initiallyExpanded={channel.id === justCreatedId}
                  onToggleEnabled={(enabled) => updateMutation.mutate({ id: channel.id, enabled })}
                  onUpdateName={(name) => updateMutation.mutate({ id: channel.id, name })}
                  onUpdateMatcher={(matcher) => updateMutation.mutate({ id: channel.id, matcher })}
                  onUpdatePolicy={(policy) => setPolicyMutation.mutate({ id: channel.id, policy })}
                  onRemove={() => removeMutation.mutate({ id: channel.id })}
                  onMoveUp={() => moveChannel(channel, -1)}
                  onMoveDown={() => moveChannel(channel, 1)}
                />
              ))}
            </SortableContext>
            <DragOverlay modifiers={[restrictToVerticalAxis]}>
              {activeChannel ? (
                <ChannelCard
                  channel={activeChannel}
                  nodeNames={nodeNames}
                  className="shadow-lg"
                  reorderControl={
                    <span className="flex h-8 w-5 shrink-0 items-center justify-center text-text-secondary">
                      <GripVertical className="h-[18px] w-[18px]" aria-hidden="true" />
                    </span>
                  }
                  onToggleEnabled={() => {}}
                  onUpdateName={() => {}}
                  onUpdateMatcher={() => {}}
                  onUpdatePolicy={() => {}}
                  onRemove={() => {}}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
          {defaultChannel && (
            <ChannelCard
              channel={defaultChannel}
              nodeNames={nodeNames}
              busy={updateMutation.isPending && updateMutation.variables?.id === defaultChannel.id}
              onToggleEnabled={(enabled) =>
                updateMutation.mutate({ id: defaultChannel.id, enabled })
              }
              onUpdateName={(name) => updateMutation.mutate({ id: defaultChannel.id, name })}
              onUpdateMatcher={(matcher) =>
                updateMutation.mutate({ id: defaultChannel.id, matcher })
              }
              onUpdatePolicy={(policy) =>
                setPolicyMutation.mutate({ id: defaultChannel.id, policy })
              }
              onRemove={() => removeMutation.mutate({ id: defaultChannel.id })}
            />
          )}
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

interface SortableChannelCardProps {
  channel: Channel;
  canMoveUp: boolean;
  canMoveDown: boolean;
  nodeNames: string[];
  busy: boolean;
  initiallyExpanded: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onUpdateName: (name: string) => void;
  onUpdateMatcher: (matcher: Channel["matcher"]) => void;
  onUpdatePolicy: (policy: ChannelPolicy) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

// Wires one non-default channel into the sortable list: `useSortable` supplies the
// drag transform (applied to the whole card via ChannelCard's forwardRef) and the
// activator ref/listeners for the grip handle. The grip is desktop-only (`hidden
// md:flex`); below `md` it's replaced by ↑↓ arrow buttons that call the same
// reorder path directly (no drag gesture needed on touch).
function SortableChannelCard({
  channel,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  ...rest
}: SortableChannelCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: channel.id });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };

  return (
    <ChannelCard
      ref={setNodeRef}
      style={style}
      // While this card is the one being dragged, hide it in place — the DragOverlay
      // renders the floating copy — so the drop can't "jump" between the two.
      className={cn(isDragging && "opacity-0")}
      channel={channel}
      reorderControl={
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Перетащить «${channel.name}» для сортировки`}
            className="hidden h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-text-tertiary transition-colors hover:text-text-secondary active:cursor-grabbing md:flex"
          >
            <GripVertical className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
          <span className="flex shrink-0 flex-col md:hidden">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              aria-label={`Поднять канал «${channel.name}» выше`}
              className="flex h-4 w-5 items-center justify-center text-text-tertiary transition-colors hover:text-text-secondary disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              aria-label={`Опустить канал «${channel.name}» ниже`}
              className="flex h-4 w-5 items-center justify-center text-text-tertiary transition-colors hover:text-text-secondary disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </button>
          </span>
        </span>
      }
      {...rest}
    />
  );
}
