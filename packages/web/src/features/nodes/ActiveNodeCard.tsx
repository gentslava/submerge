import type { NodeItem, TrafficSample } from "@submerge/shared";
import { cn } from "@/lib/utils";
import { LatencyChart } from "./LatencyChart";
import { formatRate, isPseudo, latencyClass, latencyTextColors, typeBadges } from "./nodeView";

interface ActiveNodeCardProps {
  now: string | null;
  all: NodeItem[];
  history: number[];
  traffic: readonly TrafficSample[];
}

export function ActiveNodeCard({ now, all, history, traffic }: ActiveNodeCardProps) {
  const active = now != null ? all.find((n) => n.name === now) : undefined;
  const isAuto = now === "AUTO";
  const latest = traffic.at(-1);

  const delayClass = latencyClass(active?.delay ?? null);
  const delayValue = active?.delay != null && active.delay > 0 ? active.delay : null;
  const badges = active && !isPseudo(active.name) ? typeBadges(active) : [];

  return (
    <section className="flex flex-col gap-7 rounded-xl border border-border-subtle bg-surface p-[22px] lg:flex-row">
      <div className="flex flex-1 flex-col gap-[18px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[11px] font-semibold tracking-[0.6px] text-text-tertiary">
            {isAuto ? "АКТИВНЫЙ УЗЕЛ · ВЫБРАН АВТОМАТИЧЕСКИ" : "АКТИВНЫЙ УЗЕЛ"}
          </span>
          {active != null && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent-bg px-2 py-0.5 text-[11px] font-semibold text-accent-text">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-text" />
              Активен
            </span>
          )}
          {isAuto && (
            <span className="inline-flex items-center rounded-full border border-accent-border bg-accent-bg px-2 py-0.5 text-[11px] font-semibold text-accent-text">
              АВТО
            </span>
          )}
        </div>

        <h2 className="text-[23px] font-semibold text-text-primary">
          {active?.name ?? "Нет активного узла"}
        </h2>

        {badges.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {badges.map((b) => (
              <span
                key={b}
                className="rounded-full bg-hover px-2 py-0.5 font-mono text-[11px] text-text-secondary"
              >
                {b}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-x-[34px] gap-y-4">
          <Stat label="ЗАДЕРЖКА">
            <span
              className={cn("font-mono text-[30px] font-semibold", latencyTextColors[delayClass])}
            >
              {delayValue ?? "—"}
            </span>
            <span className="text-sm text-text-tertiary"> ms</span>
          </Stat>
          <Stat label="ПРИНЯТО">
            <span className="font-mono text-[20px] font-semibold text-text-primary">
              {latest ? formatRate(latest.down) : "—"}
            </span>
          </Stat>
          <Stat label="ОТДАНО">
            <span className="font-mono text-[20px] font-semibold text-text-primary">
              {latest ? formatRate(latest.up) : "—"}
            </span>
          </Stat>
        </div>
      </div>

      <LatencyChart history={history} />
    </section>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-[0.4px] text-text-tertiary">{label}</span>
      <span className="leading-none">{children}</span>
    </div>
  );
}
