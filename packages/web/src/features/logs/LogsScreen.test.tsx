import type { LogStreamMessage } from "@submerge/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogsScreen } from "./LogsScreen";

interface LogsObserver {
  onData(event: { data: LogStreamMessage }): void;
  onError(): void;
  onConnectionStateChange(state: { state: string }): void;
}

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  observer: null as LogsObserver | null,
  unsubscribe: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ isPending: false, mutate: mocks.clear }),
}));

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({ logs: { clear: { mutationOptions: () => ({}) } } }),
  useTRPCClient: (() => {
    const client = {
      logs: {
        stream: {
          subscribe: (_input: undefined, observer: LogsObserver) => {
            mocks.observer = observer;
            return { unsubscribe: mocks.unsubscribe };
          },
        },
      },
    };
    return () => client;
  })(),
}));

beforeEach(() => {
  mocks.clear.mockReset();
  mocks.observer = null;
  mocks.unsubscribe.mockReset();
});

describe("LogsScreen", () => {
  it("subscribes once, pauses presentation, resumes atomically, and unsubscribes", () => {
    const { unmount } = render(<LogsScreen />);
    const observer = mocks.observer;
    if (!observer) throw new Error("logs observer was not registered");

    expect(screen.getByText("Подключаем поток событий…")).toBeInTheDocument();
    act(() => {
      observer.onData({
        data: {
          type: "snapshot",
          cursor: 1,
          upstream: "live",
          nextRetryAt: null,
          events: [
            {
              id: 1,
              time: "2026-07-16T00:00:01.000Z",
              source: "mihomo",
              level: "info",
              message: "first event",
            },
          ],
        },
      });
    });
    expect(screen.getByText("first event")).toBeInTheDocument();
    expect(screen.getByText("1 запись")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));
    act(() => {
      observer.onData({
        data: {
          type: "append",
          cursor: 2,
          event: {
            id: 2,
            time: "2026-07-16T00:00:02.000Z",
            source: "submerge",
            level: "warning",
            message: "second event",
          },
        },
      });
    });
    expect(screen.queryByText("second event")).not.toBeInTheDocument();
    expect(screen.getByText("1 запись")).toBeInTheDocument();
    expect(screen.getByText("1 новых")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(screen.getByText("second event")).toBeInTheDocument();
    expect(screen.getByText("2 записи")).toBeInTheDocument();
    expect(screen.queryByText("1 новых")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    expect(mocks.clear).toHaveBeenCalledTimes(1);

    unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("retains rows when the browser transport reconnects", () => {
    render(<LogsScreen />);
    const observer = mocks.observer;
    if (!observer) throw new Error("logs observer was not registered");
    act(() => {
      observer.onData({
        data: {
          type: "snapshot",
          cursor: 1,
          upstream: "live",
          nextRetryAt: null,
          events: [
            {
              id: 1,
              time: "2026-07-16T00:00:01.000Z",
              source: "mihomo",
              level: "error",
              message: "retained event",
            },
          ],
        },
      });
      observer.onConnectionStateChange({ state: "connecting" });
    });

    expect(screen.getByText("retained event")).toBeInTheDocument();
    expect(screen.getByText(/показываем последние события/i)).toBeInTheDocument();
  });

  it("filters by source, severity, and text then resets filtered empty", () => {
    render(<LogsScreen />);
    const observer = mocks.observer;
    if (!observer) throw new Error("logs observer was not registered");
    act(() => {
      observer.onData({
        data: {
          type: "snapshot",
          cursor: 2,
          upstream: "live",
          nextRetryAt: null,
          events: [
            {
              id: 1,
              time: "2026-07-16T00:00:01.000Z",
              source: "mihomo",
              level: "info",
              message: "YouTube connected",
            },
            {
              id: 2,
              time: "2026-07-16T00:00:02.000Z",
              source: "submerge",
              level: "warning",
              message: "Сбой получения данных mihomo",
            },
          ],
        },
      });
    });

    expect(screen.getByText("2 записи")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Поиск в логах"), { target: { value: "missing" } });
    expect(screen.getByText("Найдено 0 · среди 2 записей")).toBeInTheDocument();
    expect(screen.getByText("По фильтрам ничего не найдено")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(screen.getByText("YouTube connected")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Источник"), { target: { value: "submerge" } });
    fireEvent.click(screen.getByRole("button", { name: "WARN" }));
    expect(screen.getByText("Найдено 1 · среди 2 записей")).toBeInTheDocument();
    expect(screen.getByText("Сбой получения данных mihomo")).toBeInTheDocument();
    expect(screen.queryByText("YouTube connected")).not.toBeInTheDocument();
  });
});
