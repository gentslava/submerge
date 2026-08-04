import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  DOMAIN_RULE_ACTIVATION_ERROR_CATEGORIES,
  type DomainRuleActivationErrorCategory,
  domainRuleOperations,
} from "../../db/schema.js";
import {
  assertPreparedAutomaticOperationAuthorized,
  beginDomainRuleActivation,
  completeDomainRuleActivation,
  type DomainRuleJournalOptions,
  finalizeDomainRuleCommit,
  markDomainRuleOperationReconciliationRequired,
} from "./apply-journal.js";
import { DomainRuleMaterializationError } from "./materialization.js";
import {
  type AttestedLocalDomainRuleOperationState,
  type CommittedDomainRules,
  isLocalDomainRuleReconciliationFailure,
} from "./publisher.js";

type DomainRuleOperation = typeof domainRuleOperations.$inferSelect;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ACTIVATION_ERROR_CATEGORIES = new Set<string>(DOMAIN_RULE_ACTIVATION_ERROR_CATEGORIES);

export class DomainRuleOperationReconciliationError extends Error {
  override readonly name = "DomainRuleOperationReconciliationError";
}

export type DomainRuleActivationOutcome =
  | { outcome: "succeeded" }
  | {
      outcome: "failed";
      errorCategory: DomainRuleActivationErrorCategory;
    };

export interface DomainRuleApplyOperationDependencies {
  /** Revalidate mutable policy, coverage, topology, and capability under the global apply lock. */
  preflightPrepared: (operation: DomainRuleOperation, signal?: AbortSignal) => Promise<void>;
  /** Attest whether HEAD is still the prepared parent or the exact journaled child commit. */
  attestOperation: (input: {
    committedContentSha256: string;
    expectedParent: string;
    operationId: string;
    signal?: AbortSignal | undefined;
  }) => Promise<AttestedLocalDomainRuleOperationState>;
  /** Apply only the journaled ownership delta and create the attested local commit. */
  commitPrepared: (input: {
    deleteRules: readonly string[];
    expectedParent: string;
    intendedContentSha256: string;
    operationId: string;
    signal?: AbortSignal | undefined;
    upsertRules: readonly string[];
  }) => Promise<CommittedDomainRules>;
  /** Materialize the exact committed blob into the active Mihomo provider path. */
  materializeCommitted: (input: {
    committedContentSha256: string;
    commitSha: string;
    expectedParent: string;
    operationId: string;
    signal?: AbortSignal | undefined;
  }) => Promise<void>;
  /** Serialize config reload and live provider/coverage/route proofs. */
  activateCommitted: (
    input: {
      attempt: number;
      commitSha: string;
      operation: DomainRuleOperation;
    },
    signal?: AbortSignal,
  ) => Promise<DomainRuleActivationOutcome>;
}

export interface ExecuteDomainRuleOperationOptions extends DomainRuleJournalOptions {
  signal?: AbortSignal | undefined;
}

export type DomainRuleApplyOperationResult =
  | {
      operationId: string;
      phase: "completed";
      commitSha: string;
      activationAttempt: number;
    }
  | {
      operationId: string;
      phase: "partial";
      commitSha: string;
      activationAttempt: number;
      errorCategory: DomainRuleActivationErrorCategory;
    }
  | {
      operationId: string;
      phase: "aborted";
      commitSha: null;
      activationAttempt: 0;
    };

function assertDependencies(
  dependencies: DomainRuleApplyOperationDependencies,
): DomainRuleApplyOperationDependencies {
  if (
    !dependencies ||
    typeof dependencies.preflightPrepared !== "function" ||
    typeof dependencies.attestOperation !== "function" ||
    typeof dependencies.commitPrepared !== "function" ||
    typeof dependencies.materializeCommitted !== "function" ||
    typeof dependencies.activateCommitted !== "function"
  ) {
    throw new Error("domain-rule apply dependencies unavailable");
  }
  return dependencies;
}

function readOperation(db: Db, operationId: string): DomainRuleOperation {
  const operation = db
    .select()
    .from(domainRuleOperations)
    .where(eq(domainRuleOperations.id, operationId))
    .get();
  if (!operation) throw new Error("domain-rule operation not found");
  return operation;
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function assertCommittedResult(
  operation: DomainRuleOperation,
  committed: CommittedDomainRules,
  requireChanged: boolean,
): CommittedDomainRules {
  if (
    !SHA1_PATTERN.test(committed.head) ||
    committed.head === operation.expectedParentCommit ||
    committed.parent !== operation.expectedParentCommit ||
    committed.contentSha256 !== operation.intendedContentSha256 ||
    !SHA256_PATTERN.test(committed.contentSha256) ||
    (requireChanged && committed.changed !== true)
  ) {
    throw new Error("domain-rule committed result does not match prepared intent");
  }
  return committed;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function parseAttestation(
  value: unknown,
  operation: DomainRuleOperation,
): AttestedLocalDomainRuleOperationState {
  if (typeof value !== "object" || value === null || !("state" in value)) {
    throw new Error("domain-rule attestation returned an invalid result");
  }
  const record = value as Record<string, unknown>;
  if (
    value.state === "parent" &&
    hasExactKeys(record, ["state", "head", "contentSha256"]) &&
    typeof record.head === "string" &&
    record.head === operation.expectedParentCommit &&
    typeof record.contentSha256 === "string" &&
    SHA256_PATTERN.test(record.contentSha256)
  ) {
    return {
      state: "parent",
      head: record.head,
      contentSha256: record.contentSha256,
    };
  }
  if (
    value.state === "committed" &&
    hasExactKeys(record, ["state", "head", "parent", "contentSha256"]) &&
    typeof record.head === "string" &&
    SHA1_PATTERN.test(record.head) &&
    record.head !== operation.expectedParentCommit &&
    typeof record.parent === "string" &&
    record.parent === operation.expectedParentCommit &&
    typeof record.contentSha256 === "string" &&
    record.contentSha256 === operation.intendedContentSha256 &&
    SHA256_PATTERN.test(record.contentSha256)
  ) {
    return {
      state: "committed",
      head: record.head,
      parent: record.parent,
      contentSha256: record.contentSha256,
    };
  }
  throw new Error("domain-rule attestation returned an invalid result");
}

function assertJournaledCommit(operation: DomainRuleOperation): {
  commitSha: string;
  committedContentSha256: string;
} {
  if (!operation.commitSha || !SHA1_PATTERN.test(operation.commitSha)) {
    throw new Error("domain-rule operation has no committed content");
  }
  if (operation.commitSha === operation.expectedParentCommit) {
    throw new Error("domain-rule commit must be a child of the prepared parent");
  }
  if (
    !operation.committedContentSha256 ||
    !SHA256_PATTERN.test(operation.committedContentSha256) ||
    operation.committedContentSha256 !== operation.intendedContentSha256
  ) {
    throw new Error("domain-rule committed content does not match prepared intent");
  }
  return {
    commitSha: operation.commitSha,
    committedContentSha256: operation.committedContentSha256,
  };
}

function parseActivationOutcome(value: unknown): DomainRuleActivationOutcome {
  if (typeof value !== "object" || value === null || !("outcome" in value)) {
    throw new Error("domain-rule activation returned an invalid result");
  }
  const record = value as Record<string, unknown>;
  if (value.outcome === "succeeded" && hasExactKeys(record, ["outcome"])) {
    return { outcome: "succeeded" };
  }
  if (
    value.outcome === "failed" &&
    hasExactKeys(record, ["outcome", "errorCategory"]) &&
    "errorCategory" in value &&
    typeof value.errorCategory === "string" &&
    ACTIVATION_ERROR_CATEGORIES.has(value.errorCategory)
  ) {
    const category = value.errorCategory as DomainRuleActivationErrorCategory;
    return { outcome: "failed", errorCategory: category };
  }
  throw new Error("domain-rule activation returned an invalid result");
}

function partialResult(
  operationId: string,
  commitSha: string,
  attempt: number,
  errorCategory: DomainRuleActivationErrorCategory,
): DomainRuleApplyOperationResult {
  return {
    operationId,
    phase: "partial",
    commitSha,
    activationAttempt: attempt,
    errorCategory,
  };
}

function isReconciliationFailure(error: unknown): boolean {
  return (
    error instanceof DomainRuleOperationReconciliationError ||
    (error instanceof DomainRuleMaterializationError &&
      error.reason === "local-store-reconciliation-required") ||
    isLocalDomainRuleReconciliationFailure(error)
  );
}

/**
 * Execute or recover one durable rule mutation. The caller must hold the
 * process-wide apply lock for the entire call, including preflight and proof.
 */
export async function executeDomainRuleOperation(
  db: Db,
  operationId: string,
  rawDependencies: DomainRuleApplyOperationDependencies,
  options: ExecuteDomainRuleOperationOptions = {},
): Promise<DomainRuleApplyOperationResult> {
  const dependencies = assertDependencies(rawDependencies);
  options.signal?.throwIfAborted();
  let operation = readOperation(db, operationId);

  if (operation.phase === "reconciliation-required") {
    throw new Error("domain-rule reconciliation required");
  }
  if (operation.phase === "aborted") {
    return {
      operationId: operation.id,
      phase: "aborted",
      commitSha: null,
      activationAttempt: 0,
    };
  }
  if (operation.phase === "completed") {
    const committed = assertJournaledCommit(operation);
    return {
      operationId: operation.id,
      phase: "completed",
      commitSha: committed.commitSha,
      activationAttempt: operation.activationAttemptCount,
    };
  }

  if (operation.phase === "prepared") {
    if (operation.action === "rollback") {
      throw new Error("domain-rule rollback execution unavailable");
    }
    let rawAttestation: AttestedLocalDomainRuleOperationState;
    try {
      rawAttestation = await dependencies.attestOperation({
        operationId: operation.id,
        expectedParent: operation.expectedParentCommit,
        committedContentSha256: operation.intendedContentSha256,
        ...signalOptions(options.signal),
      });
    } catch (error) {
      if (isReconciliationFailure(error)) {
        markDomainRuleOperationReconciliationRequired(db, operation.id, options);
      }
      throw error;
    }
    const attested = parseAttestation(rawAttestation, operation);
    options.signal?.throwIfAborted();

    let committed: CommittedDomainRules;
    if (attested.state === "committed") {
      committed = assertCommittedResult(
        operation,
        {
          changed: false,
          head: attested.head,
          parent: attested.parent,
          contentSha256: attested.contentSha256,
        },
        false,
      );
    } else {
      if (attested.head !== operation.expectedParentCommit) {
        throw new Error("domain-rule attestation does not match prepared parent");
      }
      await dependencies.preflightPrepared(operation, options.signal);
      options.signal?.throwIfAborted();
      if (operation.action === "automatic-add") {
        assertPreparedAutomaticOperationAuthorized(db, operation.id);
      }
      try {
        committed = assertCommittedResult(
          operation,
          await dependencies.commitPrepared({
            operationId: operation.id,
            expectedParent: operation.expectedParentCommit,
            intendedContentSha256: operation.intendedContentSha256,
            upsertRules: operation.ownershipDelta.upserts.map(({ rule }) => rule),
            deleteRules: operation.ownershipDelta.deletes,
            ...signalOptions(options.signal),
          }),
          true,
        );
      } catch (error) {
        if (isReconciliationFailure(error)) {
          markDomainRuleOperationReconciliationRequired(db, operation.id, options);
        }
        throw error;
      }
    }
    finalizeDomainRuleCommit(
      db,
      {
        operationId: operation.id,
        commitSha: committed.head,
        committedContentSha256: committed.contentSha256,
      },
      options,
    );
    operation = readOperation(db, operation.id);
  }

  if (
    operation.phase !== "committed" &&
    operation.phase !== "activating" &&
    operation.phase !== "partial"
  ) {
    throw new Error("domain-rule operation cannot be applied");
  }
  assertJournaledCommit(operation);

  const activation = beginDomainRuleActivation(db, operation.id, options);
  const attempt = activation.attempt;
  operation = readOperation(db, operation.id);
  const { commitSha, committedContentSha256 } = assertJournaledCommit(operation);

  try {
    await dependencies.materializeCommitted({
      operationId: operation.id,
      expectedParent: operation.expectedParentCommit,
      commitSha,
      committedContentSha256,
      ...signalOptions(options.signal),
    });
    options.signal?.throwIfAborted();
  } catch (error) {
    if (isReconciliationFailure(error)) {
      markDomainRuleOperationReconciliationRequired(db, operation.id, options);
      throw error;
    }
    const errorCategory = options.signal?.aborted ? "shutdown" : "materialization-failure";
    completeDomainRuleActivation(
      db,
      { operationId: operation.id, attempt, outcome: "failed", errorCategory },
      options,
    );
    return partialResult(operation.id, commitSha, attempt, errorCategory);
  }

  let outcome: DomainRuleActivationOutcome;
  try {
    outcome = parseActivationOutcome(
      await dependencies.activateCommitted({ operation, attempt, commitSha }, options.signal),
    );
    options.signal?.throwIfAborted();
  } catch {
    const errorCategory = options.signal?.aborted ? "shutdown" : "infrastructure-failure";
    completeDomainRuleActivation(
      db,
      { operationId: operation.id, attempt, outcome: "failed", errorCategory },
      options,
    );
    return partialResult(operation.id, commitSha, attempt, errorCategory);
  }

  if (outcome.outcome === "failed") {
    completeDomainRuleActivation(
      db,
      {
        operationId: operation.id,
        attempt,
        outcome: "failed",
        errorCategory: outcome.errorCategory,
      },
      options,
    );
    return partialResult(operation.id, commitSha, attempt, outcome.errorCategory);
  }

  completeDomainRuleActivation(
    db,
    { operationId: operation.id, attempt, outcome: "succeeded" },
    options,
  );
  return {
    operationId: operation.id,
    phase: "completed",
    commitSha,
    activationAttempt: attempt,
  };
}
