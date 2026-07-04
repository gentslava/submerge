import { CHANNEL_PRESETS, type Channel, type ChannelMatcher } from "@submerge/shared";
import { ChevronDown, GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { pluralRu } from "@/lib/plural";
import { cn } from "@/lib/utils";

const POLICY_LABEL: Record<Channel["policy"]["kind"], string> = {
  speed: "По задержке",
  sticky: "Стабильный IP",
  manual: "Приоритетный узел",
};

interface ChannelCardProps {
  channel: Channel;
  onToggleEnabled: (enabled: boolean) => void;
  busy?: boolean;
}

/**
 * Collapsed summary row for one routing channel — measured against the mockup's
 * `VICOv` (regular channel) and `muQ15` (Default, pinned last). The expanded
 * editor (name/domains/pool/policy fields) lands in Tasks 4–5; the chevron here
 * is a real affordance for that future expand interaction but is inert this
 * task, and the drag handle is decorative only (reorder wiring is a later task).
 */
export function ChannelCard({ channel, onToggleEnabled, busy = false }: ChannelCardProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-surface",
        channel.isDefault ? "border-accent-border" : "border-border-subtle",
        !channel.isDefault && !channel.enabled && "opacity-50",
      )}
    >
      {channel.isDefault ? (
        <DefaultRow channel={channel} />
      ) : (
        <RegularRow channel={channel} onToggleEnabled={onToggleEnabled} busy={busy} />
      )}
    </div>
  );
}

function RegularRow({
  channel,
  onToggleEnabled,
  busy,
}: {
  channel: Channel;
  onToggleEnabled: (enabled: boolean) => void;
  busy: boolean;
}) {
  return (
    <div className="flex w-full items-center gap-3 px-4 py-3.5">
      <GripVertical className="h-4 w-4 shrink-0 text-text-disabled" aria-hidden="true" />
      <span className="shrink-0 text-cardtitle text-text-primary">{channel.name}</span>
      <PolicyBadge kind={channel.policy.kind} />
      <MatcherSummary matcher={channel.matcher} />
      <div className="flex shrink-0 items-center gap-3.5">
        <Switch
          checked={channel.enabled}
          onCheckedChange={onToggleEnabled}
          disabled={busy}
          aria-label={`Включить канал «${channel.name}»`}
        />
        <ChevronDown className="h-[18px] w-[18px] text-text-tertiary" aria-hidden="true" />
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
function DefaultRow({ channel }: { channel: Channel }) {
  return (
    <div className="flex w-full items-center gap-3 px-4 py-3.5">
      <span className="shrink-0 text-cardtitle text-text-primary">{channel.name}</span>
      <span className="shrink-0 rounded-full border border-accent-border bg-accent-bg px-2 py-0.5 text-[11px] font-semibold text-accent-text">
        catch-all
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
        <span className="text-xs text-text-tertiary">Всё остальное</span>
        <span className="text-sub text-text-disabled">·</span>
        <span className="text-xs text-text-tertiary">Все узлы</span>
      </div>
      <div className="flex shrink-0 items-center gap-3.5">
        <Switch
          checked
          disabled
          onCheckedChange={() => {}}
          aria-label="Канал «Default» всегда включён"
        />
        <ChevronDown className="h-[18px] w-[18px] text-text-tertiary" aria-hidden="true" />
      </div>
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

// Matcher + pool summary, combined in one row per the mockup's "mid" frame. Pool
// membership isn't loaded per-channel yet (that's `channels.getPool`, wired in a
// later task) — showing "Все узлы" here is the honest default rather than a
// per-channel count we don't have.
function MatcherSummary({ matcher }: { matcher: ChannelMatcher }) {
  const labels = presetLabels(matcher.presets);
  const [firstDomain, ...restDomains] = matcher.domains;
  const hasMatcherContent = labels.length > 0 || matcher.domains.length > 0;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
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
