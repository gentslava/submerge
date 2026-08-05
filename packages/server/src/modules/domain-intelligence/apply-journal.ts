import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  type DomainIntelligenceReportSettings,
  domainIntelligenceReportSettingsSchema,
  MAX_SETTING_VALUE_BYTES,
} from "@submerge/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  DOMAIN_RULE_ACTIVATION_ERROR_CATEGORIES,
  type DomainRuleActivationErrorCategory,
  type DomainRuleOperationPhase,
  type DomainRuleOwnershipDeltaJson,
  domainAutomaticBudgets,
  domainAutomaticConsents,
  domainRuleOperations,
  domainRuleOwnership,
  settings,
} from "../../db/schema.js";
import { DomainRulePreparedVetoError } from "./apply-errors.js";
import { normalizeObservedFqdn } from "./observer.js";

const MAX_DATE_MS = 8_640_000_000_000_000;
const operationIdSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/u);
const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.number().int().min(0).max(MAX_DATE_MS);
export const DOMAIN_AUTOMATIC_SAFETY_VERSION = "domain-auto-v1";
const ownershipSchema = z.enum(["automatic", "manual"]);
const domainRuleSchema = z
  .string()
  .min(3)
  .max(255)
  .refine((rule) => {
    const fqdn = rule.startsWith("+.") ? rule.slice(2) : rule;
    return normalizeObservedFqdn(fqdn) === fqdn;
  }, "invalid domain rule");
const ownershipDeltaSchema = z
  .object({
    upserts: z.array(z.object({ rule: domainRuleSchema, ownership: ownershipSchema })).max(10_000),
    deletes: z.array(domainRuleSchema).max(10_000),
  })
  .superRefine((delta, context) => {
    const upserts = new Set(delta.upserts.map(({ rule }) => rule));
    const deletes = new Set(delta.deletes);
    if (upserts.size !== delta.upserts.length || deletes.size !== delta.deletes.length) {
      context.addIssue({ code: "custom", message: "duplicate ownership delta rule" });
    }
    if ([...upserts].some((rule) => deletes.has(rule))) {
      context.addIssue({ code: "custom", message: "conflicting ownership delta rule" });
    }
    if (upserts.size + deletes.size === 0) {
      context.addIssue({ code: "custom", message: "empty ownership delta" });
    }
  })
  .transform((delta) => ({
    upserts: [...delta.upserts].sort((left, right) => left.rule.localeCompare(right.rule)),
    deletes: [...delta.deletes].sort((left, right) => left.localeCompare(right)),
  }));
function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function ruleCoversCandidate(rule: string, candidateFqdn: string): boolean {
  if (!rule.startsWith("+.")) return rule === candidateFqdn;
  const suffix = rule.slice(2);
  return candidateFqdn === suffix || candidateFqdn.endsWith(`.${suffix}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${[...value]
      .sort((left, right) => String(left).localeCompare(String(right)))
      .map(stableJson)
      .join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildDomainAutomaticConsentRevision(
  settings: DomainIntelligenceReportSettings,
): string {
  const parsed = domainIntelligenceReportSettingsSchema.parse(settings);
  const safetyPreferences = {
    minimumConnectionCount: parsed.minimumConnectionCount,
    directAttemptsRequired: parsed.directAttemptsRequired,
    minimumAttemptSpacingMinutes: parsed.minimumAttemptSpacingMinutes,
    validationWindowHours: parsed.validationWindowHours,
    minimumProxySuccesses: parsed.minimumProxySuccesses,
    maximumProxyTransportFailures: parsed.maximumProxyTransportFailures,
    maximumCandidatesPerRun: parsed.maximumCandidatesPerRun,
    maximumAutomaticRulesPerDay: parsed.maximumAutomaticRulesPerDay,
    maxConcurrency: parsed.maxConcurrency,
    requestTimeoutMs: parsed.requestTimeoutMs,
    defaultRuleScope: parsed.defaultRuleScope,
    externalResolvers: parsed.externalResolvers,
    excludedTlds: parsed.excludedTlds,
    neverAddDomains: parsed.neverAddDomains,
    neverAddSuffixes: parsed.neverAddSuffixes,
    nonWidenableSuffixes: parsed.nonWidenableSuffixes,
    telemetryPatterns: parsed.telemetryPatterns,
    customTargetChannelId: parsed.customTargetChannelId,
  };
  return `${DOMAIN_AUTOMATIC_SAFETY_VERSION}:sha256:${createHash("sha256")
    .update(stableJson(safetyPreferences))
    .digest("hex")}`;
}

function parseStoredAutomaticSettings(
  rawSettings: string | undefined,
): DomainIntelligenceReportSettings {
  let decodedSettings: unknown;
  try {
    decodedSettings =
      rawSettings === undefined ||
      rawSettings.includes("\0") ||
      Buffer.byteLength(rawSettings, "utf8") > MAX_SETTING_VALUE_BYTES
        ? null
        : JSON.parse(rawSettings);
  } catch {
    decodedSettings = null;
  }
  const automaticSettings = domainIntelligenceReportSettingsSchema.safeParse(decodedSettings);
  if (!automaticSettings.success || !automaticSettings.data.enabled) {
    throw new Error("automatic domain-rule settings unavailable");
  }
  return automaticSettings.data;
}

interface CurrentAutomaticConsent {
  id: string;
  revision: string;
}

function assertCurrentAutomaticConsent(
  automaticSettings: DomainIntelligenceReportSettings,
  activeConsent: CurrentAutomaticConsent | null,
): CurrentAutomaticConsent {
  const expectedConsentRevision = buildDomainAutomaticConsentRevision(automaticSettings);
  if (activeConsent?.revision !== expectedConsentRevision) {
    throw new Error("automatic domain-rule consent unavailable or stale");
  }
  return activeConsent;
}

const prepareInputSchema = z
  .object({
    id: operationIdSchema,
    idempotencyKey: operationIdSchema,
    action: z.enum(["automatic-add", "manual-add", "manual-edit", "manual-delete", "rollback"]),
    rollbackTargetCommit: sha1Schema.optional(),
    candidateFqdn: z.string().min(3).max(253).optional(),
    expectedParentCommit: sha1Schema,
    intendedContentSha256: sha256Schema,
    proposedRule: domainRuleSchema.optional(),
    ownershipDelta: ownershipDeltaSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const isAutomatic = input.action === "automatic-add";
    if (isAutomatic && !input.candidateFqdn) {
      context.addIssue({ code: "custom", message: "automatic operation requires candidate" });
    }
    if (input.candidateFqdn && normalizeObservedFqdn(input.candidateFqdn) !== input.candidateFqdn) {
      context.addIssue({ code: "custom", message: "candidate FQDN is not normalized" });
    }
    if (Boolean(input.rollbackTargetCommit) !== (input.action === "rollback")) {
      context.addIssue({ code: "custom", message: "rollback target does not match action" });
    }
    if (
      input.candidateFqdn &&
      input.proposedRule &&
      !ruleCoversCandidate(input.proposedRule, input.candidateFqdn)
    ) {
      context.addIssue({ code: "custom", message: "proposed rule does not cover candidate" });
    }
    if (isAutomatic) {
      const automaticRules = input.ownershipDelta.upserts.filter(
        ({ ownership }) => ownership === "automatic",
      );
      if (
        input.ownershipDelta.deletes.length > 0 ||
        automaticRules.length !== 1 ||
        input.ownershipDelta.upserts.length !== 1 ||
        !input.proposedRule ||
        automaticRules[0]?.rule !== input.proposedRule
      ) {
        context.addIssue({ code: "custom", message: "invalid automatic ownership delta" });
      }
    }
    if (input.action === "manual-add" || input.action === "manual-edit") {
      if (
        input.ownershipDelta.upserts.length !== 1 ||
        input.ownershipDelta.upserts.some(({ ownership }) => ownership !== "manual") ||
        input.ownershipDelta.upserts[0]?.rule !== input.proposedRule ||
        !input.proposedRule ||
        (input.action === "manual-add" && input.ownershipDelta.deletes.length > 0)
      ) {
        context.addIssue({ code: "custom", message: "invalid manual ownership delta" });
      }
    }
    if (
      input.action === "manual-delete" &&
      (input.ownershipDelta.upserts.length > 0 ||
        input.ownershipDelta.deletes.length !== 1 ||
        input.proposedRule)
    ) {
      context.addIssue({ code: "custom", message: "invalid manual delete ownership delta" });
    }
  });

const finalizeInputSchema = z.object({
  operationId: operationIdSchema,
  commitSha: sha1Schema,
  committedContentSha256: sha256Schema,
});
const activationResultInputSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      operationId: operationIdSchema,
      attempt: z.number().int().min(1).max(1_000_000),
      outcome: z.literal("succeeded"),
    })
    .strict(),
  z
    .object({
      operationId: operationIdSchema,
      attempt: z.number().int().min(1).max(1_000_000),
      outcome: z.literal("failed"),
      errorCategory: z.enum(DOMAIN_RULE_ACTIVATION_ERROR_CATEGORIES),
    })
    .strict(),
]);

interface PrepareDomainRuleOperationBase {
  id: string;
  idempotencyKey: string;
  candidateFqdn?: string;
  expectedParentCommit: string;
  intendedContentSha256: string;
}

export type PrepareDomainRuleOperationInput =
  | (PrepareDomainRuleOperationBase & {
      action: "automatic-add";
      candidateFqdn: string;
      proposedRule: string;
      ownershipDelta: {
        upserts: [{ rule: string; ownership: "automatic" }];
        deletes: [];
      };
    })
  | (PrepareDomainRuleOperationBase & {
      action: "manual-add";
      proposedRule: string;
      ownershipDelta: {
        upserts: [{ rule: string; ownership: "manual" }];
        deletes: [];
      };
    })
  | (PrepareDomainRuleOperationBase & {
      action: "manual-edit";
      proposedRule: string;
      ownershipDelta: {
        upserts: [{ rule: string; ownership: "manual" }];
        deletes: string[];
      };
    })
  | (PrepareDomainRuleOperationBase & {
      action: "manual-delete";
      proposedRule?: never;
      ownershipDelta: { upserts: []; deletes: [string] };
    })
  | (PrepareDomainRuleOperationBase & {
      action: "rollback";
      rollbackTargetCommit: string;
      proposedRule?: string;
      ownershipDelta: DomainRuleOwnershipDeltaJson;
    });

export interface FinalizeDomainRuleCommitInput {
  operationId: string;
  commitSha: string;
  committedContentSha256: string;
}

export type CompleteDomainRuleActivationInput =
  | { operationId: string; attempt: number; outcome: "succeeded" }
  | {
      operationId: string;
      attempt: number;
      outcome: "failed";
      errorCategory: DomainRuleActivationErrorCategory;
    };

export interface DomainRuleJournalOptions {
  clock?: () => number;
}

export interface DomainRuleAbortOptions extends DomainRuleJournalOptions {
  // The caller holds the process-wide apply lock while this async proof and the
  // following SQLite transition run. The attestor must require clean worktree
  // and HEAD === expectedParentCommit.
  assertPreCommitState: (intent: {
    operationId: string;
    expectedParentCommit: string;
    intendedContentSha256: string;
  }) => Promise<void>;
}

function journalNow(options: DomainRuleJournalOptions): number {
  return timestampSchema.parse(options.clock?.() ?? Date.now());
}

function immutableIntentMatches(
  stored: typeof domainRuleOperations.$inferSelect,
  input: z.output<typeof prepareInputSchema>,
): boolean {
  return (
    stored.id === input.id &&
    stored.action === input.action &&
    stored.rollbackTargetCommit === (input.rollbackTargetCommit ?? null) &&
    stored.candidateFqdn === (input.candidateFqdn ?? null) &&
    stored.expectedParentCommit === input.expectedParentCommit &&
    stored.intendedContentSha256 === input.intendedContentSha256 &&
    stored.proposedRule === (input.proposedRule ?? null) &&
    JSON.stringify(stored.ownershipDelta) === JSON.stringify(input.ownershipDelta)
  );
}

export function prepareDomainRuleOperation(
  db: Db,
  rawInput: PrepareDomainRuleOperationInput,
  options: DomainRuleJournalOptions = {},
): typeof domainRuleOperations.$inferSelect & { created: boolean } {
  const input = prepareInputSchema.parse(rawInput);
  const now = journalNow(options);

  return db.transaction((tx) => {
    const assertAutomaticOwnershipAvailable = (): void => {
      if (input.action !== "automatic-add") return;
      for (const { rule } of input.ownershipDelta.upserts) {
        const existingOwnership = tx
          .select({ ownership: domainRuleOwnership.ownership })
          .from(domainRuleOwnership)
          .where(eq(domainRuleOwnership.rule, rule))
          .get();
        if (existingOwnership?.ownership === "manual") {
          throw new Error("automatic domain rule cannot replace manual ownership");
        }
      }
    };
    const assertNoBlockingReconciliation = (): void => {
      const blocking = tx
        .select({ id: domainRuleOperations.id })
        .from(domainRuleOperations)
        .where(eq(domainRuleOperations.phase, "reconciliation-required"))
        .get();
      if (blocking) throw new Error("domain-rule reconciliation required");
    };
    const authorizeAutomaticOperation = (): {
      settings: DomainIntelligenceReportSettings;
      consent: CurrentAutomaticConsent;
    } | null => {
      if (input.action !== "automatic-add") return null;
      const rawSettings = tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "domainIntelligence"))
        .get()?.value;
      const automaticSettings = parseStoredAutomaticSettings(rawSettings);
      const activeConsent =
        tx
          .select({ id: domainAutomaticConsents.id, revision: domainAutomaticConsents.revision })
          .from(domainAutomaticConsents)
          .where(isNull(domainAutomaticConsents.revokedAt))
          .get() ?? null;
      const consent = assertCurrentAutomaticConsent(automaticSettings, activeConsent);
      return { settings: automaticSettings, consent };
    };

    const existing = tx
      .select()
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.idempotencyKey, input.idempotencyKey))
      .get();
    if (existing) {
      if (!immutableIntentMatches(existing, input)) {
        throw new Error("domain-rule idempotency conflict");
      }
      if (existing.phase === "prepared") {
        assertNoBlockingReconciliation();
        assertAutomaticOwnershipAvailable();
        const currentAuthorization = authorizeAutomaticOperation();
        if (
          currentAuthorization &&
          (existing.automaticConsentId !== currentAuthorization.consent.id ||
            existing.automaticConsentRevision !== currentAuthorization.consent.revision)
        ) {
          throw new Error("automatic domain-rule consent unavailable or stale");
        }
      }
      return { ...existing, created: false };
    }
    const duplicateId = tx
      .select({ id: domainRuleOperations.id })
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.id, input.id))
      .get();
    if (duplicateId) throw new Error("domain-rule operation ID conflict");

    assertNoBlockingReconciliation();
    assertAutomaticOwnershipAvailable();
    const automaticAuthorization = authorizeAutomaticOperation();
    if (input.action === "rollback") {
      const rollbackTargetCommit = sha1Schema.parse(input.rollbackTargetCommit);
      const attestedTarget = tx
        .select({ id: domainRuleOperations.id })
        .from(domainRuleOperations)
        .where(
          and(
            eq(domainRuleOperations.commitSha, rollbackTargetCommit),
            inArray(domainRuleOperations.phase, [
              "committed",
              "activating",
              "completed",
              "partial",
            ]),
          ),
        )
        .get();
      if (!attestedTarget) throw new Error("domain-rule rollback target is not attested");
    }
    const automaticBudgetDay = input.action === "automatic-add" ? utcDay(now) : null;
    const automaticBudgetSlots = input.action === "automatic-add" ? 1 : 0;
    if (automaticBudgetDay) {
      if (!automaticAuthorization) throw new Error("automatic domain-rule settings unavailable");
      const budget = tx
        .select()
        .from(domainAutomaticBudgets)
        .where(eq(domainAutomaticBudgets.day, automaticBudgetDay))
        .get();
      const reservedSlots = budget?.reservedSlots ?? 0;
      const consumedSlots = budget?.consumedSlots ?? 0;
      if (
        reservedSlots + consumedSlots + 1 >
        automaticAuthorization.settings.maximumAutomaticRulesPerDay
      ) {
        throw new Error("automatic domain-rule daily budget exhausted");
      }
      tx.insert(domainAutomaticBudgets)
        .values({
          day: automaticBudgetDay,
          reservedSlots: reservedSlots + 1,
          consumedSlots,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: domainAutomaticBudgets.day,
          set: {
            reservedSlots: reservedSlots + 1,
            updatedAt: now,
          },
        })
        .run();
    }

    tx.insert(domainRuleOperations)
      .values({
        id: input.id,
        idempotencyKey: input.idempotencyKey,
        action: input.action,
        phase: "prepared",
        rollbackTargetCommit: input.rollbackTargetCommit ?? null,
        candidateFqdn: input.candidateFqdn ?? null,
        expectedParentCommit: input.expectedParentCommit,
        intendedContentSha256: input.intendedContentSha256,
        proposedRule: input.proposedRule ?? null,
        ownershipDelta: input.ownershipDelta,
        automaticConsentId: automaticAuthorization?.consent.id ?? null,
        automaticConsentRevision: automaticAuthorization?.consent.revision ?? null,
        automaticBudgetDay,
        automaticBudgetSlots,
        commitSha: null,
        committedContentSha256: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      })
      .run();

    const operation = tx
      .select()
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.id, input.id))
      .get();
    if (!operation) throw new Error("domain-rule journal write failed");
    return { ...operation, created: true };
  });
}

// The apply worker calls this while holding its process-wide mutation lock,
// immediately before invoking the local Git publisher. Consent changes use the
// same lock, so a successful proof remains valid until the commit boundary.
export function assertPreparedAutomaticOperationAuthorized(
  db: Db,
  operationId: string,
): { consentId: string; consentRevision: string } {
  const parsedId = operationIdSchema.parse(operationId);
  return db.transaction((tx) => {
    const operation = tx
      .select({
        action: domainRuleOperations.action,
        phase: domainRuleOperations.phase,
        automaticConsentId: domainRuleOperations.automaticConsentId,
        automaticConsentRevision: domainRuleOperations.automaticConsentRevision,
        ownershipDelta: domainRuleOperations.ownershipDelta,
      })
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.id, parsedId))
      .get();
    if (operation?.action !== "automatic-add" || operation.phase !== "prepared") {
      throw new Error("automatic domain-rule operation is not prepared");
    }
    const blocking = tx
      .select({ id: domainRuleOperations.id })
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.phase, "reconciliation-required"))
      .get();
    if (blocking) throw new Error("domain-rule reconciliation required");
    for (const { rule } of operation.ownershipDelta.upserts) {
      const existingOwnership = tx
        .select({ ownership: domainRuleOwnership.ownership })
        .from(domainRuleOwnership)
        .where(eq(domainRuleOwnership.rule, rule))
        .get();
      if (existingOwnership?.ownership === "manual") {
        throw new DomainRulePreparedVetoError(
          "automatic domain rule cannot replace manual ownership",
        );
      }
    }

    const rawSettings = tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "domainIntelligence"))
      .get()?.value;
    let automaticSettings: ReturnType<typeof parseStoredAutomaticSettings>;
    try {
      automaticSettings = parseStoredAutomaticSettings(rawSettings);
    } catch (error) {
      throw new DomainRulePreparedVetoError(
        error instanceof Error ? error.message : "automatic domain-rule authorization changed",
      );
    }
    const activeConsent =
      tx
        .select({ id: domainAutomaticConsents.id, revision: domainAutomaticConsents.revision })
        .from(domainAutomaticConsents)
        .where(isNull(domainAutomaticConsents.revokedAt))
        .get() ?? null;
    let consent: ReturnType<typeof assertCurrentAutomaticConsent>;
    try {
      consent = assertCurrentAutomaticConsent(automaticSettings, activeConsent);
    } catch (error) {
      throw new DomainRulePreparedVetoError(
        error instanceof Error ? error.message : "automatic domain-rule authorization changed",
      );
    }
    if (
      operation.automaticConsentId !== consent.id ||
      operation.automaticConsentRevision !== consent.revision
    ) {
      throw new DomainRulePreparedVetoError("automatic domain-rule consent unavailable or stale");
    }
    return { consentId: consent.id, consentRevision: consent.revision };
  });
}

export function finalizeDomainRuleCommit(
  db: Db,
  rawInput: FinalizeDomainRuleCommitInput,
  options: DomainRuleJournalOptions = {},
): { changed: boolean; phase: DomainRuleOperationPhase } {
  const input = finalizeInputSchema.parse(rawInput);
  const now = journalNow(options);

  return db.transaction((tx) => {
    const operation = tx
      .select()
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.id, input.operationId))
      .get();
    if (!operation) throw new Error("domain-rule operation not found");
    if (operation.intendedContentSha256 !== input.committedContentSha256) {
      throw new Error("domain-rule committed content does not match prepared intent");
    }
    if (operation.expectedParentCommit === input.commitSha) {
      throw new Error("domain-rule commit must be a child of the prepared parent");
    }
    if (operation.phase !== "prepared") {
      if (
        ["committed", "activating", "completed", "partial"].includes(operation.phase) &&
        operation.commitSha === input.commitSha &&
        operation.committedContentSha256 === input.committedContentSha256
      ) {
        return { changed: false, phase: operation.phase };
      }
      throw new Error("domain-rule operation cannot finalize commit");
    }

    if (operation.action === "automatic-add") {
      for (const { rule } of operation.ownershipDelta.upserts) {
        const existingOwnership = tx
          .select({ ownership: domainRuleOwnership.ownership })
          .from(domainRuleOwnership)
          .where(eq(domainRuleOwnership.rule, rule))
          .get();
        if (existingOwnership?.ownership === "manual") {
          throw new Error("automatic domain rule cannot replace manual ownership");
        }
      }
    }

    if (operation.automaticBudgetDay) {
      const budget = tx
        .select()
        .from(domainAutomaticBudgets)
        .where(eq(domainAutomaticBudgets.day, operation.automaticBudgetDay))
        .get();
      if (!budget || budget.reservedSlots < operation.automaticBudgetSlots) {
        throw new Error("domain-rule budget reservation is missing");
      }
      tx.update(domainAutomaticBudgets)
        .set({
          reservedSlots: budget.reservedSlots - operation.automaticBudgetSlots,
          consumedSlots: budget.consumedSlots + operation.automaticBudgetSlots,
          updatedAt: now,
        })
        .where(eq(domainAutomaticBudgets.day, operation.automaticBudgetDay))
        .run();
    }

    for (const rule of operation.ownershipDelta.deletes) {
      tx.delete(domainRuleOwnership).where(eq(domainRuleOwnership.rule, rule)).run();
    }
    for (const entry of operation.ownershipDelta.upserts) {
      const existing = tx
        .select({ createdAt: domainRuleOwnership.createdAt })
        .from(domainRuleOwnership)
        .where(eq(domainRuleOwnership.rule, entry.rule))
        .get();
      tx.insert(domainRuleOwnership)
        .values({
          rule: entry.rule,
          ownership: entry.ownership,
          operationId: operation.id,
          commitSha: input.commitSha,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: domainRuleOwnership.rule,
          set: {
            ownership: entry.ownership,
            operationId: operation.id,
            commitSha: input.commitSha,
            updatedAt: now,
          },
        })
        .run();
    }

    tx.update(domainRuleOperations)
      .set({
        phase: "committed",
        commitSha: input.commitSha,
        committedContentSha256: input.committedContentSha256,
        updatedAt: now,
      })
      .where(
        and(eq(domainRuleOperations.id, operation.id), eq(domainRuleOperations.phase, "prepared")),
      )
      .run();
    return { changed: true, phase: "committed" };
  });
}

export function beginDomainRuleActivation(
  db: Db,
  operationId: string,
  options: DomainRuleJournalOptions = {},
): { changed: boolean; phase: DomainRuleOperationPhase; attempt: number } {
  const parsedId = operationIdSchema.parse(operationId);
  const now = journalNow(options);

  return db.transaction((tx) => {
    const operation = tx
      .select()
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.id, parsedId))
      .get();
    if (!operation) throw new Error("domain-rule operation not found");
    if (operation.phase === "activating") {
      return {
        changed: false,
        phase: operation.phase,
        attempt: operation.activationAttemptCount,
      };
    }
    if (operation.phase === "completed") {
      return {
        changed: false,
        phase: operation.phase,
        attempt: operation.activationAttemptCount,
      };
    }
    if (operation.phase !== "committed" && operation.phase !== "partial") {
      throw new Error("domain-rule operation cannot begin activation");
    }
    if (now < operation.updatedAt) throw new Error("domain-rule journal clock moved backwards");

    const attempt = operation.activationAttemptCount + 1;
    tx.update(domainRuleOperations)
      .set({
        phase: "activating",
        activationStatus: "in-progress",
        activationAttemptCount: attempt,
        lastActivationAttemptAt: now,
        activationErrorCategory: null,
        updatedAt: now,
        completedAt: null,
      })
      .where(
        and(
          eq(domainRuleOperations.id, operation.id),
          eq(domainRuleOperations.phase, operation.phase),
        ),
      )
      .run();
    return { changed: true, phase: "activating", attempt };
  });
}

export function completeDomainRuleActivation(
  db: Db,
  rawInput: CompleteDomainRuleActivationInput,
  options: DomainRuleJournalOptions = {},
): { changed: boolean; phase: DomainRuleOperationPhase; attempt: number } {
  const input = activationResultInputSchema.parse(rawInput);
  const now = journalNow(options);

  return db.transaction((tx) => {
    const operation = tx
      .select()
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.id, input.operationId))
      .get();
    if (!operation) throw new Error("domain-rule operation not found");
    if (operation.phase === "completed" || operation.phase === "partial") {
      if (operation.activationAttemptCount !== input.attempt) {
        throw new Error("domain-rule activation attempt is stale");
      }
      const matches =
        (operation.phase === "completed" && input.outcome === "succeeded") ||
        (operation.phase === "partial" &&
          input.outcome === "failed" &&
          operation.activationErrorCategory === input.errorCategory);
      if (!matches) {
        throw new Error("domain-rule activation result conflicts with stored terminal state");
      }
      return {
        changed: false,
        phase: operation.phase,
        attempt: operation.activationAttemptCount,
      };
    }
    if (operation.phase !== "activating" || operation.activationAttemptCount < 1) {
      throw new Error("domain-rule operation cannot complete activation");
    }
    if (operation.activationAttemptCount !== input.attempt) {
      throw new Error("domain-rule activation attempt is stale");
    }
    if (now < operation.updatedAt) throw new Error("domain-rule journal clock moved backwards");

    const phase = input.outcome === "succeeded" ? "completed" : "partial";
    tx.update(domainRuleOperations)
      .set({
        phase,
        activationStatus: input.outcome,
        activationErrorCategory: input.outcome === "failed" ? input.errorCategory : null,
        updatedAt: now,
        completedAt: input.outcome === "succeeded" ? now : null,
      })
      .where(
        and(
          eq(domainRuleOperations.id, operation.id),
          eq(domainRuleOperations.phase, "activating"),
          eq(domainRuleOperations.activationAttemptCount, input.attempt),
        ),
      )
      .run();
    return { changed: true, phase, attempt: operation.activationAttemptCount };
  });
}

export function markDomainRuleOperationReconciliationRequired(
  db: Db,
  operationId: string,
  options: DomainRuleJournalOptions = {},
): { changed: boolean; phase: "reconciliation-required" } {
  const parsedId = operationIdSchema.parse(operationId);
  const now = journalNow(options);

  return db.transaction((tx) => {
    const operation = tx
      .select()
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.id, parsedId))
      .get();
    if (!operation) throw new Error("domain-rule operation not found");
    if (operation.phase === "reconciliation-required") {
      return { changed: false, phase: "reconciliation-required" };
    }
    if (operation.phase === "completed" || operation.phase === "aborted") {
      throw new Error("terminal domain-rule operation cannot require reconciliation");
    }
    if (now < operation.updatedAt) throw new Error("domain-rule journal clock moved backwards");

    const activating = operation.phase === "activating";
    tx.update(domainRuleOperations)
      .set({
        phase: "reconciliation-required",
        ...(activating
          ? {
              activationStatus: "failed" as const,
              activationErrorCategory: "infrastructure-failure" as const,
            }
          : {}),
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(domainRuleOperations.id, operation.id))
      .run();
    return { changed: true, phase: "reconciliation-required" };
  });
}

export async function abortPreparedDomainRuleOperation(
  db: Db,
  operationId: string,
  options: DomainRuleAbortOptions,
): Promise<boolean> {
  const parsedId = operationIdSchema.parse(operationId);

  const prepared = db
    .select({
      id: domainRuleOperations.id,
      phase: domainRuleOperations.phase,
      expectedParentCommit: domainRuleOperations.expectedParentCommit,
      intendedContentSha256: domainRuleOperations.intendedContentSha256,
    })
    .from(domainRuleOperations)
    .where(eq(domainRuleOperations.id, parsedId))
    .get();
  if (prepared?.phase !== "prepared") return false;
  await options.assertPreCommitState({
    operationId: prepared.id,
    expectedParentCommit: prepared.expectedParentCommit,
    intendedContentSha256: prepared.intendedContentSha256,
  });
  const now = journalNow(options);

  return db.transaction((tx) => {
    const operation = tx
      .select()
      .from(domainRuleOperations)
      .where(eq(domainRuleOperations.id, parsedId))
      .get();
    if (
      operation?.phase !== "prepared" ||
      operation.expectedParentCommit !== prepared.expectedParentCommit ||
      operation.intendedContentSha256 !== prepared.intendedContentSha256
    ) {
      return false;
    }

    if (operation.automaticBudgetDay) {
      const budget = tx
        .select()
        .from(domainAutomaticBudgets)
        .where(eq(domainAutomaticBudgets.day, operation.automaticBudgetDay))
        .get();
      if (!budget || budget.reservedSlots < operation.automaticBudgetSlots) {
        throw new Error("domain-rule budget reservation is missing");
      }
      tx.update(domainAutomaticBudgets)
        .set({
          reservedSlots: budget.reservedSlots - operation.automaticBudgetSlots,
          updatedAt: now,
        })
        .where(eq(domainAutomaticBudgets.day, operation.automaticBudgetDay))
        .run();
    }

    tx.update(domainRuleOperations)
      .set({ phase: "aborted", updatedAt: now, completedAt: now })
      .where(
        and(eq(domainRuleOperations.id, operation.id), eq(domainRuleOperations.phase, "prepared")),
      )
      .run();
    return true;
  });
}

export function listUnfinishedDomainRuleOperations(
  db: Db,
): Array<typeof domainRuleOperations.$inferSelect> {
  return db
    .select()
    .from(domainRuleOperations)
    .where(
      inArray(domainRuleOperations.phase, [
        "prepared",
        "committed",
        "activating",
        "partial",
        "reconciliation-required",
      ]),
    )
    .orderBy(asc(domainRuleOperations.createdAt), asc(domainRuleOperations.id))
    .all();
}
