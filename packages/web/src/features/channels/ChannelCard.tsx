import {
  CHANNEL_PRESETS,
  type Channel,
  type ChannelMatcher,
  type ChannelPolicy,
} from "@submerge/shared";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { type CSSProperties, forwardRef, type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { pluralRu } from "@/lib/plural";
import { cn } from "@/lib/utils";
import { DomainTags } from "./DomainTags";
import { PolicyEditor } from "./PolicyEditor";
import { PoolPicker } from "./PoolPicker";
import { PresetChips } from "./PresetChips";

const POLICY_LABEL: Record<Channel["policy"]["kind"], string> = {
  speed: "По задержке",
  sticky: "Стабильный IP",
  manual: "Приоритетный узел",
};

interface ChannelCardProps {
  channel: Channel;
  // Real (pinnable) exit nodes for the policy editor's manual-pin dropdown — same
  // pseudo-filtered derivation as the Settings screen (nodesQuery.all minus
  // PSEUDO_NODE_SET), passed down so both screens share one implementation.
  nodeNames: string[];
  onToggleEnabled: (enabled: boolean) => void;
  onUpdateName: (name: string) => void;
  onUpdateMatcher: (matcher: ChannelMatcher) => void;
  onUpdatePolicy: (policy: ChannelPolicy) => void;
  onRemove: () => void;
  busy?: boolean;
  // Opens the card already expanded on first mount — used right after `channels.create`
  // so the admin lands straight in the editor instead of a second click. Only affects
  // the initial `useState` value, so it's safe even though the prop itself never changes.
  initiallyExpanded?: boolean;
  // The reorder affordance (drag-handle grip on desktop, ↑↓ arrows on mobile), built by
  // the caller so this component stays dnd-kit-agnostic. Omitted for the Default row,
  // which can never be reordered (see RoutingScreen/reorder.ts).
  reorderControl?: ReactNode;
  // Sortable transform (ref/style) + drag-in-flight styling, forwarded from the
  // `useSortable` wrapper in RoutingScreen — mirrors `SourceRowShell`'s forwardRef.
  className?: string;
  style?: CSSProperties;
}

/**
 * One routing channel — collapsed summary measured against the mockup's `VICOv`
 * (regular channel) and `muQ15` (Default, pinned last); the expanded editor
 * against `ch·Messengers (edit)` (`Z7zRtE`); create/disabled/mobile states against
 * `HXRTv`. Expanding is a real toggle (click the chevron or anywhere on the header).
 * The reorder control (grip/arrows) is supplied by the caller — see `reorderControl`.
 */
export const ChannelCard = forwardRef<HTMLDivElement, ChannelCardProps>(function ChannelCard(
  {
    channel,
    nodeNames,
    onToggleEnabled,
    onUpdateName,
    onUpdateMatcher,
    onUpdatePolicy,
    onRemove,
    busy = false,
    initiallyExpanded = false,
    reorderControl,
    className,
    style,
  },
  ref,
) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const toggleExpanded = () => setExpanded((e) => !e);

  return (
    <div
      ref={ref}
      style={style}
      className={cn(
        "overflow-hidden rounded-lg border bg-surface",
        // Default always carries the accent border; a regular card gets it only
        // while expanded/editing (mockup `Z7zRtE`) — collapsed stays border-subtle.
        channel.isDefault || expanded ? "border-accent-border" : "border-border-subtle",
        !channel.isDefault && !channel.enabled && "opacity-50",
        className,
      )}
    >
      {channel.isDefault ? (
        <DefaultRow channel={channel} expanded={expanded} onToggleExpanded={toggleExpanded} />
      ) : (
        <RegularRow
          channel={channel}
          onToggleEnabled={onToggleEnabled}
          busy={busy}
          expanded={expanded}
          onToggleExpanded={toggleExpanded}
          reorderControl={reorderControl}
        />
      )}
      {expanded && (
        <>
          <div className="h-px w-full bg-border-subtle" aria-hidden="true" />
          <ChannelEditor
            channel={channel}
            nodeNames={nodeNames}
            onUpdateName={onUpdateName}
            onUpdateMatcher={onUpdateMatcher}
            onUpdatePolicy={onUpdatePolicy}
            onRemove={onRemove}
          />
        </>
      )}
    </div>
  );
});

// The header toggles the editor on click. The enabled Switch is a real <button>
// (role="switch"), and the reorder control is a real drag-handle/arrow <button> too —
// interactive content can't nest inside another <button>, so both sit as siblings of
// the toggle (which now wraps only name/badge/summary), rather than one big control.
//
// Below `md` (per HXRTv's mobile-390 state) the summary line wraps onto its own row —
// `MatcherSummary` takes `w-full` there so it drops under name+badge instead of
// squeezing/clipping inside the fixed-height header.
function RegularRow({
  channel,
  onToggleEnabled,
  busy,
  expanded,
  onToggleExpanded,
  reorderControl,
}: {
  channel: Channel;
  onToggleEnabled: (enabled: boolean) => void;
  busy: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  reorderControl?: ReactNode;
}) {
  const Chevron = expanded ? ChevronUp : ChevronDown;
  const toggleLabel = `${expanded ? "Свернуть" : "Развернуть"} канал «${channel.name}»`;
  return (
    <div className="flex w-full items-center gap-3 px-4 py-3.5">
      {reorderControl}
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        aria-label={toggleLabel}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 text-left md:flex-nowrap"
      >
        <span className="shrink-0 text-cardtitle text-text-primary">{channel.name}</span>
        <PolicyBadge kind={channel.policy.kind} />
        <MatcherSummary matcher={channel.matcher} />
      </button>
      <div className="flex shrink-0 items-center gap-3.5">
        {/* Honest disabled marker — we know `enabled` for certain, unlike a live
            "which node is it on" indicator (no recentDecisions wiring here yet). */}
        {!channel.enabled && (
          <span className="shrink-0 font-mono text-xs text-text-tertiary">выключен</span>
        )}
        <Switch
          checked={channel.enabled}
          onCheckedChange={onToggleEnabled}
          disabled={busy}
          aria-label={`Включить канал «${channel.name}»`}
        />
        <button type="button" onClick={onToggleExpanded} aria-label={toggleLabel}>
          <Chevron className="h-[18px] w-[18px] text-text-tertiary" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// Default has no drag handle (can't be reordered) and no policy badge (the
// mockup shows a "catch-all" caption in its place — Default's routing role,
// not its auto-select policy) and its enabled switch is permanently on: it
// always carries unmatched traffic regardless of the stored `enabled` flag
// (see channels router — "the Default always stays active regardless").
// Disabling that switch here would be dishonest UI, not real behavior.
function DefaultRow({
  channel,
  expanded,
  onToggleExpanded,
}: {
  channel: Channel;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const Chevron = expanded ? ChevronUp : ChevronDown;
  const toggleLabel = `${expanded ? "Свернуть" : "Развернуть"} канал «${channel.name}»`;
  return (
    <div className="flex w-full items-center gap-3 px-4 py-3.5">
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        aria-label={toggleLabel}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 text-left md:flex-nowrap"
      >
        <span className="shrink-0 text-cardtitle text-text-primary">{channel.name}</span>
        <span className="shrink-0 rounded-full border border-accent-border bg-accent-bg px-2 py-0.5 text-fine font-semibold text-accent-text">
          catch-all
        </span>
        <div className="flex w-full min-w-0 items-center gap-2 px-1 md:w-auto md:flex-1">
          <span className="text-xs text-text-tertiary">Всё остальное</span>
          <span className="text-sub text-text-disabled">·</span>
          <span className="text-xs text-text-tertiary">Все узлы</span>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-3.5">
        <Switch
          checked
          disabled
          onCheckedChange={() => {}}
          aria-label="Канал «Default» всегда включён"
        />
        <button type="button" onClick={onToggleExpanded} aria-label={toggleLabel}>
          <Chevron className="h-[18px] w-[18px] text-text-tertiary" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// Expanded editor — measured against `Z7zRtE`: Имя, Домены, Пул, Политика, then
// Удалить. Default's Домены row has no meaning (it matches whatever no other
// channel claimed) so it's a read-only caption rather than live preset chips/tag
// input the admin could edit to no effect. Пул and Политика stay live and
// editable for Default too — both are honored server-side for every channel
// (see channels/pool.ts's resolveChannelProxies and the Settings screen, which
// already edits the Default's policy through the same setPolicy call).
function ChannelEditor({
  channel,
  nodeNames,
  onUpdateName,
  onUpdateMatcher,
  onUpdatePolicy,
  onRemove,
}: {
  channel: Channel;
  nodeNames: string[];
  onUpdateName: (name: string) => void;
  onUpdateMatcher: (matcher: ChannelMatcher) => void;
  onUpdatePolicy: (policy: ChannelPolicy) => void;
  onRemove: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="flex w-full flex-col">
      <EditorRow label="Имя">
        <Input
          key={channel.name}
          aria-label="Имя канала"
          defaultValue={channel.name}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v.length > 0 && v !== channel.name) onUpdateName(v);
          }}
          className="w-full font-mono text-sub md:w-[280px]"
        />
      </EditorRow>
      <div className="flex w-full flex-col gap-3 border-b border-border-subtle px-[18px] py-4">
        <div className="flex flex-col gap-1">
          <span className="text-label text-text-primary">Домены</span>
          <span className="text-xs text-text-tertiary">Какие сайты пойдут через этот канал</span>
        </div>
        {channel.isDefault ? (
          <span className="text-sub text-text-tertiary">Всё остальное</span>
        ) : (
          <>
            <PresetChips
              value={channel.matcher.presets}
              onChange={(presets) => onUpdateMatcher({ ...channel.matcher, presets })}
            />
            <DomainTags
              value={channel.matcher.domains}
              onChange={(domains) => onUpdateMatcher({ ...channel.matcher, domains })}
            />
          </>
        )}
      </div>
      <div className="flex w-full flex-col gap-3 border-b border-border-subtle px-[18px] py-4">
        <div className="flex flex-col gap-1">
          <span className="text-label text-text-primary">Пул</span>
          <span className="text-xs text-text-tertiary">
            Пусто — все узлы канала берутся автоматически
          </span>
        </div>
        <PoolPicker channelId={channel.id} />
      </div>
      {/* PolicyEditor renders its own label/sub + border-bottom per row (shared
          with Settings) — no extra padding wrapper here, or every row would be
          double-indented. */}
      <PolicyEditor policy={channel.policy} nodeNames={nodeNames} onChange={onUpdatePolicy} />
      {!channel.isDefault && (
        <div className="flex w-full justify-end px-[18px] py-4">
          <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Удалить канал
          </Button>
          <ConfirmDialog
            open={confirmOpen}
            title="Удалить канал?"
            description={`«${channel.name}» — трафик по его доменам вернётся в Default.`}
            onConfirm={onRemove}
            onClose={() => setConfirmOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

// Label-left / control-right row — measured against the "Имя" row (`uU4PY`): the
// label takes the flexible space (fill_container in the mockup), pushing the
// control to the trailing edge.
function EditorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-full items-center gap-6 border-b border-border-subtle px-[18px] py-4">
      <span className="flex-1 text-label text-text-primary">{label}</span>
      {children}
    </div>
  );
}

function PolicyBadge({ kind }: { kind: Channel["policy"]["kind"] }) {
  return (
    <Badge variant="accent" className="shrink-0 border border-accent-border font-semibold">
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {POLICY_LABEL[kind]}
    </Badge>
  );
}

// Preset ids resolve to labels via the shared registry; unknown/stale ids (e.g. a
// preset removed from CHANNEL_PRESETS after being saved) are silently dropped
// rather than shown as a raw id.
function presetLabels(presets: string[]): string[] {
  const labels: string[] = [];
  for (const id of presets) {
    const label = CHANNEL_PRESETS.find((p) => p.id === id)?.label;
    if (label != null) labels.push(label);
  }
  return labels;
}

// Matcher + pool summary, combined in one row per the mockup's "mid" frame. The
// collapsed row doesn't load every channel's pool just to render this summary
// (that's an N+1 `channels.getPool` per row — the expanded editor's PoolPicker
// fetches it lazily, only for the channel actually being edited) — showing "Все
// узлы" here is the honest default rather than a per-channel count we don't have.
function MatcherSummary({ matcher }: { matcher: ChannelMatcher }) {
  const labels = presetLabels(matcher.presets);
  const [firstDomain, ...restDomains] = matcher.domains;
  const hasMatcherContent = labels.length > 0 || matcher.domains.length > 0;

  return (
    <div className="flex w-full min-w-0 items-center gap-2 px-1 md:w-auto md:flex-1">
      {labels.map((label) => (
        <span
          key={label}
          className="shrink-0 rounded-full bg-hover px-2 py-[3px] text-fine text-text-secondary"
        >
          {label}
        </span>
      ))}
      {firstDomain && (
        <span className="shrink-0 rounded-full bg-hover px-2 py-[3px] font-mono text-fine text-text-secondary">
          {firstDomain}
        </span>
      )}
      {restDomains.length > 0 && (
        <span className="shrink-0 text-xs text-text-tertiary">
          +{restDomains.length} {pluralRu(restDomains.length, ["домен", "домена", "доменов"])}
        </span>
      )}
      {!hasMatcherContent && <span className="text-xs text-text-tertiary">Домены не заданы</span>}
      <span className="shrink-0 text-sub text-text-disabled">·</span>
      <span className="shrink-0 text-xs text-text-tertiary">Все узлы</span>
    </div>
  );
}
