import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrafficBucketSample } from "./presentation";
import { ThroughputChart, TrafficLatencyChart } from "./TrafficCharts";

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");

function installChartAnimationMock(reduced = false) {
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
  const animate = vi.fn(
    (_frames: Keyframe[], _options: KeyframeAnimationOptions) =>
      ({ cancel: vi.fn() }) as unknown as Animation,
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    writable: true,
    value: animate,
  });
  return animate;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

function bucket(
  startedAt: number,
  up: number,
  down: number,
  peak = up + down,
): TrafficBucketSample {
  return {
    up,
    down,
    at: startedAt + 3_000,
    startedAt,
    endedAt: startedAt + 3_000,
    peak,
    sampleCount: 3,
  };
}

describe("TrafficLatencyChart", () => {
  it("hides decorative bars and exposes the real latency window to assistive tech", () => {
    render(
      <TrafficLatencyChart
        node="nl-ams-01"
        current={0}
        samples={[48, 0, 72]}
        sampleTimes={[1_000, 2_000, 3_000]}
        checkIntervalSec={300}
      />,
    );

    expect(screen.getByTestId("traffic-latency-bars")).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByText(
        "Задержка основного канала через nl-ams-01: сейчас таймаут, минимум 48 ms, максимум 72 ms, 3 замера за 10 мин.",
      ),
    ).toHaveClass("sr-only");
  });

  it("compresses the full latency window into the compact 24-slot plot", () => {
    render(
      <TrafficLatencyChart
        node="nl-ams-01"
        current={100}
        samples={[1_000, ...Array.from({ length: 39 }, () => 100)]}
        sampleTimes={Array.from({ length: 40 }, (_, index) => index * 1_000)}
        checkIntervalSec={1}
      />,
    );

    expect(
      screen.getByTestId("traffic-latency-bars").lastElementChild?.firstElementChild,
    ).toHaveClass("h-[10%]");
    expect(
      screen.getByTestId("traffic-latency-bars-compact").lastElementChild?.firstElementChild,
    ).toHaveClass("h-[10%]");
    expect(
      screen.getByTestId("traffic-latency-bars-compact").firstElementChild?.firstElementChild,
    ).toHaveClass("h-full");
    expect(screen.getByTestId("traffic-latency-bars-compact-axis")).toHaveTextContent("−39 с");
  });

  it("keeps an empty latency series honest", () => {
    render(
      <>
        <TrafficLatencyChart
          node="nl-ams-01"
          current={48}
          samples={[]}
          sampleTimes={[]}
          checkIntervalSec={300}
        />
        <ThroughputChart samples={[bucket(0, 10, 20)]} />
      </>,
    );

    expect(screen.getByText("Нет данных о задержке", { exact: true })).toBeVisible();
    expect(screen.queryByText("сейчас", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Пропускная способность" })).toBeInTheDocument();
  });

  it("shows an immediate latency tooltip with the real measurement time", () => {
    render(
      <TrafficLatencyChart
        node="nl-ams-01"
        current={0}
        samples={[48, 0]}
        sampleTimes={[1_000, 2_000]}
        checkIntervalSec={10}
      />,
    );

    const bars = within(screen.getByTestId("traffic-latency-bars")).getAllByTestId(
      "traffic-latency-sample",
    );
    fireEvent.pointerEnter(bars[1] as HTMLElement);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("таймаут");
    expect(within(tooltip).getByRole("time")).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:02.000Z",
    );
  });

  it("shifts both latency variants and grows their new rightmost column", () => {
    const animate = installChartAnimationMock();
    const { rerender } = render(
      <TrafficLatencyChart
        node="nl-ams-01"
        current={48}
        samples={[48]}
        sampleTimes={[1_000]}
        checkIntervalSec={10}
      />,
    );

    rerender(
      <TrafficLatencyChart
        node="nl-ams-01"
        current={52}
        samples={[48, 52]}
        sampleTimes={[1_000, 2_000]}
        checkIntervalSec={10}
      />,
    );

    const calls = animate.mock.calls;
    expect(
      calls.filter(([frames]) => String(frames[0]?.transform).startsWith("translateX")),
    ).toHaveLength(2);
    expect(calls.filter(([frames]) => frames[0]?.transform === "scaleY(0)")).toHaveLength(2);
  });

  it("skips compact latency motion when rebucketing replaces its rendered columns", () => {
    const animate = installChartAnimationMock();
    const first = Array.from({ length: 25 }, (_, index) => index + 1);
    const second = [...first, 26];
    const firstTimes = first.map((value) => value * 1_000);
    const secondTimes = second.map((value) => value * 1_000);
    const { rerender } = render(
      <TrafficLatencyChart
        node="nl-ams-01"
        current={25}
        samples={first}
        sampleTimes={firstTimes}
        checkIntervalSec={10}
      />,
    );

    rerender(
      <TrafficLatencyChart
        node="nl-ams-01"
        current={26}
        samples={second}
        sampleTimes={secondTimes}
        checkIntervalSec={10}
      />,
    );

    const calls = animate.mock.calls;
    expect(
      calls.filter(([frames]) => String(frames[0]?.transform).startsWith("translateX")),
    ).toHaveLength(25);
    expect(calls.filter(([frames]) => frames[0]?.transform === "scaleY(0)")).toHaveLength(1);
  });
});

describe("ThroughputChart", () => {
  it("hides decorative columns and summarizes the actual sample window", () => {
    render(<ThroughputChart samples={[bucket(0, 100, 400), bucket(3_000, 250, 750)]} />);

    expect(screen.getByTestId("traffic-throughput-bars")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(/2 замера за 6 с/)).toHaveClass("sr-only");
    expect(screen.getByText(/минимум 500 Б\/с, пик 1000 Б\/с/)).toHaveClass("sr-only");
  });

  it("compresses the full throughput window into the compact 20-slot plot", () => {
    render(
      <ThroughputChart
        samples={[
          bucket(0, 0, 1_000),
          ...Array.from({ length: 19 }, (_, index) => bucket(3_000 + index * 3_000, 0, 100)),
        ]}
      />,
    );

    expect(
      screen.getByTestId("traffic-throughput-bars").lastElementChild?.firstElementChild,
    ).toHaveClass("h-[10%]");
    expect(
      screen.getByTestId("traffic-throughput-bars-compact").lastElementChild?.firstElementChild,
    ).toHaveClass("h-[10%]");
    expect(
      screen.getByTestId("traffic-throughput-bars-compact").firstElementChild?.firstElementChild,
    ).toHaveClass("h-full");
  });

  it("renders a visible baseline for real zero samples", () => {
    render(<ThroughputChart samples={[bucket(0, 0, 0)]} />);

    expect(screen.getByTestId("traffic-throughput-bars-zero")).toBeInTheDocument();
  });

  it("shows averaged rates and the raw peak immediately on hover", () => {
    render(<ThroughputChart samples={[bucket(0, 300, 600, 1_500)]} />);

    const bar = within(screen.getByTestId("traffic-throughput-bars")).getByTestId(
      "traffic-throughput-sample",
    );
    fireEvent.pointerEnter(bar);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("↓ 600 Б/с");
    expect(tooltip).toHaveTextContent("↑ 300 Б/с");
    expect(tooltip).toHaveTextContent("пик 1.5 КБ/с");
    expect(within(tooltip).getByRole("time")).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:00.000Z/1970-01-01T00:00:03.000Z",
    );
    expect(tooltip).toHaveStyle({ right: "0.75rem" });
  });

  it("announces keyboard inspection and resumes when focus leaves", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ThroughputChart samples={[bucket(0, 100, 200)]} />
        <button type="button">После графика</button>
      </>,
    );

    await user.tab();
    const control = screen.getByRole("button", {
      name: "Исследовать пропускную способность",
    });
    const tooltip = screen.getByRole("tooltip");
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-describedby", tooltip.id);

    await user.tab();
    expect(screen.getByRole("button", { name: "После графика" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("pins a frozen sample, supports keyboard traversal, and closes on Escape", async () => {
    const user = userEvent.setup();
    const first = bucket(0, 100, 200);
    const second = bucket(3_000, 300, 600);
    const third = bucket(6_000, 900, 1_800);
    const { rerender } = render(<ThroughputChart samples={[first, second]} />);
    const control = screen.getByRole("button", {
      name: "Исследовать пропускную способность",
    });

    await user.click(control);
    expect(screen.getByRole("tooltip")).toHaveTextContent("↓ 600 Б/с");

    await user.keyboard("{ArrowLeft}{Enter}");
    expect(screen.getByRole("tooltip")).toHaveTextContent("↓ 200 Б/с");

    rerender(<ThroughputChart samples={[first, second, third]} />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("↓ 200 Б/с");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes a pinned sample on an outside press", async () => {
    const user = userEvent.setup();
    render(<ThroughputChart samples={[bucket(0, 100, 200)]} />);

    await user.click(screen.getByRole("button", { name: "Исследовать пропускную способность" }));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shifts both throughput variants and grows their stacked rightmost column", () => {
    const animate = installChartAnimationMock();
    const first = bucket(0, 100, 200);
    const second = bucket(3_000, 300, 600);
    const { rerender } = render(<ThroughputChart samples={[first]} />);

    rerender(<ThroughputChart samples={[first, second]} />);

    const calls = animate.mock.calls;
    expect(
      calls.filter(([frames]) => String(frames[0]?.transform).startsWith("translateX")),
    ).toHaveLength(2);
    expect(calls.filter(([frames]) => frames[0]?.transform === "scaleY(0)")).toHaveLength(4);
  });
});
