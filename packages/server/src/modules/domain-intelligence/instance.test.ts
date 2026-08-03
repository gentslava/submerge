import { describe, expect, it, vi } from "vitest";
import type { MihomoLogFrame } from "../../clients/mihomo.js";
import { DomainIntelligenceObserver } from "./instance.js";
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
