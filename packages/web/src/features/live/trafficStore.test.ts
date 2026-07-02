import { describe, expect, it, vi } from "vitest";
import { createTrafficStore } from "./useLive";

describe("traffic store", () => {
  it("notifies subscribers with a fresh snapshot per push", () => {
    const store = createTrafficStore();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.getSnapshot()).toEqual([]);
    store.push({ up: 10, down: 20 });
    const first = store.getSnapshot();
    expect(first).toEqual([{ up: 10, down: 20 }]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.push({ up: 5, down: 7 });
    const second = store.getSnapshot();
    expect(second).not.toBe(first); // identity changes — useSyncExternalStore contract
    expect(second).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", () => {
    const store = createTrafficStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.push({ up: 1, down: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
