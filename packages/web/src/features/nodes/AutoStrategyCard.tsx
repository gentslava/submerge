import { History, SlidersHorizontal } from "lucide-react";

// The Auto-Strategy card is a design-faithful, mostly-informational panel.
// mihomo exposes a single url-test group (AUTO); we don't switch between
// manual/reserve/balance strategies, so the segmented control is static and the
// threshold params reflect the url-test config defaults (see nodes/config.ts).
const STRATEGIES = ["Ручной", "Авто", "Резерв", "Баланс"] as const;
const ACTIVE_STRATEGY = "Авто";

interface AutoStrategyCardProps {
  pollInterval: number;
}

export function AutoStrategyCard({ pollInterval }: AutoStrategyCardProps) {
  const params: { caption: string; value: string }[] = [
    { caption: "ПРОВЕРОЧНЫЙ URL", value: "gstatic.com/generate_204" },
    { caption: "ИНТЕРВАЛ", value: `${pollInterval} с` },
    { caption: "ДОПУСК", value: "50 ms" },
    { caption: "ПЕРЕКЛЮЧАТЬ ПРИ", value: "> 250 ms · timeout" },
  ];

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 py-3.5">
        {/* TODO(design): segmented strategy switch is informational — mihomo only
            runs the AUTO url-test group, so the tabs are not interactive. */}
        {/* biome-ignore lint/a11y/useSemanticElements: a div with role="group" is the correct ARIA pattern for this non-interactive segmented display; <fieldset> carries unwanted form-control semantics. */}
        <div
          role="group"
          aria-label="Стратегия выбора (информационно)"
          className="flex gap-[3px] rounded-md border border-border-subtle bg-canvas p-[3px]"
        >
          {STRATEGIES.map((s) => {
            const active = s === ACTIVE_STRATEGY;
            return (
              <span
                key={s}
                aria-current={active ? "true" : undefined}
                className={
                  active
                    ? "rounded-sm bg-accent px-[13px] py-[7px] text-[13px] font-medium text-accent-fg"
                    : "rounded-sm px-[13px] py-[7px] text-[13px] font-medium text-text-secondary"
                }
              >
                {s}
              </span>
            );
          })}
        </div>
        <div className="flex items-center gap-3.5">
          <span className="flex items-center gap-[7px]">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-online" />
            <span className="text-xs text-text-secondary">Live</span>
          </span>
          {/* TODO(design): "Настроить" has no settings target yet. */}
          <button
            type="button"
            disabled
            className="flex h-8 items-center gap-[7px] rounded-md border border-border-default bg-elevated px-3 text-[13px] text-text-secondary disabled:pointer-events-none disabled:opacity-60"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            Настроить
          </button>
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
              <span className="text-[11px] font-semibold tracking-[0.4px] text-text-tertiary">
                {p.caption}
              </span>
              <span className="font-mono text-[13px] font-medium text-text-primary">{p.value}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="h-px w-full bg-border-subtle" />

      <div className="flex items-center gap-2.5 bg-elevated px-4 py-[11px]">
        <History className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
        {/* Honest static line — the backend does not track switch history. */}
        <span className="font-mono text-xs text-text-tertiary">
          Автовыбор активен · переключение по деградации
        </span>
      </div>
    </section>
  );
}
