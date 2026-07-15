import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_APPEND_DURATION_MS, isSingleAppend, useChartAppendMotion } from "./chart-motion";

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
let animateMock: ReturnType<typeof vi.fn>;

function motionPreference(reduced: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduced,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function MotionHarness({
  identities,
  series = "default",
  enabled = true,
}: {
  identities: string[];
  series?: string;
  enabled?: boolean;
}) {
  const ref = useChartAppendMotion({ identities, series, enabled, gapPx: 3 });
  return (
    <div ref={ref}>
      {identities.map((identity) => (
        <span data-chart-column key={identity}>
          <span data-chart-fill />
        </span>
      ))}
    </div>
  );
}

beforeEach(() => {
  motionPreference(false);
  animateMock = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    writable: true,
    value: animateMock,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

describe("isSingleAppend", () => {
  it("recognizes growing and full rolling windows", () => {
    expect(isSingleAppend(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(isSingleAppend(["a", "b"], ["b", "c"])).toBe(true);
    expect(isSingleAppend([], ["a"])).toBe(true);
  });

  it("rejects hydration batches, replacement, reset, and unchanged windows", () => {
    expect(isSingleAppend([], ["a", "b"])).toBe(false);
    expect(isSingleAppend(["a"], ["x"])).toBe(false);
    expect(isSingleAppend(["a", "b"], ["x", "y"])).toBe(false);
    expect(isSingleAppend(["a", "b"], ["b", "a"])).toBe(false);
    expect(isSingleAppend(["a"], [])).toBe(false);
    expect(isSingleAppend(["a"], ["a"])).toBe(false);
  });
});

describe("useChartAppendMotion", () => {
  it("moves existing columns left and grows only the new rightmost fill", () => {
    const { rerender } = render(<MotionHarness identities={["a", "b"]} />);
    expect(animateMock).not.toHaveBeenCalled();

    rerender(<MotionHarness identities={["a", "b", "c"]} />);

    const calls = animateMock.mock.calls as [Keyframe[], KeyframeAnimationOptions][];
    const shifts = calls.filter(([frames]) =>
      String(frames[0]?.transform).startsWith("translateX"),
    );
    const growth = calls.filter(([frames]) => frames[0]?.transform === "scaleY(0)");
    expect(shifts).toHaveLength(2);
    expect(shifts[0]?.[0]).toEqual([
      { transform: "translateX(calc(100% + 3px))" },
      { transform: "translateX(0)" },
    ]);
    expect(growth).toHaveLength(1);
    expect(growth[0]?.[0]).toEqual([
      { transform: "scaleY(0)", transformOrigin: "bottom" },
      { transform: "scaleY(1)", transformOrigin: "bottom" },
    ]);
    expect(calls.every(([, options]) => options.duration === CHART_APPEND_DURATION_MS)).toBe(true);
  });

  it("does not replay samples collected while inspection is frozen", () => {
    const { rerender } = render(<MotionHarness identities={["a", "b"]} />);

    rerender(<MotionHarness identities={["a", "b", "c"]} enabled={false} />);
    rerender(<MotionHarness identities={["a", "b", "c"]} />);
    expect(animateMock).not.toHaveBeenCalled();

    rerender(<MotionHarness identities={["a", "b", "c", "d"]} />);
    expect(animateMock).toHaveBeenCalled();
  });

  it("does not animate series replacement or reduced-motion presentation", () => {
    const { rerender } = render(<MotionHarness identities={["a"]} series="first" />);

    rerender(<MotionHarness identities={["x"]} series="second" />);
    expect(animateMock).not.toHaveBeenCalled();

    motionPreference(true);
    rerender(<MotionHarness identities={["x", "y"]} series="second" />);
    expect(animateMock).not.toHaveBeenCalled();
  });
});
