import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { formatRate } from "@/features/nodes/nodeView";
import { pluralRu } from "@/lib/plural";
import { cn } from "@/lib/utils";
import { useChartAppendMotion } from "./chart-motion";
import type { TrafficBucketSample } from "./presentation";
import { chartSummary, throughputPeak } from "./state";

const LATENCY_CAP = 40;
const TRAFFIC_CAP = 20;
const COMPACT_LATENCY_CAP = 24;
const COMPACT_TRAFFIC_CAP = 20;
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

interface TimedLatencySample {
  value: number;
  at: number | null;
  key: string;
}

interface InspectorState<T> {
  frozen: readonly T[] | null;
  selectedKey: string | null;
  pinned: boolean;
  position: number;
}

const EMPTY_INSPECTOR = {
  frozen: null,
  selectedKey: null,
  pinned: false,
  position: 100,
} as const;

const TIME_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function timeLabel(timestamp: number): string {
  return TIME_FORMATTER.format(new Date(timestamp));
}

function positionForSlot(index: number, count: number, slots: number): number {
  if (count <= 1 || slots <= 1) return 100;
  if (count >= slots) return (index / (count - 1)) * 100;
  return ((slots - count + index) / (slots - 1)) * 100;
}

function useChartInspector<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  slots: number | readonly [compact: number, wide: number],
) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<InspectorState<T>>(EMPTY_INSPECTOR);
  const visibleValues = state.frozen ?? values;
  const selectedIndex = visibleValues.findIndex((value) => keyOf(value) === state.selectedKey);
  const selected = selectedIndex >= 0 ? (visibleValues[selectedIndex] ?? null) : null;

  function activeSlots(): number {
    if (typeof slots === "number") return slots;
    return (rootRef.current?.clientWidth ?? 0) < 672 ? slots[0] : slots[1];
  }

  function select(index: number, pinned = false): void {
    if (values.length === 0 && visibleValues.length === 0) return;
    setState((current) => {
      const frozen = current.frozen ?? [...values];
      const safeIndex = Math.max(0, Math.min(index, frozen.length - 1));
      const value = frozen[safeIndex];
      if (value === undefined) return current;
      return {
        frozen,
        selectedKey: keyOf(value),
        pinned: pinned || current.pinned,
        position: positionForSlot(safeIndex, frozen.length, activeSlots()),
      };
    });
  }

  function inspect(
    value: T,
    index: number,
    pinned = false,
    renderedSlots = activeSlots(),
    renderedCount = values.length,
  ): void {
    const valueKey = keyOf(value);
    setState((current) => ({
      frozen: current.frozen ?? [...values],
      selectedKey: valueKey,
      pinned: pinned || current.pinned,
      position: positionForSlot(index, renderedCount, renderedSlots),
    }));
  }

  const clear = useCallback((): void => {
    setState(EMPTY_INSPECTOR);
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      clear();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (selectedIndex >= 0) setState((current) => ({ ...current, pinned: true }));
      else select(visibleValues.length - 1, true);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const start = selectedIndex >= 0 ? selectedIndex : visibleValues.length - 1;
    select(start + (event.key === "ArrowLeft" ? -1 : 1));
  }

  useEffect(() => {
    if (!state.pinned) return;
    const onOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) clear();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    document.addEventListener("pointerdown", onOutsidePress);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onOutsidePress);
      document.removeEventListener("keydown", onEscape);
    };
  }, [state.pinned, clear]);

  return {
    rootRef,
    visibleValues,
    selected,
    selectedKey: state.selectedKey,
    pinned: state.pinned,
    position: state.position,
    inspect,
    clear,
    onKeyDown,
    onFocus: () => {
      if (state.selectedKey === null) select(visibleValues.length - 1);
    },
    onBlur: (event: ReactFocusEvent<HTMLElement>) => {
      if (!state.pinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
        clear();
      }
    },
    onClick: () => {
      if (selectedIndex >= 0) setState((current) => ({ ...current, pinned: true }));
      else select(visibleValues.length - 1, true);
    },
    onPointerLeave: () => {
      if (!state.pinned) clear();
    },
  };
}

function ChartKeyboardControl({
  label,
  describedBy,
  onFocus,
  onClick,
  onKeyDown,
}: {
  label: string;
  describedBy: string | undefined;
  onFocus: () => void;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-describedby={describedBy}
      onFocus={onFocus}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-20 focus:rounded-md focus:border focus:border-border-default focus:bg-elevated focus:px-2.5 focus:py-2 focus:text-micro focus:text-text-primary focus:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {label}
    </button>
  );
}

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

function compactLatency(values: readonly TimedLatencySample[]): TimedLatencySample[] {
  return compressWindow(values, COMPACT_LATENCY_CAP, (bucket) => {
    const timeout = bucket.find((sample) => sample.value <= 0);
    if (timeout) return timeout;
    return bucket.reduce((maximum, sample) => (sample.value > maximum.value ? sample : maximum));
  });
}

function compactThroughput(values: readonly TrafficBucketSample[]): TrafficBucketSample[] {
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

function throughputLevels(sample: TrafficBucketSample, peak: number): { up: number; down: number } {
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
  selectedKey,
  onInspect,
  motionIdentities,
  motionSeries,
  motionEnabled,
}: {
  bars: readonly TimedLatencySample[];
  slots: number;
  checkIntervalSec: number;
  windowSampleCount?: number;
  testId: string;
  selectedKey: string | null;
  onInspect: (
    sample: TimedLatencySample,
    index: number,
    pinned?: boolean,
    slots?: number,
    count?: number,
  ) => void;
  motionIdentities: readonly string[];
  motionSeries: string;
  motionEnabled: boolean;
}) {
  const summary = chartSummary(bars.map((sample) => sample.value));
  const peak = summary.max ?? 1;
  const windowSeconds = latencyWindowSeconds(windowSampleCount ?? summary.count, checkIntervalSec);
  const motionRef = useChartAppendMotion({
    identities: motionIdentities,
    series: motionSeries,
    enabled: motionEnabled,
    gapPx: 2,
  });

  return (
    <>
      <div
        ref={motionRef}
        aria-hidden="true"
        data-testid={testId}
        className="traffic-latency-plot flex h-20 items-stretch gap-0.5"
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

          const timeout = sample.value <= 0;
          const recent = index >= bars.length - RECENT_LATENCY_BARS;
          return (
            <button
              data-chart-column
              type="button"
              tabIndex={-1}
              aria-label={sample.value <= 0 ? "таймаут" : `${sample.value} ms`}
              key={sample.key}
              data-testid="traffic-latency-sample"
              onPointerEnter={() => onInspect(sample, index, false, slots, bars.length)}
              onClick={(event) => {
                event.stopPropagation();
                onInspect(sample, index, true, slots, bars.length);
              }}
              className={cn(
                "flex min-w-0 flex-1 cursor-crosshair items-end rounded-sm border-0 bg-transparent p-0 outline-none",
                selectedKey === sample.key &&
                  "ring-1 ring-accent ring-offset-1 ring-offset-surface",
              )}
            >
              <span
                data-chart-fill
                className={cn(
                  "w-full rounded-sm",
                  timeout ? "h-full bg-timeout" : heightClass(barLevel(sample.value, peak)),
                  !timeout && (recent ? "bg-accent" : "bg-chart-track"),
                )}
              />
            </button>
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
  selectedAt,
  onInspect,
  motionIdentities,
  motionEnabled,
}: {
  bars: readonly TrafficBucketSample[];
  slots: number;
  testId: string;
  selectedAt: number | null;
  onInspect: (
    sample: TrafficBucketSample,
    index: number,
    pinned?: boolean,
    slots?: number,
    count?: number,
  ) => void;
  motionIdentities: readonly string[];
  motionEnabled: boolean;
}) {
  const peak = throughputPeak(bars);
  const motionRef = useChartAppendMotion({
    identities: motionIdentities,
    series: "throughput",
    enabled: motionEnabled,
    gapPx: 3,
  });

  return (
    <div
      ref={motionRef}
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
            <button
              data-chart-column
              type="button"
              tabIndex={-1}
              aria-label={`загрузка ${formatRate(sample.down)}, отдача ${formatRate(sample.up)}, пик ${formatRate(sample.peak)}`}
              key={sample.at}
              data-testid="traffic-throughput-sample"
              onPointerEnter={() => onInspect(sample, index, false, slots, bars.length)}
              onClick={(event) => {
                event.stopPropagation();
                onInspect(sample, index, true, slots, bars.length);
              }}
              className={cn(
                "flex min-w-0 flex-1 cursor-crosshair items-end rounded-sm border-0 bg-transparent p-0",
                selectedAt === sample.at && "ring-1 ring-accent ring-offset-1 ring-offset-surface",
              )}
            >
              <span
                data-chart-fill
                data-testid={`${testId}-zero`}
                className="h-[3px] w-full rounded-sm bg-chart-track"
              />
            </button>
          );
        }

        const levels = throughputLevels(sample, peak);
        return (
          <button
            data-chart-column
            type="button"
            tabIndex={-1}
            aria-label={`загрузка ${formatRate(sample.down)}, отдача ${formatRate(sample.up)}, пик ${formatRate(sample.peak)}`}
            key={sample.at}
            data-testid="traffic-throughput-sample"
            onPointerEnter={() => onInspect(sample, index, false, slots, bars.length)}
            onClick={(event) => {
              event.stopPropagation();
              onInspect(sample, index, true, slots, bars.length);
            }}
            className={cn(
              "flex min-w-0 flex-1 cursor-crosshair flex-col justify-end gap-px rounded-sm border-0 bg-transparent p-0",
              selectedAt === sample.at && "ring-1 ring-accent ring-offset-1 ring-offset-surface",
            )}
          >
            {levels.up > 0 ? (
              <span
                data-chart-fill
                className={cn("w-full rounded-t-sm bg-online", heightClass(levels.up))}
              />
            ) : null}
            {levels.down > 0 ? (
              <span
                data-chart-fill
                className={cn("w-full rounded-b-sm bg-accent", heightClass(levels.down))}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function TooltipShell({
  id,
  position,
  children,
}: {
  id: string;
  position: number;
  children: ReactNode;
}) {
  const edge = position <= 25 ? "left" : position >= 75 ? "right" : "center";
  return (
    <div
      id={id}
      role="tooltip"
      aria-live="polite"
      style={
        edge === "left"
          ? { left: "0.75rem" }
          : edge === "right"
            ? { right: "0.75rem" }
            : { left: `${position}%` }
      }
      className={cn(
        "pointer-events-none absolute top-2 z-10 min-w-40 max-w-[calc(100%-1.5rem)] rounded-md border border-border-default bg-elevated px-2.5 py-2 shadow-sm",
        edge === "center" && "-translate-x-1/2",
      )}
    >
      {children}
    </div>
  );
}

function LatencyTooltip({
  id,
  sample,
  position,
  pinned,
}: {
  id: string;
  sample: TimedLatencySample;
  position: number;
  pinned: boolean;
}) {
  return (
    <TooltipShell id={id} position={position}>
      <div className="flex items-center justify-between gap-3 font-mono text-micro">
        {sample.at === null ? (
          <span className="text-text-tertiary">время неизвестно</span>
        ) : (
          <time dateTime={new Date(sample.at).toISOString()} className="text-text-tertiary">
            {timeLabel(sample.at)}
          </time>
        )}
        {pinned ? <span className="text-accent-text">закреплено</span> : null}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-xs font-medium",
          sample.value <= 0 ? "text-timeout" : "text-online",
        )}
      >
        {latencyValue(sample.value)}
      </div>
    </TooltipShell>
  );
}

function ThroughputTooltip({
  id,
  sample,
  position,
  pinned,
}: {
  id: string;
  sample: TrafficBucketSample;
  position: number;
  pinned: boolean;
}) {
  const dateTime = `${new Date(sample.startedAt).toISOString()}/${new Date(sample.endedAt).toISOString()}`;
  return (
    <TooltipShell id={id} position={position}>
      <div className="flex items-center justify-between gap-3 font-mono text-micro text-text-tertiary">
        <time dateTime={dateTime}>
          {timeLabel(sample.startedAt)}–{timeLabel(sample.endedAt)}
        </time>
        {pinned ? <span className="text-accent-text">закреплено</span> : null}
      </div>
      <div className="mt-1 flex items-center gap-3 font-mono text-micro">
        <span className="text-accent-text">↓ {formatRate(sample.down)}</span>
        <span className="text-online">↑ {formatRate(sample.up)}</span>
      </div>
      <div className="mt-1 font-mono text-axis text-text-tertiary">
        среднее · пик {formatRate(sample.peak)}
      </div>
    </TooltipShell>
  );
}

export function TrafficLatencyChart({
  node,
  current,
  samples,
  sampleTimes,
  checkIntervalSec,
}: {
  node: string | null;
  current: number | null;
  samples: readonly number[];
  sampleTimes: readonly (number | null)[];
  checkIntervalSec: number;
}) {
  const offset = Math.max(0, samples.length - LATENCY_CAP);
  const bars = samples.slice(-LATENCY_CAP).map((value, index) => {
    const sourceIndex = offset + index;
    const at = sampleTimes[sourceIndex] ?? null;
    return {
      value,
      at,
      key: at === null ? `unknown-${sourceIndex}-${value}` : `at-${at}`,
    } satisfies TimedLatencySample;
  });
  const inspector = useChartInspector(bars, (sample) => sample.key, [
    COMPACT_LATENCY_CAP,
    LATENCY_CAP,
  ]);
  const tooltipId = useId();
  const wideMotionIdentities = bars.map((sample) => sample.key);
  const compactMotionIdentities = compactLatency(bars).map((sample) => sample.key);
  const motionSeries = node ?? "no-active-node";
  const motionEnabled = inspector.selected === null;
  const visibleBars = inspector.visibleValues;
  const compactBars = compactLatency(visibleBars);
  const summary = chartSummary(bars.map((sample) => sample.value));
  const windowSeconds = latencyWindowSeconds(summary.count, checkIntervalSec);
  const nodePhrase = node ? ` через ${node}` : "";
  const accessibleSummary =
    summary.count === 0
      ? `Нет данных о задержке${nodePhrase}. Текущее значение: ${latencyValue(current)}.`
      : `Задержка основного канала${nodePhrase}: сейчас ${latencyValue(current)}, минимум ${latencyValue(summary.min)}, максимум ${latencyValue(summary.max)}, ${summary.count} ${pluralRu(summary.count, ["замер", "замера", "замеров"])} за ${durationLabel(windowSeconds)}.`;

  return (
    <section
      ref={inspector.rootRef}
      aria-label="Задержка основного канала"
      onBlur={inspector.onBlur}
      onPointerLeave={inspector.onPointerLeave}
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
      <div className="traffic-chart-body relative flex flex-col gap-1.5 p-3">
        <ChartKeyboardControl
          label="Исследовать график задержки"
          describedBy={inspector.selected ? tooltipId : undefined}
          onFocus={inspector.onFocus}
          onClick={inspector.onClick}
          onKeyDown={inspector.onKeyDown}
        />
        {inspector.selected ? (
          <LatencyTooltip
            id={tooltipId}
            sample={inspector.selected}
            position={inspector.position}
            pinned={inspector.pinned}
          />
        ) : null}
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
                selectedKey={inspector.selectedKey}
                onInspect={inspector.inspect}
                motionIdentities={compactMotionIdentities}
                motionSeries={motionSeries}
                motionEnabled={motionEnabled}
              />
            </div>
            <div className="traffic-chart-variant--wide hidden flex-col gap-2.5">
              <LatencyWindow
                bars={visibleBars}
                slots={LATENCY_CAP}
                checkIntervalSec={checkIntervalSec}
                testId="traffic-latency-bars"
                selectedKey={inspector.selectedKey}
                onInspect={inspector.inspect}
                motionIdentities={wideMotionIdentities}
                motionSeries={motionSeries}
                motionEnabled={motionEnabled}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function ThroughputChart({ samples }: { samples: readonly TrafficBucketSample[] }) {
  const sourceBars = samples.slice(-TRAFFIC_CAP);
  const inspector = useChartInspector(sourceBars, (sample) => String(sample.at), TRAFFIC_CAP);
  const tooltipId = useId();
  const motionIdentities = sourceBars.map((sample) => String(sample.at));
  const motionEnabled = inspector.selected === null;
  const bars = inspector.visibleValues;
  const compactBars = compactThroughput(bars);
  const rawPeak = bars.reduce((value, sample) => Math.max(value, sample.peak), 0);
  const minimum = bars.reduce(
    (value, sample) => Math.min(value, sample.up + sample.down),
    Number.POSITIVE_INFINITY,
  );
  const latest = bars.at(-1) ?? null;
  const windowSeconds =
    bars.length > 0
      ? Math.max(0, Math.round(((latest?.endedAt ?? 0) - (bars[0]?.startedAt ?? 0)) / 1_000))
      : 0;
  const accessibleSummary =
    bars.length === 0
      ? "Нет данных о пропускной способности."
      : `Пропускная способность: ${bars.length} ${pluralRu(bars.length, ["замер", "замера", "замеров"])} за ${durationLabel(windowSeconds)}, сейчас загрузка ${formatRate(latest?.down ?? 0)}, отдача ${formatRate(latest?.up ?? 0)}, минимум ${formatRate(minimum)}, пик ${formatRate(rawPeak)}.`;

  return (
    <section
      ref={inspector.rootRef}
      aria-label="Пропускная способность"
      onBlur={inspector.onBlur}
      onPointerLeave={inspector.onPointerLeave}
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
      <div className="traffic-chart-body traffic-throughput-body relative p-3">
        <ChartKeyboardControl
          label="Исследовать пропускную способность"
          describedBy={inspector.selected ? tooltipId : undefined}
          onFocus={inspector.onFocus}
          onClick={inspector.onClick}
          onKeyDown={inspector.onKeyDown}
        />
        {inspector.selected ? (
          <ThroughputTooltip
            id={tooltipId}
            sample={inspector.selected}
            position={inspector.position}
            pinned={inspector.pinned}
          />
        ) : null}
        <div className="traffic-chart-variant--compact flex flex-col">
          <ThroughputWindow
            bars={compactBars}
            slots={COMPACT_TRAFFIC_CAP}
            testId="traffic-throughput-bars-compact"
            selectedAt={inspector.selected?.at ?? null}
            onInspect={inspector.inspect}
            motionIdentities={motionIdentities}
            motionEnabled={motionEnabled}
          />
        </div>
        <div className="traffic-chart-variant--wide hidden flex-col">
          <ThroughputWindow
            bars={bars}
            slots={TRAFFIC_CAP}
            testId="traffic-throughput-bars"
            selectedAt={inspector.selected?.at ?? null}
            onInspect={inspector.inspect}
            motionIdentities={motionIdentities}
            motionEnabled={motionEnabled}
          />
        </div>
      </div>
    </section>
  );
}
