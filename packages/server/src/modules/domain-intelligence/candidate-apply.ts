import {
  type DomainCandidateApplyActionInput,
  type DomainIntelligenceDeploymentCapability,
  type DomainRuleApplyOperationResult,
  domainCandidateApplyActionInputSchema,
  domainIntelligenceDeploymentCapabilitySchema,
  domainRuleApplyOperationResultSchema,
} from "@submerge/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { domainCandidates, domainRuleOperations } from "../../db/schema.js";
import {
  DomainRuleOperationDeferredError,
  DomainRuleWorkerNotAcceptingError,
} from "./apply-errors.js";
import { prepareDomainRuleOperation } from "./apply-journal.js";
import type { DomainRuleApplyOperationResult as InternalApplyResult } from "./apply-operation.js";
import type {
  PreparedLocalDomainRuleMutationIntent,
  PrepareLocalDomainRuleMutationIntentInput,
} from "./publisher.js";
import { getDomainIntelligenceSettingsView } from "./service.js";

export interface ConfirmedDomainCandidateApplyDependencies {
  db: Db;
  now?: () => number;
  prepareIntent: (
    input: PrepareLocalDomainRuleMutationIntentInput,
  ) => Promise<PreparedLocalDomainRuleMutationIntent>;
  readCapability: () => unknown;
  repositoryPath: string;
  submit: (
    prepare: (signal: AbortSignal) => string | Promise<string>,
  ) => Promise<InternalApplyResult>;
  trustedParentPath: string;
}

function requireApplyReady(value: unknown): DomainIntelligenceDeploymentCapability {
  const capability = domainIntelligenceDeploymentCapabilitySchema.safeParse(value);
  if (!capability.success || capability.data.mode !== "apply" || !capability.data.apply.available) {
    throw new Error("candidate apply unavailable");
  }
  return capability.data;
}

type DurableCandidateApplyOperation = Pick<
  typeof domainRuleOperations.$inferSelect,
  | "id"
  | "action"
  | "candidateFqdn"
  | "phase"
  | "commitSha"
  | "activationAttemptCount"
  | "activationErrorCategory"
>;

function readDurableCandidateApplyOperation(
  db: Db,
  operationId: string,
): DurableCandidateApplyOperation | undefined {
  return db
    .select({
      id: domainRuleOperations.id,
      action: domainRuleOperations.action,
      candidateFqdn: domainRuleOperations.candidateFqdn,
      phase: domainRuleOperations.phase,
      commitSha: domainRuleOperations.commitSha,
      activationAttemptCount: domainRuleOperations.activationAttemptCount,
      activationErrorCategory: domainRuleOperations.activationErrorCategory,
    })
    .from(domainRuleOperations)
    .where(eq(domainRuleOperations.idempotencyKey, operationId))
    .get();
}

function assertDurableCandidateApplyIdentity(
  operation: DurableCandidateApplyOperation,
  input: DomainCandidateApplyActionInput,
): void {
  if (
    operation.id !== input.operationId ||
    operation.action !== "manual-add" ||
    operation.candidateFqdn !== input.fqdn
  ) {
    throw new Error("domain-rule idempotency conflict");
  }
}

function projectDurableCandidateApplyResult(
  operation: DurableCandidateApplyOperation,
): DomainRuleApplyOperationResult {
  if (operation.phase === "reconciliation-required") {
    throw new Error("domain-rule operation requires reconciliation");
  }
  if (operation.phase === "completed") {
    return domainRuleApplyOperationResultSchema.parse({
      operationId: operation.id,
      phase: "completed",
      commitSha: operation.commitSha,
      activationAttempt: operation.activationAttemptCount,
    });
  }
  if (operation.phase === "partial") {
    return domainRuleApplyOperationResultSchema.parse({
      operationId: operation.id,
      phase: "partial",
      commitSha: operation.commitSha,
      activationAttempt: operation.activationAttemptCount,
      errorCategory: operation.activationErrorCategory,
    });
  }
  if (operation.phase === "aborted") {
    return domainRuleApplyOperationResultSchema.parse({
      operationId: operation.id,
      phase: "aborted",
      commitSha: null,
      activationAttempt: 0,
    });
  }
  return domainRuleApplyOperationResultSchema.parse({
    operationId: operation.id,
    phase: "queued",
    commitSha: null,
    activationAttempt: 0,
  });
}

/**
 * Authorize one explicit review-mode candidate confirmation and hand the
 * durable operation to the process-owned apply worker. The worker invokes the
 * preparation callback while holding the global mutation lock.
 */
export async function applyConfirmedDomainCandidate(
  rawInput: DomainCandidateApplyActionInput,
  dependencies: ConfirmedDomainCandidateApplyDependencies,
): Promise<DomainRuleApplyOperationResult> {
  const input = domainCandidateApplyActionInputSchema.parse(rawInput);
  const durableBeforeSubmission = readDurableCandidateApplyOperation(
    dependencies.db,
    input.operationId,
  );
  if (durableBeforeSubmission) {
    assertDurableCandidateApplyIdentity(durableBeforeSubmission, input);
    if (["completed", "partial", "aborted"].includes(durableBeforeSubmission.phase)) {
      return projectDurableCandidateApplyResult(durableBeforeSubmission);
    }
  }
  try {
    const result = await dependencies.submit(async (signal) => {
      signal.throwIfAborted();
      const existing = readDurableCandidateApplyOperation(dependencies.db, input.operationId);
      if (existing) {
        assertDurableCandidateApplyIdentity(existing, input);
        return existing.id;
      }

      const capability = requireApplyReady(dependencies.readCapability());
      const view = getDomainIntelligenceSettingsView(dependencies.db, capability);
      if (
        view.configurationState !== "ready" ||
        !view.settings.enabled ||
        view.settings.automationMode !== "review"
      ) {
        throw new Error("candidate apply authorization unavailable");
      }

      const candidate = dependencies.db
        .select({
          fqdn: domainCandidates.fqdn,
          status: domainCandidates.status,
          reviewState: domainCandidates.reviewState,
          proposedRule: domainCandidates.proposedRule,
        })
        .from(domainCandidates)
        .where(eq(domainCandidates.fqdn, input.fqdn))
        .get();
      if (
        candidate?.status !== "confirmed" ||
        candidate.reviewState !== "active" ||
        candidate.proposedRule === null
      ) {
        throw new Error("candidate apply authorization unavailable");
      }

      const intent = await dependencies.prepareIntent({
        repositoryPath: dependencies.repositoryPath,
        trustedParentPath: dependencies.trustedParentPath,
        upsertRules: [candidate.proposedRule],
        deleteRules: [],
        signal,
      });
      signal.throwIfAborted();
      const operation = prepareDomainRuleOperation(
        dependencies.db,
        {
          id: input.operationId,
          idempotencyKey: input.operationId,
          action: "manual-add",
          candidateFqdn: candidate.fqdn,
          expectedParentCommit: intent.expectedParentCommit,
          intendedContentSha256: intent.intendedContentSha256,
          proposedRule: candidate.proposedRule,
          ownershipDelta: {
            upserts: [{ rule: candidate.proposedRule, ownership: "manual" }],
            deletes: [],
          },
        },
        dependencies.now ? { clock: dependencies.now } : {},
      );
      return operation.id;
    });
    return domainRuleApplyOperationResultSchema.parse(result);
  } catch (error) {
    if (
      !(error instanceof DomainRuleOperationDeferredError) &&
      !(error instanceof DomainRuleWorkerNotAcceptingError)
    ) {
      throw error;
    }
    const durable = readDurableCandidateApplyOperation(dependencies.db, input.operationId);
    if (!durable) throw error;
    assertDurableCandidateApplyIdentity(durable, input);
    return projectDurableCandidateApplyResult(durable);
  }
}
