import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export function Chart({
  data,
  height = 96,
  makeOpts,
}: {
  data: uPlot.AlignedData;
  height?: number;
  makeOpts: (width: number) => uPlot.Options;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);

  // uPlot is created once on mount; `makeOpts`/`data`/`height` are read at init only,
  // and subsequent data changes are pushed via the setData effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only — re-running would destroy/recreate the uPlot instance on every parent render
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const width = el.clientWidth || 320;
    const u = new uPlot(makeOpts(width), data, el);
    uRef.current = u;
    const ro = new ResizeObserver(() => {
      u.setSize({ width: el.clientWidth || width, height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      uRef.current = null;
    };
  }, []);

  useEffect(() => {
    uRef.current?.setData(data);
  }, [data]);

  return <div ref={elRef} style={{ height }} />;
}
