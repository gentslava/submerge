import { fileURLToPath } from "node:url";
import { DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { channels, sources } from "../../db/schema.js";
import { createChannel, ensureDefaultChannel, ensureDirectChannel } from "../channels/service.js";
import type { ApplyResult } from "../nodes/service.js";
import {
  createProductionDomainRuleDeploymentController,
  type ProductionDomainRuleDeploymentDeps,
  resolveManagedDomainRuleTargetGroupName,
} from "./deployment-production.js";
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
    prepareRepositoryDirectories: vi.fn(() => ({
      repositoryPath: "/data/domain-rules/repository",
      trustedParentPath: "/data/domain-rules",
    })),
    provisionStore: vi.fn(async () => undefined),
    resolveTargetGroupName: vi.fn(() => "AUTO" as string | null),
    verifyActivation: vi.fn(async () => ({ providerRuleCount: 0 })),
  };
}

describe("production domain-rule deployment", () => {
  it("keeps report mode free of repository and materialization writes", async () => {
    const deps = dependencies();
    const applyConfigDirect = vi.fn(async () => applied);
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect,
        databasePath: "/data/submerge.db",
        db: createDb(":memory:"),
        mihomoConfigPath: "/mihomo/config.yaml",
        mode: "report",
        runConfigApply: async (apply) => apply(),
      },
      deps,
    );

    await expect(controller.reconcile()).resolves.toEqual(applied);

    expect(deps.prepareRepositoryDirectories).not.toHaveBeenCalled();
    expect(deps.provisionStore).not.toHaveBeenCalled();
    expect(deps.resolveTargetGroupName).not.toHaveBeenCalled();
    expect(deps.verifyActivation).not.toHaveBeenCalled();
    expect(applyConfigDirect).toHaveBeenCalledWith({ force: true });
  });

  it("provisions the private store before forwarding target and live proof", async () => {
    const events: string[] = [];
    const deps = dependencies();
    vi.mocked(deps.prepareRepositoryDirectories).mockImplementationOnce((path) => {
      events.push(`prepare:${path}`);
      return {
        repositoryPath: "/data/domain-rules/repository",
        trustedParentPath: "/data/domain-rules",
      };
    });
    vi.mocked(deps.provisionStore).mockImplementationOnce(async (input) => {
      events.push(`store:${input.mihomoConfigPath}`);
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
        databasePath: "/data/submerge.db",
        db: createDb(":memory:"),
        mihomoConfigPath: "/mihomo/config.yaml",
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
      "prepare:/data",
      "store:/mihomo/config.yaml",
      "target",
      "apply:AUTO",
      "proof:AUTO",
    ]);
    expect(deps.provisionStore).toHaveBeenCalledWith({
      mihomoConfigPath: "/mihomo/config.yaml",
      repositoryPath: "/data/domain-rules/repository",
      trustedParentPath: "/data/domain-rules",
    });
    expect(controller.readCapability().apply.available).toBe(true);
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
      "unsafe data directory",
      "prepare",
      new Error("unsafe local domain-rule data directory"),
      "local-store-unsafe",
    ],
    [
      "stale repository lock",
      "provision",
      new Error("local domain-rule repository is busy"),
      "local-store-reconciliation-required",
    ],
    [
      "interrupted repository",
      "provision",
      new Error("unexpected local Git state"),
      "local-store-reconciliation-required",
    ],
  ] as const)("preserves the actionable reason for %s", async (_name, stage, failure, reason) => {
    const deps = dependencies();
    if (stage === "prepare") {
      vi.mocked(deps.prepareRepositoryDirectories).mockImplementationOnce(() => {
        throw failure;
      });
    } else {
      vi.mocked(deps.provisionStore).mockRejectedValueOnce(failure);
    }
    const controller = createProductionDomainRuleDeploymentController(
      {
        applyConfigDirect: vi.fn(async () => applied),
        databasePath: "/data/submerge.db",
        db: createDb(":memory:"),
        mihomoConfigPath: "/mihomo/config.yaml",
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
