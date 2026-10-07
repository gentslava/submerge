import { describe, expect, it, vi } from "vitest";
import { DomainRuleOperationDeferredError } from "./apply-errors.js";
import type { DomainRuleApplyOperationResult } from "./apply-operation.js";
import { DomainRuleApplyWorker } from "./apply-worker.js";

const completed = (operationId: string): DomainRuleApplyOperationResult => ({
  operationId,
  phase: "completed",
  contentSha256: "b".repeat(64),
  activationAttempt: 1,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function setup(options: { enabled?: boolean; unfinished?: string[]; onReady?: () => void } = {}) {
  const unfinished = options.unfinished ?? [];
  const execute = vi.fn(async (operationId: string) => completed(operationId));
  const onError = vi.fn();
  const worker = new DomainRuleApplyWorker({
    isEnabled: () => options.enabled ?? true,
    listUnfinished: () => unfinished.map((id) => ({ id })),
    execute,
    onError,
    ...(options.onReady ? { onReady: options.onReady } : {}),
  });
  return { execute, onError, worker };
}

describe("DomainRuleApplyWorker", () => {
  it("does not inspect or recover the journal when apply execution is disabled", async () => {
    const listUnfinished = vi.fn(() => [{ id: "committed-1" }]);
    const execute = vi.fn(async (operationId: string) => completed(operationId));
    const worker = new DomainRuleApplyWorker({
      isEnabled: () => false,
      listUnfinished,
      execute,
      onError: vi.fn(),
    });

    await expect(worker.start()).resolves.toBeUndefined();

    expect(worker.health()).toEqual({ status: "disabled", accepting: false });
    expect(worker.wake()).toBe(false);
    expect(listUnfinished).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("recovers every startup operation in durable order before accepting new work", async () => {
    const first = deferred<DomainRuleApplyOperationResult>();
    const events: string[] = [];
    const execute = vi.fn(async (operationId: string) => {
      events.push(`start:${operationId}`);
      if (operationId === "prepared-1") await first.promise;
      events.push(`done:${operationId}`);
      return completed(operationId);
    });
    const worker = new DomainRuleApplyWorker({
      isEnabled: () => true,
      listUnfinished: () => [{ id: "prepared-1" }, { id: "committed-2" }],
      execute,
      onError: vi.fn(),
    });

    const startup = worker.start();
    await vi.waitFor(() => expect(events).toEqual(["start:prepared-1"]));
    expect(worker.health()).toEqual({ status: "recovering", accepting: false });
    await expect(worker.submit(async () => "new-3")).rejects.toThrow(
      "domain-rule apply worker is not accepting work",
    );

    first.resolve(completed("prepared-1"));
    await startup;

    expect(events).toEqual([
      "start:prepared-1",
      "done:prepared-1",
      "start:committed-2",
      "done:committed-2",
    ]);
    expect(worker.health()).toEqual({ status: "ready", accepting: true });
    await worker.stop();
  });

  it("defers and coalesces wakes so validation can release its lease first", async () => {
    vi.useFakeTimers();
    try {
      let validationLeaseHeld = true;
      const execute = vi.fn(async (operationId: string) => {
        expect(validationLeaseHeld).toBe(false);
        return completed(operationId);
      });
      let unfinished: Array<{ id: string }> = [];
      const worker = new DomainRuleApplyWorker({
        isEnabled: () => true,
        listUnfinished: () => unfinished,
        execute,
        onError: vi.fn(),
      });
      await worker.start();
      execute.mockClear();
      unfinished = [{ id: "automatic-1" }];

      expect(worker.wake()).toBe(true);
      expect(worker.wake()).toBe(true);
      const prepareLater = vi.fn(async () => "manual-2");
      await expect(worker.submit(prepareLater)).rejects.toThrow(
        "domain-rule apply worker is not accepting work",
      );
      await Promise.resolve();
      expect(execute).not.toHaveBeenCalled();
      expect(prepareLater).not.toHaveBeenCalled();

      validationLeaseHeld = false;
      await vi.runAllTimersAsync();
      await worker.whenIdle();

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith("automatic-1", expect.any(AbortSignal));
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes submitted mutations and background recovery through one lock", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<DomainRuleApplyOperationResult>();
      let running = 0;
      let maximumRunning = 0;
      const events: string[] = [];
      const execute = vi.fn(async (operationId: string) => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        events.push(`start:${operationId}`);
        if (operationId === "manual-1") await first.promise;
        events.push(`done:${operationId}`);
        running -= 1;
        return completed(operationId);
      });
      let unfinished = [{ id: "startup" }];
      const worker = new DomainRuleApplyWorker({
        isEnabled: () => true,
        listUnfinished: () => unfinished,
        execute,
        onError: vi.fn(),
      });
      await worker.start();
      events.length = 0;
      unfinished = [{ id: "automatic-2" }];

      const manual = worker.submit(async () => "manual-1");
      await vi.waitFor(() => expect(events).toEqual(["start:manual-1"]));
      worker.wake();
      await vi.runAllTimersAsync();
      expect(events).toEqual(["start:manual-1"]);

      first.resolve(completed("manual-1"));
      await manual;
      await vi.runAllTimersAsync();
      await worker.whenIdle();

      expect(events).toEqual([
        "start:manual-1",
        "done:manual-1",
        "start:automatic-2",
        "done:automatic-2",
      ]);
      expect(maximumRunning).toBe(1);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes deployment and authorization mutations against local publication", async () => {
    const publication = deferred<DomainRuleApplyOperationResult>();
    const events: string[] = [];
    const { execute, worker } = setup();
    execute.mockImplementationOnce(async () => {
      events.push("publish:start");
      const result = await publication.promise;
      events.push("publish:done");
      return result;
    });
    await worker.start();

    const submitted = worker.submit(async () => "manual-1");
    await vi.waitFor(() => expect(events).toEqual(["publish:start"]));
    const externalMutation = worker.serializeMutation(async () => {
      events.push("reconcile");
      return "updated";
    });
    await Promise.resolve();
    expect(events).toEqual(["publish:start"]);

    publication.resolve(completed("manual-1"));
    await expect(submitted).resolves.toEqual(completed("manual-1"));
    await expect(externalMutation).resolves.toBe("updated");
    expect(events).toEqual(["publish:start", "publish:done", "reconcile"]);
    await worker.stop();
  });

  it("preserves an accepted submit ahead of a later same-tick durable wake", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let unfinished: Array<{ id: string }> = [];
      const execute = vi.fn(async (operationId: string) => {
        events.push(operationId);
        return completed(operationId);
      });
      const worker = new DomainRuleApplyWorker({
        isEnabled: () => true,
        listUnfinished: () => unfinished,
        execute,
        onError: vi.fn(),
      });
      await worker.start();
      unfinished = [{ id: "automatic-2" }];

      const prepare = vi.fn(async () => "manual-1");
      const submitted = worker.submit(prepare);
      expect(worker.wake()).toBe(true);

      await expect(submitted).resolves.toEqual(completed("manual-1"));
      await vi.runAllTimersAsync();
      await worker.whenIdle();

      expect(prepare).toHaveBeenCalledOnce();
      expect(events).toEqual(["manual-1", "automatic-2"]);
      expect(worker.health()).toEqual({ status: "ready", accepting: true });
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a wake during an active snapshot into one trailing durable pass", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<DomainRuleApplyOperationResult>();
      const events: string[] = [];
      let unfinished: Array<{ id: string }> = [];
      const execute = vi.fn(async (operationId: string) => {
        events.push(`start:${operationId}`);
        if (operationId === "automatic-1") await first.promise;
        events.push(`done:${operationId}`);
        return completed(operationId);
      });
      const worker = new DomainRuleApplyWorker({
        isEnabled: () => true,
        listUnfinished: () => unfinished,
        execute,
        onError: vi.fn(),
      });
      await worker.start();

      unfinished = [{ id: "automatic-1" }];
      expect(worker.wake()).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(events).toEqual(["start:automatic-1"]));

      unfinished = [{ id: "automatic-2" }];
      expect(worker.wake()).toBe(true);
      expect(worker.wake()).toBe(true);
      first.resolve(completed("automatic-1"));
      await vi.runAllTimersAsync();
      await worker.whenIdle();

      expect(events).toEqual([
        "start:automatic-1",
        "done:automatic-1",
        "start:automatic-2",
        "done:automatic-2",
      ]);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(worker.health()).toEqual({ status: "ready", accepting: true });
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks later mutations after a partial activation while allowing an ordered retry", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const events: string[] = [];
      const execute = vi.fn(
        async (operationId: string): Promise<DomainRuleApplyOperationResult> => {
          events.push(`${operationId}:${attempts}`);
          if (operationId === "committed-1" && attempts++ === 0) {
            return {
              operationId,
              phase: "partial",
              contentSha256: "b".repeat(64),
              activationAttempt: 1,
              errorCategory: "config-reload-failure",
            };
          }
          return completed(operationId);
        },
      );
      const worker = new DomainRuleApplyWorker({
        isEnabled: () => true,
        listUnfinished: () => [{ id: "committed-1" }, { id: "prepared-2" }],
        execute,
        onError: vi.fn(),
      });

      await worker.start();

      expect(events).toEqual(["committed-1:0"]);
      expect(worker.health()).toEqual({ status: "recovery-required", accepting: false });
      await expect(worker.submit(async () => "manual-3")).rejects.toThrow(
        "domain-rule apply worker is not accepting work",
      );

      expect(worker.wake()).toBe(true);
      await vi.runAllTimersAsync();
      await worker.whenIdle();

      expect(events).toEqual(["committed-1:0", "committed-1:1", "prepared-2:2"]);
      expect(worker.health()).toEqual({ status: "ready", accepting: true });
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes submission after a newly prepared operation activates only partially", async () => {
    const partial: DomainRuleApplyOperationResult = {
      operationId: "manual-1",
      phase: "partial",
      contentSha256: "b".repeat(64),
      activationAttempt: 1,
      errorCategory: "provider-proof-failure",
    };
    const { execute, worker } = setup();
    await worker.start();
    execute.mockResolvedValueOnce(partial);

    await expect(worker.submit(async () => "manual-1")).resolves.toEqual(partial);

    expect(worker.health()).toEqual({ status: "recovery-required", accepting: false });
    await expect(worker.submit(async () => "manual-2")).rejects.toThrow(
      "domain-rule apply worker is not accepting work",
    );
    await worker.stop();
  });

  it("invalidates a reserved later submit when the preceding operation becomes partial", async () => {
    const partial: DomainRuleApplyOperationResult = {
      operationId: "manual-1",
      phase: "partial",
      contentSha256: "b".repeat(64),
      activationAttempt: 1,
      errorCategory: "route-proof-failure",
    };
    const { execute, worker } = setup();
    await worker.start();
    execute.mockResolvedValueOnce(partial);
    const prepareSecond = vi.fn(async () => "manual-2");

    const first = worker.submit(async () => "manual-1");
    const second = worker.submit(prepareSecond);

    await expect(first).resolves.toEqual(partial);
    await expect(second).rejects.toThrow("domain-rule apply worker is not accepting work");
    expect(prepareSecond).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(worker.health()).toEqual({ status: "recovery-required", accepting: false });
    await worker.stop();
  });

  it("fails closed after execution errors and reports them once", async () => {
    vi.useFakeTimers();
    try {
      const error = new Error("local-store-reconciliation-required");
      const { execute, onError, worker } = setup();
      await worker.start();
      execute.mockRejectedValueOnce(error);

      const result = worker.submit(async () => "manual-1");
      await expect(result).rejects.toBe(error);

      expect(worker.health()).toEqual({ status: "failed", accepting: false });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(error, "manual-1");
      expect(worker.wake()).toBe(false);
      await expect(worker.submit(async () => "manual-2")).rejects.toThrow(
        "domain-rule apply worker is not accepting work",
      );
      await expect(worker.serializeMutation(async () => "reconciled")).resolves.toBe("reconciled");
      await vi.runAllTimersAsync();
      expect(execute).toHaveBeenCalledTimes(1);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks a recoverable pre-write deferral without poisoning later recovery", async () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      const { execute, onError, worker } = setup({
        unfinished: ["prepared-1"],
        onReady,
      });
      execute
        .mockRejectedValueOnce(new DomainRuleOperationDeferredError("observer accumulating"))
        .mockResolvedValueOnce(completed("prepared-1"));

      await expect(worker.start()).resolves.toBeUndefined();
      expect(worker.health()).toEqual({ status: "recovery-required", accepting: false });
      expect(onError).not.toHaveBeenCalled();

      expect(worker.wake()).toBe(true);
      await vi.runAllTimersAsync();
      await worker.whenIdle();

      expect(execute).toHaveBeenCalledTimes(2);
      expect(worker.health()).toEqual({ status: "ready", accepting: true });
      expect(onError).not.toHaveBeenCalled();
      expect(onReady).toHaveBeenCalledOnce();
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences new work, aborts the current operation, and waits during shutdown", async () => {
    const entered = deferred<void>();
    const execute = vi.fn(
      (operationId: string, signal: AbortSignal) =>
        new Promise<DomainRuleApplyOperationResult>((_resolve, reject) => {
          entered.resolve();
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error(`aborted:${operationId}`);
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const worker = new DomainRuleApplyWorker({
      isEnabled: () => true,
      listUnfinished: () => [],
      execute,
      onError: vi.fn(),
    });
    await worker.start();

    const operation = worker.submit(async () => "manual-1");
    await entered.promise;
    const stopping = worker.stop();

    expect(worker.health()).toEqual({ status: "stopping", accepting: false });
    expect(worker.wake()).toBe(false);
    await expect(worker.submit(async () => "manual-2")).rejects.toThrow(
      "domain-rule apply worker is not accepting work",
    );
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await stopping;
    expect(worker.health()).toEqual({ status: "stopped", accepting: false });
  });

  it("does not let an abort-resolved partial result reopen a stopping worker", async () => {
    const entered = deferred<void>();
    const onError = vi.fn();
    const execute = vi.fn(
      (operationId: string, signal: AbortSignal) =>
        new Promise<DomainRuleApplyOperationResult>((resolve) => {
          entered.resolve();
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                operationId,
                phase: "partial",
                contentSha256: "b".repeat(64),
                activationAttempt: 1,
                errorCategory: "shutdown",
              }),
            { once: true },
          );
        }),
    );
    const worker = new DomainRuleApplyWorker({
      isEnabled: () => true,
      listUnfinished: () => [],
      execute,
      onError,
    });
    await worker.start();

    const operation = worker.submit(async () => "manual-1");
    await entered.promise;
    const stopping = worker.stop();

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.wake()).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    await stopping;
    expect(worker.health()).toEqual({ status: "stopped", accepting: false });
  });
});
