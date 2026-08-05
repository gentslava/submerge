import { fileURLToPath } from "node:url";
import { DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import {
  channels,
  domainRuleOperations,
  domainRuleOwnership,
  settings,
  sources,
} from "../../db/schema.js";
import { createChannel, ensureDefaultChannel, ensureDirectChannel } from "../channels/service.js";
import type { ApplyResult } from "../nodes/service.js";
import { setSetting } from "../settings/service.js";
import {
  createProductionDomainRuleDeploymentController,
  type ProductionDomainRuleDeploymentDeps,
  resolveManagedDomainRuleTargetGroupName,
} from "./deployment-production.js";
import { DomainRuleStoreError } from "./rule-store.js";
import { setDomainIntelligenceReportSettings } from "./service.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const applied: ApplyResult = { nodes: 1, applied: true, activationVerified: true };
const manualPolicy = { kind: "manual" as const, pinnedNode: "NL", onFailure: "hold" as const };

function migratedDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder });
  ensureDefaultChannel(db);
  return db;
}

function selectTarget(db: ReturnType<typeof migratedDb>, customTargetChannelId: string): void {
  setDomainIntelligenceReportSettings(db, {
    ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
    customTargetChannelId,
    defaultRuleScope: "exact",
  });
}

function dependencies(): ProductionDomainRuleDeploymentDeps {
  return {
    inspectStore: vi.fn(() => ({
      baselineCreated: false,
      content: "",
      contentSha256: "a".repeat(64),
      revision: "a".repeat(40),
      ruleCount: 0,
    })),
    legacyStorePresent: vi.fn(() => false),
    provisionStore: vi.fn(async () => ({
      baselineCreated: false,
      content: "",
      contentSha256: "a".repeat(64),
      revision: "a".repeat(40),
      ruleCount: 0,
    })),
    resolveTargetGroupName: vi.fn(() => "AUTO" as string | null),
    verifyActivation: vi.fn(async () => ({ providerRuleCount: 0 })),
  };
}

describe("production domain-rule deployment", () => {
  it("keeps report mode free of local rule-file writes", async () => {
    const deps = dependencies();
    const applyConfigDirect = vi.fn(async () => applied);
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect,
        db: migratedDb(),
        mode: "report",
        runConfigApply: async (apply) => apply(),
      },
      deps,
    );

    await expect(controller.reconcile()).resolves.toEqual(applied);

    expect(deps.provisionStore).not.toHaveBeenCalled();
    expect(deps.inspectStore).not.toHaveBeenCalled();
    expect(deps.resolveTargetGroupName).not.toHaveBeenCalled();
    expect(deps.verifyActivation).not.toHaveBeenCalled();
    expect(applyConfigDirect).toHaveBeenCalledWith({ force: true });
  });

  it("keeps an attested initialized local provider active in report mode", async () => {
    const db = migratedDb();
    setSetting(db, "internal.domainRuleStore.v1", `sha256:${"a".repeat(64)}`);
    const deps = dependencies();
    const applyConfigDirect = vi.fn(async () => applied);
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect,
        db,
        mode: "report",
        runConfigApply: async (apply) => apply(),
      },
      deps,
    );

    await expect(controller.reconcile()).resolves.toEqual(applied);

    expect(deps.provisionStore).not.toHaveBeenCalled();
    expect(deps.inspectStore).toHaveBeenCalledOnce();
    expect(applyConfigDirect).toHaveBeenCalledWith({
      force: true,
      managedDomainRules: { targetGroupName: "AUTO" },
    });
  });

  it("provisions the private store before forwarding target and live proof", async () => {
    const events: string[] = [];
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockImplementationOnce(async (input) => {
      events.push(`store:${input.ruleDirectoryPath}`);
      return {
        baselineCreated: false,
        content: "",
        contentSha256: "a".repeat(64),
        revision: "a".repeat(40),
      };
    });
    vi.mocked(deps.resolveTargetGroupName).mockImplementationOnce(() => {
      events.push("target");
      return "AUTO";
    });
    vi.mocked(deps.verifyActivation).mockImplementationOnce(async ({ targetGroupName }) => {
      events.push(`proof:${targetGroupName}`);
      return { providerRuleCount: 2 };
    });
    const applyConfigDirect = vi.fn(async (input) => {
      events.push(`apply:${input.managedDomainRules?.targetGroupName ?? "none"}`);
      return applied;
    });
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect,
        db: migratedDb(),
        mode: "apply",
        runConfigApply: async (apply) => {
          events.push("suspend");
          return apply();
        },
      },
      deps,
    );

    await expect(controller.reconcile()).resolves.toEqual(applied);

    expect(events).toEqual([
      "suspend",
      "store:/domain-rules",
      "target",
      "apply:AUTO",
      "proof:AUTO",
    ]);
    expect(deps.provisionStore).toHaveBeenCalledWith({
      allowCreateBaseline: true,
      ruleDirectoryPath: "/domain-rules",
    });
    expect(controller.readCapability().apply.available).toBe(true);

    await expect(controller.reconcile()).resolves.toEqual(applied);
    expect(deps.provisionStore).toHaveBeenLastCalledWith({
      allowCreateBaseline: false,
      ruleDirectoryPath: "/domain-rules",
    });
  });

  it("resolves the configured target from the same active routing projection", () => {
    const db = migratedDb();
    db.insert(sources)
      .values({
        kind: "sub",
        value: "source",
        label: "source",
        sortOrder: 0,
        proxies: [{ name: "NL", type: "vless", server: "nl.example", port: 443 }],
      })
      .run();
    const target = createChannel(db, { name: "Streaming", policy: manualPolicy });
    selectTarget(db, target.id);

    expect(resolveManagedDomainRuleTargetGroupName(db)).toBe(`ch-${target.id}`);
  });

  it("requires an explicit migration when legacy audit rows predate the local-store marker", async () => {
    const db = migratedDb();
    db.insert(domainRuleOperations)
      .values({
        id: "legacy-prepared",
        idempotencyKey: "legacy-prepared",
        action: "manual-add",
        phase: "prepared",
        expectedSourceRevision: "1".repeat(40),
        intendedContentSha256: "a".repeat(64),
        proposedRule: "api.service.example",
        ownershipDelta: {
          upserts: [{ rule: "api.service.example", ownership: "manual" }],
          deletes: [],
        },
        createdAt: 100,
        updatedAt: 100,
      })
      .run();
    const deps = dependencies();
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect: vi.fn(async () => applied),
        db,
        mode: "apply",
        runConfigApply: async (apply) => apply(),
      },
      deps,
    );

    await expect(controller.reconcile()).rejects.toMatchObject({
      reason: "local-store-migration-required",
    });

    expect(deps.provisionStore).not.toHaveBeenCalled();
    expect(controller.readCapability()).toMatchObject({
      apply: { available: false, reason: "local-store-migration-required" },
    });
  });

  it("does not create an empty baseline over an un-migrated legacy repository", async () => {
    const deps = dependencies();
    vi.mocked(deps.legacyStorePresent).mockReturnValue(true);
    vi.mocked(deps.provisionStore).mockRejectedValueOnce(
      new DomainRuleStoreError(
        "local-store-migration-required",
        "local domain-rule file is missing after prior provisioning",
      ),
    );
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect: vi.fn(async () => applied),
        db: migratedDb(),
        mode: "apply",
        runConfigApply: async (apply) => apply(),
      },
      deps,
    );

    await expect(controller.reconcile()).rejects.toMatchObject({
      reason: "local-store-migration-required",
    });

    expect(deps.provisionStore).toHaveBeenCalledWith({
      allowCreateBaseline: false,
      ruleDirectoryPath: "/domain-rules",
    });
    expect(controller.readCapability()).toMatchObject({
      apply: { available: false, reason: "local-store-migration-required" },
    });
  });

  it("adopts terminal legacy history only when managed rules equal current ownership", async () => {
    const db = migratedDb();
    db.insert(domainRuleOperations)
      .values({
        id: "legacy-completed",
        idempotencyKey: "legacy-completed",
        action: "manual-add",
        phase: "completed",
        expectedSourceRevision: "1".repeat(40),
        intendedContentSha256: "b".repeat(64),
        proposedRule: "api.service.example",
        ownershipDelta: {
          upserts: [{ rule: "api.service.example", ownership: "manual" }],
          deletes: [],
        },
        resultingRevision: "2".repeat(40),
        resultingContentSha256: "b".repeat(64),
        activationStatus: "succeeded",
        activationAttemptCount: 1,
        lastActivationAttemptAt: 100,
        createdAt: 100,
        updatedAt: 100,
        completedAt: 100,
      })
      .run();
    db.insert(domainRuleOwnership)
      .values({
        rule: "api.service.example",
        ownership: "manual",
        operationId: "legacy-completed",
        resultingRevision: "2".repeat(40),
        createdAt: 100,
        updatedAt: 100,
      })
      .run();
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockResolvedValueOnce({
      baselineCreated: false,
      content:
        "# operator\n# BEGIN SUBMERGE MANAGED\napi.service.example\n# END SUBMERGE MANAGED\n",
      contentSha256: "c".repeat(64),
      revision: "c".repeat(40),
      ruleCount: 1,
    });
    vi.mocked(deps.verifyActivation).mockResolvedValueOnce({ providerRuleCount: 1 });
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect: vi.fn(async () => applied),
        db,
        mode: "apply",
        runConfigApply: async (apply) => apply(),
      },
      deps,
    );

    await expect(controller.reconcile()).resolves.toEqual(applied);

    expect(deps.provisionStore).toHaveBeenCalledWith({
      allowCreateBaseline: false,
      ruleDirectoryPath: "/domain-rules",
    });
    expect(
      db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "internal.domainRuleStore.v1"))
        .get()?.value,
    ).toBe(`sha256:${"c".repeat(64)}`);
    expect(controller.readCapability().apply.available).toBe(true);
  });

  it("rejects an offline file replacement that has no unfinished journal intent", async () => {
    const db = migratedDb();
    setSetting(db, "internal.domainRuleStore.v1", `sha256:${"a".repeat(64)}`);
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockResolvedValueOnce({
      baselineCreated: false,
      content: "# BEGIN SUBMERGE MANAGED\napi.changed.example\n# END SUBMERGE MANAGED\n",
      contentSha256: "b".repeat(64),
      revision: "b".repeat(40),
      ruleCount: 1,
    });
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect: vi.fn(async () => applied),
        db,
        mode: "apply",
        runConfigApply: async (apply) => apply(),
      },
      deps,
    );

    await expect(controller.reconcile()).rejects.toMatchObject({
      reason: "local-store-reconciliation-required",
    });

    expect(controller.readCapability()).toMatchObject({
      apply: { available: false, reason: "local-store-reconciliation-required" },
    });
  });

  it("fails closed when the configured target cannot provide a proxy exit", () => {
    const missing = migratedDb();
    selectTarget(missing, "missing");

    const disabled = migratedDb();
    const disabledTarget = createChannel(disabled, { name: "Disabled", policy: manualPolicy });
    disabled
      .update(channels)
      .set({ enabled: false })
      .where(eq(channels.id, disabledTarget.id))
      .run();
    selectTarget(disabled, disabledTarget.id);

    const direct = migratedDb();
    ensureDirectChannel(direct);
    selectTarget(direct, "direct");

    const empty = migratedDb();
    const emptyTarget = createChannel(empty, { name: "Empty", policy: manualPolicy });
    selectTarget(empty, emptyTarget.id);

    expect([
      resolveManagedDomainRuleTargetGroupName(missing),
      resolveManagedDomainRuleTargetGroupName(disabled),
      resolveManagedDomainRuleTargetGroupName(direct),
      resolveManagedDomainRuleTargetGroupName(empty),
    ]).toEqual([null, null, null, null]);
  });

  it.each([
    [
      "unsafe rule directory",
      new DomainRuleStoreError("local-store-unsafe", "unsafe local domain-rule directory"),
      "local-store-unsafe",
    ],
    [
      "concurrent writer",
      new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule source changed",
      ),
      "local-store-reconciliation-required",
    ],
  ] as const)("preserves the actionable reason for %s", async (_name, failure, reason) => {
    const deps = dependencies();
    vi.mocked(deps.provisionStore).mockRejectedValueOnce(failure);
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect: vi.fn(async () => applied),
        db: migratedDb(),
        mode: "apply",
        runConfigApply: async (apply) => apply(),
      },
      deps,
    );

    await expect(controller.reconcile()).resolves.toMatchObject({ applied: true });
    expect(controller.readCapability()).toMatchObject({
      apply: { available: false, reason },
    });
  });
});
