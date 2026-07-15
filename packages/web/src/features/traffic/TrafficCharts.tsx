import { formatRate } from "@/features/nodes/nodeView";
import { pluralRu } from "@/lib/plural";
import { cn } from "@/lib/utils";
import { chartSummary, throughputPeak } from "./state";
import type { TimedTrafficSample } from "./store";

const LATENCY_CAP = 40;
const TRAFFIC_CAP = 60;
const COMPACT_LATENCY_CAP = 24;
const COMPACT_TRAFFIC_CAP = 18;
const RECENT_LATENCY_BARS = 4;
const BAR_STEPS = 20;

const BAR_HEIGHT_CLASSES = [
  "h-[3px]",
  "h-[5%]",
  "h-[10%]",
  "h-[15%]",
  "h-[20%]",
  "h-[25%]",
  "h-[30%]",
  "h-[35%]",
  "h-[40%]",
  "h-[45%]",
  "h-[50%]",
  "h-[55%]",
  "h-[60%]",
  "h-[65%]",
  "h-[70%]",
  "h-[75%]",
  "h-[80%]",
  "h-[85%]",
  "h-[90%]",
  "h-[95%]",
  "h-full",
] as const;

function durationLabel(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} с`;
  if (seconds < 5_400) return `${Math.round(seconds / 60)} мин`;
  const hours = seconds / 3_600;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ч`;
}

function agoLabel(seconds: number): string {
  return seconds <= 0 ? "сейчас" : `−${durationLabel(seconds)}`;
}

function latencyWindowSeconds(sampleCount: number, checkIntervalSec: number): number {
  return Math.max(0, sampleCount - 1) * Math.max(1, checkIntervalSec);
}

function latencyValue(value: number | null): string {
  if (value === null) return "—";
  return value <= 0 ? "таймаут" : `${value} ms`;
}

function compressWindow<T>(
  values: readonly T[],
  slots: number,
  representative: (bucket: readonly T[]) => T,
): T[] {
  if (values.length <= slots) return [...values];
  return Array.from({ length: slots }, (_, index) => {
    const start = Math.floor((index * values.length) / slots);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / slots));
    return representative(values.slice(start, end));
  });
}

function compactLatency(values: readonly number[]): number[] {
  return compressWindow(values, COMPACT_LATENCY_CAP, (bucket) => {
    if (bucket.some((value) => value <= 0)) return 0;
    return Math.max(...bucket);
  });
}

function compactThroughput(values: readonly TimedTrafficSample[]): TimedTrafficSample[] {
  return compressWindow(values, COMPACT_TRAFFIC_CAP, (bucket) =>
    bucket.reduce((peak, sample) =>
      sample.up + sample.down > peak.up + peak.down ? sample : peak,
    ),
  );
}

function barLevel(value: number, peak: number): number {
  if (value <= 0 || peak <= 0) return 0;
  return Math.max(1, Math.min(BAR_STEPS, Math.round((value / peak) * BAR_STEPS)));
}

function throughputLevels(sample: TimedTrafficSample, peak: number): { up: number; down: number } {
  const total = sample.up + sample.down;
  if (total <= 0 || peak <= 0) return { up: 0, down: 0 };

  const bothDirections = sample.up > 0 && sample.down > 0;
  const totalLevel = Math.max(bothDirections ? 2 : 1, barLevel(total, peak));
  if (sample.up <= 0) return { up: 0, down: totalLevel };
  if (sample.down <= 0) return { up: totalLevel, down: 0 };

  const up = Math.max(1, Math.min(totalLevel - 1, Math.round((sample.up / total) * totalLevel)));
  return { up, down: totalLevel - up };
}

function heightClass(level: number): string {
  return BAR_HEIGHT_CLASSES[level] ?? BAR_HEIGHT_CLASSES[0];
}

function LatencyWindow({
  bars,
  slots,
  checkIntervalSec,
  windowSampleCount,
  testId,
}: {
  bars: readonly number[];
  slots: number;
  checkIntervalSec: number;
  windowSampleCount?: number;
  testId: string;
}) {
  const summary = chartSummary(bars);
  const peak = summary.max ?? 1;
  const windowSeconds = latencyWindowSeconds(windowSampleCount ?? summary.count, checkIntervalSec);

  return (
    <>
      <div
        aria-hidden="true"
        data-testid={testId}
        className="traffic-latency-plot flex h-20 items-stretch gap-0.5"
      >
        {Array.from({ length: slots }, (_, slot) => {
          const index = slot - (slots - bars.length);
          const value = index >= 0 ? bars[index] : undefined;
          if (value === undefined) {
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed chart slots are positional
                key={slot}
                className="flex min-w-0 flex-1 items-end"
              >
                <span className="h-[3px] w-full rounded-sm bg-border-subtle" />
              </span>
            );
          }

          const timeout = value <= 0;
          const recent = index >= bars.length - RECENT_LATENCY_BARS;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed chart slots are positional
              key={slot}
              title={timeout ? "таймаут" : `${value} ms`}
              className="flex min-w-0 flex-1 items-end"
            >
              <span
                className={cn(
                  "w-full rounded-sm transition-[height] duration-300 motion-reduce:transition-none",
                  timeout ? "h-full bg-timeout" : heightClass(barLevel(value, peak)),
                  !timeout && (recent ? "bg-accent" : "bg-chart-track"),
                )}
              />
            </span>
          );
        })}
      </div>
      <div
        data-testid={`${testId}-axis`}
        className="traffic-latency-axis flex items-center justify-between font-mono text-axis text-text-tertiary"
      >
        <span>{agoLabel(windowSeconds)}</span>
        <span>сейчас</span>
      </div>
    </>
  );
}

function ThroughputWindow({
  bars,
  slots,
  testId,
}: {
  bars: readonly TimedTrafficSample[];
  slots: number;
  testId: string;
}) {
  const peak = throughputPeak(bars);

  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className="traffic-throughput-plot flex h-24 items-stretch gap-[3px]"
    >
      {Array.from({ length: slots }, (_, slot) => {
        const index = slot - (slots - bars.length);
        const sample = index >= 0 ? bars[index] : undefined;
        if (sample === undefined) {
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed chart slots are positional
              key={slot}
              className="flex min-w-0 flex-1 items-end"
            >
              <span className="h-[3px] w-full rounded-sm bg-border-subtle" />
            </span>
          );
        }

        const total = sample.up + sample.down;
        if (total <= 0) {
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed chart slots are positional
              key={slot}
              className="flex min-w-0 flex-1 items-end"
            >
              <span
                data-testid={`${testId}-zero`}
                className="h-[3px] w-full rounded-sm bg-chart-track"
              />
            </span>
          );
        }

        const levels = throughputLevels(sample, peak);
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed chart slots are positional
            key={slot}
            title={`загрузка ${formatRate(sample.down)}, отдача ${formatRate(sample.up)}`}
            className="flex min-w-0 flex-1 flex-col justify-end gap-px"
          >
            {levels.up > 0 ? (
              <span
                className={cn(
                  "w-full rounded-t-sm bg-online transition-[height] duration-300 motion-reduce:transition-none",
                  heightClass(levels.up),
                )}
              />
            ) : null}
            {levels.down > 0 ? (
              <span
                className={cn(
                  "w-full rounded-b-sm bg-accent transition-[height] duration-300 motion-reduce:transition-none",
                  heightClass(levels.down),
                )}
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function TrafficLatencyChart({
  node,
  current,
  samples,
  checkIntervalSec,
}: {
  node: string | null;
  current: number | null;
  samples: readonly number[];
  checkIntervalSec: number;
}) {
  const bars = samples.slice(-LATENCY_CAP);
  const compactBars = compactLatency(bars);
  const summary = chartSummary(bars);
  const windowSeconds = latencyWindowSeconds(summary.count, checkIntervalSec);
  const nodePhrase = node ? ` через ${node}` : "";
  const accessibleSummary =
    summary.count === 0
      ? `Нет данных о задержке${nodePhrase}. Текущее значение: ${latencyValue(current)}.`
      : `Задержка основного канала${nodePhrase}: сейчас ${latencyValue(current)}, минимум ${latencyValue(summary.min)}, максимум ${latencyValue(summary.max)}, ${summary.count} ${pluralRu(summary.count, ["замер", "замера", "замеров"])} за ${durationLabel(windowSeconds)}.`;

  return (
    <section
      aria-label="Задержка основного канала"
      className="traffic-chart overflow-hidden rounded-lg border border-border-subtle bg-surface"
    >
      <header className="traffic-chart-header flex min-w-0 items-center justify-between gap-3 border-b border-border-subtle px-3 py-[11px]">
        <h2
          title={node ?? undefined}
          className="traffic-chart-title min-w-0 truncate text-micro font-semibold tracking-[0.04em] text-text-secondary"
        >
          ЗАДЕРЖКА · ОСНОВНОЙ КАНАЛ
          {node ? <span className="traffic-latency-node hidden"> · {node}</span> : null}
        </h2>
        <span className="flex shrink-0 items-baseline gap-1.5">
          {node ? (
            <span
              title={node}
              className="traffic-latency-node-compact max-w-20 truncate font-mono text-micro font-normal normal-case tracking-normal text-text-tertiary"
            >
              {node}
            </span>
          ) : null}
          <span
            className={cn(
              "traffic-latency-current shrink-0 font-mono text-xs font-medium",
              current === null
                ? "text-text-tertiary"
                : current <= 0
                  ? "text-timeout"
                  : "text-online",
            )}
          >
            {latencyValue(current)}
          </span>
        </span>
      </header>
      <p className="sr-only">{accessibleSummary}</p>
      <div className="traffic-chart-body flex flex-col gap-1.5 p-3">
        {bars.length === 0 ? (
          <div className="flex h-20 items-center justify-center rounded-sm bg-elevated text-sub text-text-tertiary">
            Нет данных о задержке
          </div>
        ) : (
          <>
            <div className="traffic-chart-variant--compact flex flex-col gap-1.5">
              <LatencyWindow
                bars={compactBars}
                slots={COMPACT_LATENCY_CAP}
                checkIntervalSec={checkIntervalSec}
                windowSampleCount={bars.length}
                testId="traffic-latency-bars-compact"
              />
            </div>
            <div className="traffic-chart-variant--wide hidden flex-col gap-2.5">
              <LatencyWindow
                bars={bars}
                slots={LATENCY_CAP}
                checkIntervalSec={checkIntervalSec}
                testId="traffic-latency-bars"
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function ThroughputChart({ samples }: { samples: readonly TimedTrafficSample[] }) {
  const bars = samples.slice(-TRAFFIC_CAP);
  const compactBars = compactThroughput(bars);
  const peak = throughputPeak(bars);
  const minimum = bars.reduce(
    (value, sample) => Math.min(value, sample.up + sample.down),
    Number.POSITIVE_INFINITY,
  );
  const latest = bars.at(-1) ?? null;
  const windowSeconds =
    bars.length > 1 ? Math.max(0, Math.round(((latest?.at ?? 0) - (bars[0]?.at ?? 0)) / 1_000)) : 0;
  const accessibleSummary =
    bars.length === 0
      ? "Нет данных о пропускной способности."
      : `Пропускная способность: ${bars.length} ${pluralRu(bars.length, ["замер", "замера", "замеров"])} за ${durationLabel(windowSeconds)}, сейчас загрузка ${formatRate(latest?.down ?? 0)}, отдача ${formatRate(latest?.up ?? 0)}, минимум ${formatRate(minimum)}, пик ${formatRate(peak)}.`;

  return (
    <section
      aria-label="Пропускная способность"
      className="traffic-chart overflow-hidden rounded-lg border border-border-subtle bg-surface"
    >
      <header className="traffic-chart-header flex min-w-0 items-center justify-between gap-3 border-b border-border-subtle px-3 py-[11px]">
        <h2 className="traffic-chart-title min-w-0 truncate text-micro font-semibold tracking-[0.04em] text-text-secondary">
          ПРОПУСКНАЯ СПОСОБНОСТЬ
        </h2>
        <div
          aria-hidden="true"
          className="traffic-chart-legend flex shrink-0 items-center gap-2 text-axis"
        >
          <span className="flex items-center gap-1 text-accent-text">
            <span className="traffic-chart-swatch hidden h-2.5 w-2.5 rounded-sm bg-accent" />↓
            загрузка
          </span>
          <span className="flex items-center gap-1 text-online">
            <span className="traffic-chart-swatch hidden h-2.5 w-2.5 rounded-sm bg-online" />↑
            отдача
          </span>
        </div>
      </header>
      <p className="sr-only">{accessibleSummary}</p>
      <div className="traffic-chart-body traffic-throughput-body p-3">
        <div className="traffic-chart-variant--compact flex flex-col">
          <ThroughputWindow
            bars={compactBars}
            slots={COMPACT_TRAFFIC_CAP}
            testId="traffic-throughput-bars-compact"
          />
        </div>
        <div className="traffic-chart-variant--wide hidden flex-col">
          <ThroughputWindow bars={bars} slots={TRAFFIC_CAP} testId="traffic-throughput-bars" />
        </div>
      </div>
    </section>
  );
}
