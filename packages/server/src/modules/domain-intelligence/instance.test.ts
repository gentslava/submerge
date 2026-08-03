import { describe, expect, it, vi } from "vitest";
import type { MihomoLogFrame } from "../../clients/mihomo.js";
import {
  DomainIntelligenceObserver,
  DomainIntelligenceRuntimeLifecycle,
  reconcileDomainIntelligenceRuntime,
} from "./instance.js";
import type { DomainObservation } from "./observer.js";

const routedFrame: MihomoLogFrame = {
  level: "info",
  message: "[TCP] 127.0.0.1:51234 --> api.service.example:443 match RuleSet(custom)",
  fields: { host: "api.service.example", network: "tcp", port: 443 },
};

function harness(capacity?: number) {
  const scheduled: Array<() => void> = [];
  const persistObservation = vi.fn<(observation: DomainObservation) => void>();
  const onError = vi.fn<(error: unknown) => void>();
  const observer = new DomainIntelligenceObserver({
    persistObservation,
    schedule: (work) => scheduled.push(work),
    onError,
    ...(capacity === undefined ? {} : { capacity }),
  });
  return { observer, onError, persistObservation, scheduled };
}

describe("DomainIntelligenceObserver", () => {
  it("starts observation before scheduling and stops scheduling before observation", () => {
    const calls: string[] = [];
    const observer = {
      start: () => calls.push("observer:start"),
      stop: () => calls.push("observer:stop"),
    };
    const scheduler = {
      start: () => calls.push("scheduler:start"),
      stop: () => calls.push("scheduler:stop"),
    };
    const validator = {
      start: () => calls.push("validator:start"),
      stop: () => calls.push("validator:stop"),
    };

    reconcileDomainIntelligenceRuntime(true, observer, scheduler, validator);
    reconcileDomainIntelligenceRuntime(false, observer, scheduler, validator);

    expect(calls).toEqual([
      "observer:start",
      "scheduler:start",
      "validator:start",
      "validator:stop",
      "scheduler:stop",
      "observer:stop",
    ]);
  });

  it("is disabled by default and does not schedule persistence", () => {
    const { observer, persistObservation, scheduled } = harness();

    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:00:00.000Z"));

    expect(scheduled).toHaveLength(0);
    expect(persistObservation).not.toHaveBeenCalled();
  });

  it("normalizes synchronously but defers persistence outside the log pump", () => {
    const { observer, persistObservation, scheduled } = harness();
    const observedAt = Date.parse("2026-08-03T12:00:00.000Z");
    observer.start();

    observer.observeLogFrame(routedFrame, observedAt);

    expect(scheduled).toHaveLength(1);
    expect(persistObservation).not.toHaveBeenCalled();
    scheduled[0]?.();
    expect(persistObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        fqdn: "api.service.example",
        observedAt,
        transport: "tcp",
        source: "mihomo-log",
      }),
    );
  });

  it("cancels queued persistence on stop and can be started again", () => {
    const { observer, persistObservation, scheduled } = harness();
    observer.start();
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:00:00.000Z"));

    observer.stop();
    scheduled.shift()?.();
    expect(persistObservation).not.toHaveBeenCalled();

    observer.start();
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:01:00.000Z"));
    scheduled.shift()?.();
    expect(persistObservation).toHaveBeenCalledTimes(1);
  });

  it("contains persistence failures and continues accepting observations", () => {
    const { observer, onError, persistObservation, scheduled } = harness();
    persistObservation
      .mockImplementationOnce(() => {
        throw new Error("database unavailable");
      })
      .mockImplementationOnce(() => {
        throw new Error("still unavailable");
      })
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("failed again");
      });
    observer.start();

    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:00:00.000Z"));
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:01:00.000Z"));
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:02:00.000Z"));
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:03:00.000Z"));
    expect(scheduled).toHaveLength(1);

    while (scheduled.length > 0) scheduled.shift()?.();

    expect(onError).toHaveBeenCalledTimes(2);
    expect(persistObservation).toHaveBeenCalledTimes(4);
  });

  it("deduplicates pending fingerprints and bounds a single-flight queue", () => {
    const { observer, onError, persistObservation, scheduled } = harness(2);
    observer.start();

    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:00:00.000Z"));
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:00:00.000Z"));
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:01:00.000Z"));
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:02:00.000Z"));
    observer.observeLogFrame(routedFrame, Date.parse("2026-08-03T12:03:00.000Z"));

    expect(scheduled).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    scheduled.shift()?.();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();

    expect(scheduled).toHaveLength(0);
    expect(persistObservation).toHaveBeenCalledTimes(2);
    expect(
      new Set(persistObservation.mock.calls.map(([observation]) => observation.fingerprint)).size,
    ).toBe(2);
  });

  it("retains a bounded primary-log history and filters snapshot correlation reads", () => {
    const { observer } = harness();
    const observedAt = Date.parse("2026-08-03T12:00:00.000Z");
    observer.start();
    observer.observeLogFrame(routedFrame, observedAt);

    expect(observer.recentLogObservations(observedAt)).toEqual([
      expect.objectContaining({
        fqdn: "api.service.example",
        observedAt,
        source: "mihomo-log",
      }),
    ]);
    expect(observer.recentLogObservations(observedAt + 1)).toEqual([]);
    expect(observer.recentLogObservations(0)).toHaveLength(1);
  });

  it("contains parser failures without scheduling or throwing into the caller", () => {
    const { observer, onError, scheduled } = harness();
    observer.start();

    expect(() => observer.observeLogFrame(routedFrame, Number.NaN)).not.toThrow();
    expect(scheduled).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("DomainIntelligenceRuntimeLifecycle", () => {
  it("keeps the validation maintenance pulse alive while collection is disabled", async () => {
    const calls: string[] = [];
    const observer = {
      start: () => calls.push("observer:start"),
      stop: () => calls.push("observer:stop"),
    };
    const snapshot = {
      start: () => calls.push("snapshot:start"),
      stop: () => calls.push("snapshot:stop"),
    };
    const validator = {
      start: () => calls.push("validator:start"),
      wake: () => calls.push("validator:wake"),
      stop: async () => {
        calls.push("validator:stop");
      },
    };
    const lifecycle = new DomainIntelligenceRuntimeLifecycle([observer, snapshot], validator);

    await lifecycle.setEnabled(false);
    expect(calls).toEqual(["snapshot:stop", "observer:stop", "validator:stop", "validator:start"]);

    calls.length = 0;
    await lifecycle.setEnabled(false);
    expect(calls).toEqual(["validator:start"]);

    calls.length = 0;
    await lifecycle.setEnabled(true);
    expect(calls).toEqual([
      "observer:start",
      "snapshot:start",
      "validator:start",
      "validator:wake",
    ]);

    calls.length = 0;
    lifecycle.beginShutdown();
    await lifecycle.setEnabled(false);
    expect(calls).toEqual(["snapshot:stop", "observer:stop", "validator:stop"]);
  });

  it("cannot resume after validation cleanup fails", async () => {
    const validator = {
      start: vi.fn(),
      wake: vi.fn(),
      stop: vi.fn(async () => {
        throw new Error("cleanup incomplete");
      }),
    };
    const lifecycle = new DomainIntelligenceRuntimeLifecycle([], validator);

    await expect(lifecycle.setEnabled(false)).rejects.toThrow("cleanup incomplete");
    await expect(lifecycle.setEnabled(true)).rejects.toThrow(/cleanup is incomplete/i);
    expect(validator.start).not.toHaveBeenCalled();
    expect(validator.wake).not.toHaveBeenCalled();
  });
});
