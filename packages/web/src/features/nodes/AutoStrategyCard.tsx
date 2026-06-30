import { Link } from "@tanstack/react-router";
import { History, MousePointer2, SlidersHorizontal, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// Авто = the AUTO group picks the node automatically (its strategy/tuning is set in
// Settings → Авто-выбор узла); Ручной pins a specific node on the PROXY selector.
const TABS = [
  { key: "manual", label: "Ручной", Icon: MousePointer2 },
  { key: "auto", label: "Авто", Icon: Sparkles },
] as const;

// Mirror of the editable AUTO group tuning (Settings → Авто-выбор узла).
export interface AutoInfo {
  url: string;
  interval: number; // seconds between mihomo re-tests (NOT the panel poll)
  tolerance: number;
  switchOnTimeout: boolean;
}

interface AutoStrategyCardProps {
  auto: AutoInfo;
  isAuto: boolean;
  autoNow: string | null;
  now: string | null;
  onAuto(): void;
  onManual(): void;
  pending?: boolean;
}

export function AutoStrategyCard({
  auto,
  isAuto,
  autoNow,
  now,
  onAuto,
  onManual,
  pending = false,
}: AutoStrategyCardProps) {
  const params: { caption: string; value: string }[] = [
    { caption: "ПРОВЕРОЧНЫЙ URL", value: auto.url.replace(/^https?:\/\//, "") },
    { caption: "ИНТЕРВАЛ ПРОВЕРКИ", value: `${auto.interval} с` },
    { caption: "ДОПУСК", value: `${auto.tolerance} ms` },
    { caption: "ПЕРЕКЛЮЧАТЬ ПРИ", value: auto.switchOnTimeout ? "таймаут" : "вручную" },
  ];

  const status = isAuto
    ? autoNow
      ? `Авто · сейчас через ${autoNow}`
      : "Авто · выбор узла…"
    : now
      ? `Ручной выбор · ${now}`
      : "Ручной выбор";

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
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
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-online" />
            <span className="text-xs text-text-secondary">Live</span>
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

      <div className="flex items-center px-4 py-3.5">
        {params.map((p, i) => (
          <div key={p.caption} className="flex flex-1 items-center">
            {i > 0 && (
              <span aria-hidden="true" className="mr-[18px] h-[34px] w-px bg-border-subtle" />
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-caption tracking-[0.4px] text-text-tertiary">{p.caption}</span>
              <span className="font-mono text-sub font-medium text-text-primary">{p.value}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="h-px w-full bg-border-subtle" />

      <div className="flex items-center gap-2.5 bg-elevated px-4 py-[11px]">
        <History className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="font-mono text-xs text-text-tertiary">{status}</span>
      </div>
    </section>
  );
}
