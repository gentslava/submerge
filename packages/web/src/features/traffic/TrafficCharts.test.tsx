import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThroughputChart, TrafficLatencyChart } from "./TrafficCharts";

describe("TrafficLatencyChart", () => {
  it("hides decorative bars and exposes the real latency window to assistive tech", () => {
    render(
      <TrafficLatencyChart
        node="nl-ams-01"
        current={0}
        samples={[48, 0, 72]}
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
        <TrafficLatencyChart node="nl-ams-01" current={48} samples={[]} checkIntervalSec={300} />
        <ThroughputChart samples={[{ up: 10, down: 20, at: 1_000 }]} />
      </>,
    );

    expect(screen.getByText("Нет данных о задержке", { exact: true })).toBeVisible();
    expect(screen.queryByText("сейчас", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Пропускная способность" })).toBeInTheDocument();
  });
});

describe("ThroughputChart", () => {
  it("hides decorative columns and summarizes the actual sample window", () => {
    render(
      <ThroughputChart
        samples={[
          { up: 100, down: 400, at: 1_000 },
          { up: 250, down: 750, at: 3_000 },
        ]}
      />,
    );

    expect(screen.getByTestId("traffic-throughput-bars")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(/2 замера за 2 с/)).toHaveClass("sr-only");
    expect(screen.getByText(/минимум 500 Б\/с, пик 1000 Б\/с/)).toHaveClass("sr-only");
  });

  it("compresses the full throughput window into the compact 18-slot plot", () => {
    render(
      <ThroughputChart
        samples={[
          { up: 0, down: 1_000, at: 1_000 },
          ...Array.from({ length: 59 }, (_, index) => ({
            up: 0,
            down: 100,
            at: 2_000 + index * 1_000,
          })),
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
    render(<ThroughputChart samples={[{ up: 0, down: 0, at: 1_000 }]} />);

    expect(screen.getByTestId("traffic-throughput-bars-zero")).toBeInTheDocument();
  });
});
