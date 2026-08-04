import { describe, expect, it, vi } from "vitest";
import { type DomainRuleActivationError, verifyManagedDomainRuleActivation } from "./activation.js";

const activeProvider = {
  behavior: "Domain",
  format: "Text",
  name: "submerge-custom",
  ruleCount: 2,
  type: "Rule",
  vehicleType: "File",
};

const probeRule = {
  index: 0,
  type: "Domain",
  payload: "speed.cloudflare.com",
  proxy: "PROBE",
  size: -1,
  extra: { disabled: false },
};

const activeRule = {
  index: 1,
  type: "RuleSet",
  payload: "submerge-custom",
  proxy: "AUTO",
  size: -1,
  extra: { disabled: false },
};

function dependencies(
  provider = activeProvider,
  rule = activeRule,
): Parameters<typeof verifyManagedDomainRuleActivation>[1] {
  return {
    readRuleProviders: vi.fn(async () => ({
      providers: { "submerge-custom": provider },
    })),
    readRules: vi.fn(async () => ({ rules: [probeRule, rule] })),
  };
}

describe("verifyManagedDomainRuleActivation", () => {
  it("proves the loaded local provider and its exact VPN target", async () => {
    const deps = dependencies();

    await expect(
      verifyManagedDomainRuleActivation({ targetGroupName: "AUTO" }, deps),
    ).resolves.toEqual({ providerRuleCount: 2 });
    expect(deps.readRuleProviders).toHaveBeenCalledOnce();
    expect(deps.readRules).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing provider", undefined],
    ["wrong behavior", { ...activeProvider, behavior: "classical" }],
    ["wrong format", { ...activeProvider, format: "Yaml" }],
    ["wrong name", { ...activeProvider, name: "other" }],
    ["wrong type", { ...activeProvider, type: "Proxy" }],
    ["wrong vehicle", { ...activeProvider, vehicleType: "HTTP" }],
  ])("fails closed for %s", async (_label, provider) => {
    const deps = {
      readRuleProviders: vi.fn(async () => ({
        providers: provider ? { "submerge-custom": provider } : {},
      })),
      readRules: vi.fn(async () => ({ rules: [probeRule, activeRule] })),
    };

    await expect(
      verifyManagedDomainRuleActivation({ targetGroupName: "AUTO" }, deps),
    ).rejects.toMatchObject({ reason: "provider-inactive" });
  });

  it.each([
    ["missing route", [probeRule]],
    ["wrong probe", [{ ...probeRule, proxy: "DIRECT" }, activeRule]],
    ["wrong target", [probeRule, { ...activeRule, proxy: "DIRECT" }]],
    ["wrong declared index", [probeRule, { ...activeRule, index: 7 }]],
    ["duplicate route", [probeRule, activeRule, { ...activeRule, index: 2 }]],
    [
      "disabled duplicate route",
      [probeRule, activeRule, { ...activeRule, index: 2, extra: { disabled: true } }],
    ],
    ["disabled route", [probeRule, { ...activeRule, extra: { disabled: true } }]],
    [
      "shadowed route",
      [
        probeRule,
        {
          index: 1,
          type: "Match",
          payload: "",
          proxy: "DIRECT",
          size: -1,
          extra: { disabled: false },
        },
        { ...activeRule, index: 2 },
      ],
    ],
  ])("fails closed for %s", async (_label, rules) => {
    const deps = {
      readRuleProviders: vi.fn(async () => ({
        providers: { "submerge-custom": activeProvider },
      })),
      readRules: vi.fn(async () => ({ rules })),
    };

    await expect(
      verifyManagedDomainRuleActivation({ targetGroupName: "AUTO" }, deps),
    ).rejects.toMatchObject({ reason: "provider-inactive" });
  });

  it("normalizes controller transport/schema failures to a safe typed reason", async () => {
    const deps = dependencies();
    vi.mocked(deps.readRuleProviders).mockRejectedValueOnce(new Error("controller detail"));

    await expect(
      verifyManagedDomainRuleActivation({ targetGroupName: "AUTO" }, deps),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DomainRuleActivationError>>({
        name: "DomainRuleActivationError",
        reason: "provider-inactive",
        message: "managed domain-rule provider activation could not be proven",
      }),
    );
  });

  it("forwards one cancellation signal through both activation reads", async () => {
    const controller = new AbortController();
    const deps = dependencies();

    await verifyManagedDomainRuleActivation(
      { targetGroupName: "AUTO", signal: controller.signal },
      deps,
    );

    expect(deps.readRuleProviders).toHaveBeenCalledWith(controller.signal);
    expect(deps.readRules).toHaveBeenCalledWith(controller.signal);
  });

  it("preserves the caller cancellation reason", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    controller.abort(reason);
    const deps = dependencies();
    vi.mocked(deps.readRuleProviders).mockRejectedValueOnce(reason);

    await expect(
      verifyManagedDomainRuleActivation(
        { targetGroupName: "AUTO", signal: controller.signal },
        deps,
      ),
    ).rejects.toBe(reason);
  });

  it("cannot return a proof after cancellation wins the completion race", async () => {
    const controller = new AbortController();
    const reason = new Error("newer operation");
    const deps = dependencies();
    vi.mocked(deps.readRuleProviders).mockImplementationOnce(async () => {
      controller.abort(reason);
      return { providers: { "submerge-custom": activeProvider } };
    });

    await expect(
      verifyManagedDomainRuleActivation(
        { targetGroupName: "AUTO", signal: controller.signal },
        deps,
      ),
    ).rejects.toBe(reason);
  });

  it("does not settle while a sibling controller read is still running", async () => {
    let resolveRules: ((value: { rules: (typeof probeRule)[] }) => void) | undefined;
    const pendingRules = new Promise<{ rules: (typeof probeRule)[] }>((resolve) => {
      resolveRules = resolve;
    });
    const deps = dependencies();
    vi.mocked(deps.readRuleProviders).mockRejectedValueOnce(new Error("provider read failed"));
    vi.mocked(deps.readRules).mockReturnValueOnce(pendingRules);

    const verification = verifyManagedDomainRuleActivation({ targetGroupName: "AUTO" }, deps);
    let settled = false;
    void verification.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    resolveRules?.({ rules: [probeRule] });
    await expect(verification).rejects.toMatchObject({ reason: "provider-inactive" });
  });
});
