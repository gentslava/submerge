import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { type Env, env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import { domainRuleOperations, domainRuleOwnership, settings } from "../../db/schema.js";
import type { ProxyChannelConfigInput } from "../nodes/multiConfig.js";
import { collectActiveRoutingInputs } from "../nodes/service.js";
import { setSetting } from "../settings/service.js";
import { verifyManagedDomainRuleActivation } from "./activation.js";
import {
  DomainRuleDeploymentController,
  type DomainRuleDeploymentControllerDeps,
} from "./deployment-controller.js";
import { DomainRuleProvisioningError } from "./provisioning.js";
import {
  DOMAIN_RULE_DIRECTORY_PATH,
  DomainRuleStoreError,
  inspectLocalDomainRuleStore,
  parseManagedDomainRules,
  provisionLocalDomainRuleStore,
} from "./rule-store.js";
import { getDomainIntelligenceSettingsView } from "./service.js";

export interface ProductionDomainRuleDeploymentInput {
  applyConfigDirect: DomainRuleDeploymentControllerDeps["applyConfigDirect"];
  db: Db;
  mode: Env["DOMAIN_RULES_MODE"];
  runConfigApply: DomainRuleDeploymentControllerDeps["runConfigApply"];
}

export interface ProductionDomainRuleDeploymentDeps {
  inspectStore: typeof inspectLocalDomainRuleStore;
  legacyStorePresent: () => boolean;
  provisionStore: typeof provisionLocalDomainRuleStore;
  resolveTargetGroupName: (db: Db) => string | null;
  verifyActivation: DomainRuleDeploymentControllerDeps["verifyActivation"];
}

const productionDeps: ProductionDomainRuleDeploymentDeps = {
  inspectStore: inspectLocalDomainRuleStore,
  legacyStorePresent: () => pathExists(legacyRuleFilePath()),
  provisionStore: provisionLocalDomainRuleStore,
  resolveTargetGroupName: resolveManagedDomainRuleTargetGroupName,
  verifyActivation: verifyManagedDomainRuleActivation,
};

const LOCAL_RULE_STORE_MARKER_KEY = "internal.domainRuleStore.v1";
const TERMINAL_OPERATION_PHASES = new Set(["aborted", "completed"]);
const RECOVERABLE_OPERATION_PHASES = new Set(["activating", "committed", "partial", "prepared"]);

function legacyRuleFilePath(): string {
  return resolve(dirname(env.DB_PATH), "domain-rules/repository/custom.txt");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function localRuleStoreHistory(db: Db): {
  historyPresent: boolean;
  markerDigest: string | null;
  markerPresent: boolean;
  ownedRules: readonly string[];
  reconciliationRequiredPresent: boolean;
  unfinishedIntendedDigests: ReadonlySet<string>;
  unfinishedPresent: boolean;
} {
  const marker = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, LOCAL_RULE_STORE_MARKER_KEY))
    .get();
  const markerDigestMatch = /^sha256:([0-9a-f]{64})$/u.exec(marker?.value ?? "");
  const operations = db
    .select({
      intendedContentSha256: domainRuleOperations.intendedContentSha256,
      phase: domainRuleOperations.phase,
    })
    .from(domainRuleOperations)
    .all();
  const ownedRules = db
    .select({ rule: domainRuleOwnership.rule })
    .from(domainRuleOwnership)
    .all()
    .map(({ rule }) => rule);
  return {
    historyPresent: operations.length > 0 || ownedRules.length > 0,
    markerDigest: markerDigestMatch?.[1] ?? null,
    markerPresent: marker !== undefined,
    ownedRules,
    reconciliationRequiredPresent: operations.some(
      ({ phase }) => phase === "reconciliation-required",
    ),
    unfinishedIntendedDigests: new Set(
      operations
        .filter(({ phase }) => RECOVERABLE_OPERATION_PHASES.has(phase))
        .map(({ intendedContentSha256 }) => intendedContentSha256),
    ),
    unfinishedPresent: operations.some(({ phase }) => !TERMINAL_OPERATION_PHASES.has(phase)),
  };
}

function sameRules(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && right.every((rule) => expected.has(rule));
}

function classifyLocalStoreFailure(error: unknown): unknown {
  if (
    error instanceof DomainRuleStoreError ||
    error instanceof DomainRuleProvisioningError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return error;
  }
  return error;
}

export function resolveManagedDomainRuleTargetGroupName(db: Db): string | null {
  const targetChannelId = getDomainIntelligenceSettingsView(db).settings.customTargetChannelId;
  const target = collectActiveRoutingInputs(db).inputs.find(
    (input): input is ProxyChannelConfigInput =>
      input.target === "proxy" && input.id === targetChannelId,
  );
  return target && (target.race ?? target.proxies).length > 0 ? target.groupName : null;
}

export function createProductionDomainRuleDeploymentController(
  input: ProductionDomainRuleDeploymentInput,
  deps: ProductionDomainRuleDeploymentDeps = productionDeps,
): DomainRuleDeploymentController {
  let initializationEvidenceSeen = false;
  return new DomainRuleDeploymentController(input.mode, {
    applyConfigDirect: input.applyConfigDirect,
    inspectStore: async (signal) => {
      const history = localRuleStoreHistory(input.db);
      initializationEvidenceSeen ||= history.markerPresent || history.historyPresent;
      if (!history.markerPresent) return null;
      const state = deps.inspectStore({
        ruleDirectoryPath: DOMAIN_RULE_DIRECTORY_PATH,
        ...(signal ? { signal } : {}),
      });
      if (history.markerDigest !== state.contentSha256) {
        throw new DomainRuleStoreError(
          "local-store-reconciliation-required",
          "local domain-rule file changed outside Submerge",
        );
      }
      return { ruleCount: state.ruleCount };
    },
    storePreviouslyInitialized: () => {
      const history = localRuleStoreHistory(input.db);
      initializationEvidenceSeen ||=
        history.markerPresent || history.historyPresent || deps.legacyStorePresent();
      return initializationEvidenceSeen;
    },
    provisionStore: async (signal) => {
      try {
        const history = localRuleStoreHistory(input.db);
        const legacyStorePresent = deps.legacyStorePresent();
        initializationEvidenceSeen ||=
          history.markerPresent || history.historyPresent || legacyStorePresent;
        if (history.reconciliationRequiredPresent) {
          throw new DomainRuleProvisioningError("local-store-reconciliation-required");
        }
        if (!history.markerPresent && history.unfinishedPresent) {
          throw new DomainRuleProvisioningError("local-store-migration-required");
        }
        const adoptingLegacyStore =
          !history.markerPresent && (history.historyPresent || legacyStorePresent);
        const state = await deps.provisionStore({
          allowCreateBaseline: !history.markerPresent && !adoptingLegacyStore,
          ruleDirectoryPath: DOMAIN_RULE_DIRECTORY_PATH,
          ...(signal === undefined ? {} : { signal }),
        });
        if (
          !history.markerPresent &&
          history.historyPresent &&
          !sameRules(history.ownedRules, parseManagedDomainRules(state.content))
        ) {
          throw new DomainRuleProvisioningError("local-store-migration-required");
        }
        if (
          history.markerPresent &&
          history.markerDigest !== state.contentSha256 &&
          !history.unfinishedIntendedDigests.has(state.contentSha256)
        ) {
          throw new DomainRuleStoreError(
            "local-store-reconciliation-required",
            "local domain-rule file changed outside Submerge",
          );
        }
        setSetting(input.db, LOCAL_RULE_STORE_MARKER_KEY, `sha256:${state.contentSha256}`);
        initializationEvidenceSeen = true;
        return { ruleCount: state.ruleCount };
      } catch (error) {
        throw classifyLocalStoreFailure(error);
      }
    },
    resolveTargetGroupName: () => deps.resolveTargetGroupName(input.db),
    runConfigApply: input.runConfigApply,
    verifyActivation: deps.verifyActivation,
  });
}
