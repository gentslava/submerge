import type { LiveEvent } from "@submerge/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLive } from "./useLive";

interface LiveObserver {
  onData(event: { data: LiveEvent }): void;
  onError(): void;
}

const mocks = vi.hoisted(() => ({
  observer: null as LiveObserver | null,
  setQueryData: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: mocks.setQueryData }),
}));

vi.mock("@/lib/trpc", () => {
  const trpc = { nodes: { list: { queryKey: () => ["nodes", "list"] } } };
  const client = {
    live: {
      stream: {
        subscribe: (_input: undefined, observer: LiveObserver) => {
          mocks.observer = observer;
          return { unsubscribe: mocks.unsubscribe };
        },
      },
    },
  };
  return {
    useTRPC: () => trpc,
    useTRPCClient: () => client,
  };
});

beforeEach(() => {
  mocks.observer = null;
  mocks.setQueryData.mockReset();
  mocks.unsubscribe.mockReset();
});

describe("useLive Traffic dashboard integration", () => {
  it("feeds traffic, totals, and active-node snapshots without removing Nodes data", () => {
    const { result, unmount } = renderHook(() => useLive());
    const observer = mocks.observer;
    if (!observer) throw new Error("live observer was not registered");
    const store = result.current.traffic;

    act(() => {
      observer.onData({ data: { type: "traffic", up: 12, down: 34 } });
      observer.onData({ data: { type: "totals", up: 1_000, down: 2_000 } });
      observer.onData({
        data: {
          type: "nodeUpdate",
          view: {
            now: "AUTO",
            autoNow: "Amsterdam",
            all: [
              {
                name: "Amsterdam",
                type: "vless",
                delay: 42,
                history: [40, 42],
              },
            ],
          },
        },
      });
    });

    expect(result.current.traffic).toBe(store);
    expect(store.getSnapshot()).toMatchObject({
      samples: [{ up: 12, down: 34 }],
      totals: { up: 1_000, down: 2_000 },
      sessionBytes: 0,
      latency: { node: "Amsterdam", current: 42, samples: [40, 42] },
    });
    expect(result.current.totals).toEqual({ up: 1_000, down: 2_000 });
    expect(result.current.latency).toEqual([40, 42]);
    expect(mocks.setQueryData).toHaveBeenCalledWith(["nodes", "list"], expect.any(Object));

    const cleanupCount = mocks.unsubscribe.mock.calls.length;
    unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(cleanupCount + 1);
  });
});
