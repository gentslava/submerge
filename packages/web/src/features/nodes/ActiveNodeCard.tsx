import type { NodeItem } from "@submerge/shared";
import { ArrowDown, ArrowUp, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { LatencyChart } from "./LatencyChart";
import {
  dotColors,
  formatBytes,
  isPseudo,
  latencyClass,
  latencyTextColors,
  typeBadges,
} from "./nodeView";

interface ActiveNodeCardProps {
  now: string | null;
  autoNow: string | null;
  all: NodeItem[];
  totals: { up: number; down: number } | null;
  latency: readonly number[];
  checkInterval: number;
}

export function ActiveNodeCard({
  now,
  autoNow,
  all,
  totals,
  latency,
  checkInterval,
}: ActiveNodeCardProps) {
  const isAuto = now === "AUTO";
  // Under AUTO, show the real node the url-test group currently routes through.
  const displayName = isAuto ? autoNow : now;
  const active = displayName != null ? all.find((n) => n.name === displayName) : undefined;

  const dClass = latencyClass(active?.delay ?? null);
  const dValue = active?.delay != null && active.delay > 0 ? active.delay : null;
  const badges = active && !isPseudo(active.name) ? typeBadges(active) : [];

  return (
    <section className="nodes-active-card flex flex-col gap-4 rounded-xl border border-border-subtle bg-surface p-4">
      <div className="nodes-active-content flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="nodes-active-heading-wide hidden text-caption tracking-[0.6px] text-text-tertiary">
            {isAuto ? "АКТИВНЫЙ УЗЕЛ · ВЫБРАН АВТОМАТИЧЕСКИ" : "АКТИВНЫЙ УЗЕЛ"}
          </span>
          <span className="nodes-active-heading-compact text-caption tracking-[0.6px] text-text-tertiary">
            АКТИВНЫЙ УЗЕЛ
          </span>
          {active != null && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-bg px-2 py-[3px] text-fine font-semibold text-accent-text",
                isAuto && "nodes-active-auto-badge hidden",
              )}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-text" />
              Активен
            </span>
          )}
          {isAuto && (
            <span className="inline-flex items-center gap-[5px] rounded-full border border-accent-border bg-accent-bg px-2 py-[3px] text-fine font-semibold tracking-[0.3px] text-accent-text">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              АВТО
            </span>
          )}
        </div>

        <h2 className="nodes-active-name text-section text-text-primary">
          {active?.name ?? (isAuto ? "Авто" : "Нет активного узла")}
        </h2>

        {badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {badges.map((b) => (
              <span
                key={b}
                className="rounded-full bg-hover px-2 py-0.5 font-mono text-fine text-text-secondary"
              >
                {b}
              </span>
            ))}
          </div>
        )}

        <div className="nodes-active-stats flex flex-wrap items-end gap-x-5 gap-y-4">
          {/* Latency — status dot + big mono value */}
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn("h-[9px] w-[9px] rounded-full", dotColors[dClass])}
              />
              <span
                className={cn(
                  "font-mono text-[30px] font-semibold leading-none",
                  latencyTextColors[dClass],
                )}
              >
                {dValue != null ? `${dValue} ms` : "—"}
              </span>
            </span>
            <span className="text-fine text-text-tertiary">задержка · сейчас</span>
          </div>

          {/* Cumulative received / sent since mihomo started (from /connections). */}
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1 font-mono text-[18px] font-medium leading-none text-text-primary">
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
              {totals ? formatBytes(totals.down) : "—"}
            </span>
            <span className="text-fine text-text-tertiary">принято</span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1 font-mono text-[18px] font-medium leading-none text-text-primary">
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
              {totals ? formatBytes(totals.up) : "—"}
            </span>
            <span className="text-fine text-text-tertiary">отдано</span>
          </div>
        </div>
      </div>

      <LatencyChart history={latency} checkInterval={checkInterval} />
    </section>
  );
}
