import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TrafficBucketSample } from "./presentation";
import { TrafficDashboardView, type TrafficDashboardViewProps } from "./TrafficScreen";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

function props(overrides: Partial<TrafficDashboardViewProps> = {}): TrafficDashboardViewProps {
  return {
    state: "populated",
    downloadRate: 9.4 * 1024 * 1024,
    uploadRate: 1.31 * 1024 * 1024,
    connectionCount: 12,
    sessionBytes: 42 * 1024 * 1024,
    connectionsUnavailable: false,
    activeNode: "nl-ams-01",
    trafficSamples: [
      {
        up: 1.31 * 1024 * 1024,
        down: 9.4 * 1024 * 1024,
        at: 3_000,
        startedAt: 0,
        endedAt: 3_000,
        peak: 11 * 1024 * 1024,
        sampleCount: 3,
      } satisfies TrafficBucketSample,
    ],
    latencyCurrent: 48,
    latencySamples: [45, 48],
    latencySampleTimes: [1_000, 2_000],
    checkIntervalSec: 300,
    resetDisabled: false,
    onReset: vi.fn(),
    ...overrides,
  };
}

describe("TrafficDashboardView", () => {
  it("renders the approved heading, formatted metrics, and a real Connections link", () => {
    render(<TrafficDashboardView {...props()} />);

    expect(screen.getByRole("heading", { name: "Трафик" })).toBeInTheDocument();
    expect(screen.getByText("Суммарный трафик всех каналов · mihomo")).toBeInTheDocument();
    expect(screen.getByTitle("9.4 МБ/с")).toBeInTheDocument();
    expect(screen.getByTitle("1.3 МБ/с")).toBeInTheDocument();
    expect(screen.getByTitle("42.0 МБ")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "12 соединений — открыть экран Соединения" }),
    ).toHaveAttribute("href", "/connections");
  });

  it("distinguishes missing values, honest zeros, and a Connections-only failure", () => {
    const { rerender } = render(
      <TrafficDashboardView
        {...props({
          state: "loading",
          downloadRate: null,
          uploadRate: null,
          connectionCount: null,
          sessionBytes: null,
          activeNode: null,
        })}
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "Live-метрики трафика" })).getAllByText("—"),
    ).toHaveLength(4);
    expect(screen.queryByText("0 Б/с")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Соединения загружаются — открыть экран Соединения" }),
    ).toBeInTheDocument();

    rerender(
      <TrafficDashboardView
        {...props({
          state: "idle",
          downloadRate: 0,
          uploadRate: 0,
          connectionCount: 0,
          sessionBytes: 0,
        })}
      />,
    );
    expect(screen.getAllByTitle("0 Б/с")).toHaveLength(2);
    expect(screen.getByTitle("0 Б")).toBeInTheDocument();

    rerender(
      <TrafficDashboardView {...props({ connectionCount: null, connectionsUnavailable: true })} />,
    );
    expect(screen.getByText("Соединения недоступны")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Соединения недоступны — открыть экран Соединения" }),
    ).toBeInTheDocument();
    expect(screen.getByTitle("9.4 МБ/с")).toBeInTheDocument();
  });

  it("renders loading, idle, reconnecting, and no-node states with text", () => {
    const { rerender } = render(<TrafficDashboardView {...props({ state: "loading" })} />);
    expect(screen.getByText("Подключаем live-метрики")).toBeInTheDocument();

    rerender(<TrafficDashboardView {...props({ state: "idle" })} />);
    expect(screen.getByText("Прокси подключён, трафика нет")).toBeInTheDocument();
    expect(screen.getByText("Трафик появится после первого запроса")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Пропускная способность" }),
    ).not.toBeInTheDocument();

    rerender(<TrafficDashboardView {...props({ state: "reconnecting" })} />);
    expect(screen.getByText("Переподключаемся к mihomo")).toBeInTheDocument();
    expect(screen.getByText("Нет новых данных · повторяем автоматически")).toBeInTheDocument();
    expect(screen.getByTitle("9.4 МБ/с")).toBeInTheDocument();

    rerender(<TrafficDashboardView {...props({ state: "no-nodes" })} />);
    expect(screen.getByText("Добавьте первый источник")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Перейти к источникам" })).toHaveAttribute(
      "href",
      "/sources",
    );
  });

  it("keeps the complete active-node name available when the label truncates", () => {
    const activeNode = "very-long-active-node-name-that-must-not-be-lost";
    render(<TrafficDashboardView {...props({ activeNode })} />);

    expect(screen.getAllByTitle(activeNode)).toHaveLength(2);
    expect(
      screen.getByText(activeNode, { selector: ".traffic-latency-node-compact" }),
    ).toBeInTheDocument();
  });

  it("exposes the local session reset as an accessible, disableable button", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    const { rerender } = render(<TrafficDashboardView {...props({ onReset })} />);

    await user.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(onReset).toHaveBeenCalledOnce();

    rerender(<TrafficDashboardView {...props({ onReset, resetDisabled: true })} />);
    expect(screen.getByRole("button", { name: "Сбросить" })).toBeDisabled();
  });
});
