import { useLayoutEffect, useRef } from "react";

export const CHART_APPEND_DURATION_MS = 280;
const CHART_APPEND_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export function isSingleAppend(previous: readonly string[], next: readonly string[]): boolean {
  if (next.length === 0) return false;
  const newest = next.at(-1);
  if (newest === undefined || previous.includes(newest)) return false;
  if (previous.length === 0) return next.length === 1;
  if (next.length === previous.length + 1) {
    return previous.every((identity, index) => identity === next[index]);
  }
  if (previous.length > 1 && next.length === previous.length) {
    return previous.slice(1).every((identity, index) => identity === next[index]);
  }
  return false;
}

export function useChartAppendMotion({
  identities,
  series,
  enabled,
  gapPx,
}: {
  identities: readonly string[];
  series: string;
  enabled: boolean;
  gapPx: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previousRef = useRef<{ series: string; identities: string[] } | null>(null);
  const signature = identities.join("\u0000");

  useLayoutEffect(() => {
    const next = signature === "" ? [] : signature.split("\u0000");
    const previous = previousRef.current;
    previousRef.current = { series, identities: next };
    if (
      !enabled ||
      previous === null ||
      previous.series !== series ||
      !isSingleAppend(previous.identities, next) ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const columns = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>("[data-chart-column]") ?? [],
    );
    const animations: Animation[] = [];
    for (const column of columns.slice(0, -1)) {
      if (typeof column.animate !== "function") continue;
      animations.push(
        column.animate(
          [{ transform: `translateX(calc(100% + ${gapPx}px))` }, { transform: "translateX(0)" }],
          { duration: CHART_APPEND_DURATION_MS, easing: CHART_APPEND_EASING },
        ),
      );
    }
    for (const fill of columns.at(-1)?.querySelectorAll<HTMLElement>("[data-chart-fill]") ?? []) {
      if (typeof fill.animate !== "function") continue;
      animations.push(
        fill.animate(
          [
            { transform: "scaleY(0)", transformOrigin: "bottom" },
            { transform: "scaleY(1)", transformOrigin: "bottom" },
          ],
          { duration: CHART_APPEND_DURATION_MS, easing: CHART_APPEND_EASING },
        ),
      );
    }
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [enabled, gapPx, series, signature]);

  return rootRef;
}
