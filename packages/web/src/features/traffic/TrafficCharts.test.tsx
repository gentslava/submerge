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
        "Задержка основного канала через nl-ams-01: сейчас таймаут, минимум 48 ms, максимум 72 ms, 3 замера за 15 мин.",
      ),
    ).toHaveClass("sr-only");
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
  });

  it("renders a visible baseline for real zero samples", () => {
    render(<ThroughputChart samples={[{ up: 0, down: 0, at: 1_000 }]} />);

    expect(screen.getByTestId("traffic-throughput-zero")).toBeInTheDocument();
  });
});
