import type { ChannelPolicy } from "@submerge/shared";
import { Link } from "@tanstack/react-router";
import { History, MousePointer2, SlidersHorizontal, Sparkles } from "lucide-react";
import { useLiveState } from "@/features/live/LiveProvider";
import { liveIndicator } from "@/features/live/status";
import { formatInterval, formatRelative } from "@/lib/duration";
import { cn } from "@/lib/utils";

// Авто = the AUTO group picks the node automatically (its policy/tuning is set in
// Settings → Авто-выбор узла); Ручной pins a specific node on the PROXY selector.
const TABS = [
  { key: "manual", label: "Ручной", Icon: MousePointer2 },
  { key: "auto", label: "Авто", Icon: Sparkles },
] as const;

const POLICY_LABEL: Record<ChannelPolicy["kind"], string> = {
  speed: "По задержке",
  sticky: "Стабильный IP",
  manual: "Приоритетный узел",
};
const CRITERION_LABEL: Record<"fastest" | "lowest-loss", string> = {
  fastest: "По скорости",
  "lowest-loss": "По стабильности",
};
const ON_FAILURE_LABEL: Record<"fallback" | "hold", string> = {
  fallback: "Запасной узел",
  hold: "Держать",
};

type Param = { caption: string; value: string; grow?: boolean };

// Compact read-only summary of the active Default-channel policy, shaped per kind so
// the card reflects the REAL policy (not just speed defaults).
function policyParams(policy: ChannelPolicy): Param[] {
  const mode: Param = { caption: "ПОЛИТИКА", value: POLICY_LABEL[policy.kind] };
  if (policy.kind === "manual") {
    return [
      mode,
      { caption: "ПРИОРИТЕТНЫЙ УЗЕЛ", value: policy.pinnedNode, grow: true },
      { caption: "ПРИ ОТКАЗЕ", value: ON_FAILURE_LABEL[policy.onFailure] },
    ];
  }
  const common: Param[] = [
    mode,
    { caption: "ПРОВЕРОЧНЫЙ URL", value: policy.testUrl.replace(/^https?:\/\//, ""), grow: true },
    { caption: "ИНТЕРВАЛ ПРОВЕРКИ", value: formatInterval(policy.intervalSec) },
  ];
  if (policy.kind === "speed") {
    return [
      ...common,
      { caption: "ДОПУСК", value: `${policy.toleranceMs} ms` },
      { caption: "ПЕРЕОЦЕНКА", value: policy.reevaluateWhileHealthy ? "всегда" : "пока жив" },
    ];
  }
  return [
    ...common,
    { caption: "ПОРОГ СБОЕВ", value: String(policy.failureThreshold) },
    { caption: "КРИТЕРИЙ", value: CRITERION_LABEL[policy.initialCriterion] },
  ];
}

interface AutoStrategyCardProps {
  policy: ChannelPolicy;
  isAuto: boolean;
  autoNow: string | null;
  now: string | null;
  onAuto(): void;
  onManual(): void;
  pending?: boolean;
  // The controller's last "why it switched" decision (Default channel), persisted
  // server-side. Optional — NodesScreen omits it, SettingsScreen feeds it.
  lastDecision?: { reason: string; at: number | null };
}

export function AutoStrategyCard({
  policy,
  isAuto,
  autoNow,
  now,
  onAuto,
  onManual,
  pending = false,
  lastDecision,
}: AutoStrategyCardProps) {
  const params = policyParams(policy);
  // Honest stream indicator: reflects the real SSE/mihomo health, same tri-state
  // as the sidebar's ProxyCard — never a hard-coded green dot.
  const { mihomo } = useLiveState();
  const live = liveIndicator(mihomo, { idle: "Проверка", ok: "Live", down: "Оффлайн" });

  const status = isAuto
    ? autoNow
      ? `Авто · сейчас через ${autoNow}`
      : "Авто · выбор узла…"
    : now
      ? `Ручной выбор · ${now}`
      : "Ручной выбор";

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        {/* biome-ignore lint/a11y/useSemanticElements: role="group" is the correct ARIA pattern for a segmented toggle of buttons; <fieldset> carries unwanted form-control semantics. */}
        <div
          role="group"
          aria-label="Стратегия выбора узла"
          className="flex gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]"
        >
          {TABS.map(({ key, label, Icon }) => {
            const active = key === (isAuto ? "auto" : "manual");
            return (
              <button
                key={key}
                type="button"
                disabled={pending}
                aria-current={active ? "true" : undefined}
                onClick={key === "auto" ? onAuto : onManual}
                className={cn(
                  "flex items-center gap-[7px] rounded-sm px-[13px] py-[7px] text-sub font-medium transition-colors disabled:pointer-events-none disabled:opacity-60",
                  active
                    ? "bg-accent text-accent-fg"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                <Icon className="h-[15px] w-[15px]" aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3.5">
          <span className="flex items-center gap-[7px]">
            <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", live.dot)} />
            <span className="text-xs text-text-secondary">{live.label}</span>
          </span>
          {/* Auto-select tuning is editable in Settings → Авто-выбор узла. */}
          <Link
            to="/settings"
            className="flex h-8 items-center gap-[7px] rounded-md border border-border-default bg-elevated px-3 text-[13px] text-text-primary transition-colors hover:bg-hover [&_svg]:text-text-secondary"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            Настроить
          </Link>
        </div>
      </div>

      <div className="h-px w-full bg-border-subtle" />

      {/* Mobile: a 2-col grid (URL spans a full row, dense flow backfills the gap).
          Desktop (md+): a single content-flexible row where the URL grows + truncates
          and short values size to content, split by vertical dividers. */}
      <div className="grid grid-flow-row-dense grid-cols-2 gap-x-4 gap-y-3.5 px-4 py-3.5 md:flex md:items-center md:gap-0">
        {params.map((p, i) => (
          <div
            key={p.caption}
            className={cn(
              "flex items-center",
              p.grow ? "col-span-2 md:min-w-0 md:flex-1" : "md:shrink-0",
            )}
          >
            {i > 0 && (
              <span
                aria-hidden="true"
                className="mx-[18px] hidden h-[34px] w-px shrink-0 bg-border-subtle md:block"
              />
            )}
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-caption tracking-[0.4px] text-text-tertiary">{p.caption}</span>
              <span
                className={cn(
                  "font-mono text-sub font-medium text-text-primary",
                  p.grow && "truncate",
                )}
                title={p.grow ? p.value : undefined}
              >
                {p.value}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="h-px w-full bg-border-subtle" />

      <div className="flex flex-col gap-1 bg-elevated px-4 py-[11px]">
        <div className="flex items-center gap-2.5">
          <History className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
          <span className="font-mono text-xs text-text-tertiary">{status}</span>
        </div>
        {lastDecision?.reason && (
          <span className="font-mono text-xs text-text-tertiary">
            {lastDecision.reason}
            {lastDecision.at ? ` · ${formatRelative(lastDecision.at)}` : ""}
          </span>
        )}
      </div>
    </section>
  );
}
