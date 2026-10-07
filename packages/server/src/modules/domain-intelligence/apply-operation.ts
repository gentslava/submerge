import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  DOMAIN_RULE_ACTIVATION_ERROR_CATEGORIES,
  type DomainRuleActivationErrorCategory,
  domainRuleOperations,
} from "../../db/schema.js";
import { DomainRulePreparedVetoError } from "./apply-errors.js";
import {
  abortPreparedDomainRuleOperation,
  assertPreparedAutomaticOperationAuthorized,
  beginDomainRuleActivation,
  completeDomainRuleActivation,
  type DomainRuleJournalOptions,
  finalizeDomainRuleWrite,
  markDomainRuleOperationReconciliationRequired,
} from "./apply-journal.js";
import {
  type AttestedLocalDomainRuleOperationState,
  isLocalDomainRuleReconciliationFailure,
  type WrittenDomainRules,
} from "./rule-store.js";

type DomainRuleOperation = typeof domainRuleOperations.$inferSelect;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
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
  /** Require the deployment mutation mode before any non-terminal recovery side effect. */
  assertExecutionAllowed: (signal?: AbortSignal) => void | Promise<void>;
  /** Revalidate mutable policy, coverage, topology, and capability under the global apply lock. */
  preflightPrepared: (operation: DomainRuleOperation, signal?: AbortSignal) => Promise<void>;
  /** Attest whether the file is still at the prepared revision or already contains the intent. */
  attestOperation: (input: {
    expectedSourceRevision: string;
    intendedContentSha256: string;
    operationId: string;
    signal?: AbortSignal | undefined;
  }) => Promise<AttestedLocalDomainRuleOperationState>;
  /** Apply only the journaled ownership delta and atomically replace the local file. */
  commitPrepared: (input: {
    deleteRules: readonly string[];
    expectedSourceRevision: string;
    intendedContentSha256: string;
    operationId: string;
    signal?: AbortSignal | undefined;
    upsertRules: readonly string[];
  }) => Promise<WrittenDomainRules>;
  /** Re-attest the written file before Mihomo activation. */
  attestWritten: (input: {
    contentSha256: string;
    operationId: string;
    revision: string;
    signal?: AbortSignal | undefined;
  }) => Promise<void>;
  /** Serialize config reload and live provider/coverage/route proofs. */
  activateCommitted: (
    input: {
      attempt: number;
      operation: DomainRuleOperation;
      revision: string;
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
      contentSha256: string;
      activationAttempt: number;
    }
  | {
      operationId: string;
      phase: "partial";
      contentSha256: string;
      activationAttempt: number;
      errorCategory: DomainRuleActivationErrorCategory;
    }
  | {
      operationId: string;
      phase: "aborted";
      contentSha256: null;
      activationAttempt: 0;
    };

function assertDependencies(
  dependencies: DomainRuleApplyOperationDependencies,
): DomainRuleApplyOperationDependencies {
  if (
    !dependencies ||
    typeof dependencies.assertExecutionAllowed !== "function" ||
    typeof dependencies.preflightPrepared !== "function" ||
    typeof dependencies.attestOperation !== "function" ||
    typeof dependencies.commitPrepared !== "function" ||
    typeof dependencies.attestWritten !== "function" ||
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

function assertWrittenResult(
  operation: DomainRuleOperation,
  written: WrittenDomainRules,
  requireChanged: boolean,
): WrittenDomainRules {
  if (
    !REVISION_PATTERN.test(written.revision) ||
    written.revision === operation.expectedSourceRevision ||
    written.previousRevision !== operation.expectedSourceRevision ||
    written.contentSha256 !== operation.intendedContentSha256 ||
    !SHA256_PATTERN.test(written.contentSha256) ||
    (requireChanged && written.changed !== true)
  ) {
    throw new Error("domain-rule written result does not match prepared intent");
  }
  return written;
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
    value.state === "expected" &&
    hasExactKeys(record, ["state", "revision", "contentSha256"]) &&
    typeof record.revision === "string" &&
    record.revision === operation.expectedSourceRevision &&
    typeof record.contentSha256 === "string" &&
    SHA256_PATTERN.test(record.contentSha256)
  ) {
    return {
      state: "expected",
      revision: record.revision,
      contentSha256: record.contentSha256,
    };
  }
  if (
    value.state === "written" &&
    hasExactKeys(record, ["state", "revision", "previousRevision", "contentSha256"]) &&
    typeof record.revision === "string" &&
    REVISION_PATTERN.test(record.revision) &&
    record.revision !== operation.expectedSourceRevision &&
    typeof record.previousRevision === "string" &&
    record.previousRevision === operation.expectedSourceRevision &&
    typeof record.contentSha256 === "string" &&
    record.contentSha256 === operation.intendedContentSha256 &&
    SHA256_PATTERN.test(record.contentSha256)
  ) {
    return {
      state: "written",
      revision: record.revision,
      previousRevision: record.previousRevision,
      contentSha256: record.contentSha256,
    };
  }
  throw new Error("domain-rule attestation returned an invalid result");
}

function assertJournaledWrite(operation: DomainRuleOperation): {
  resultingContentSha256: string;
  revision: string;
} {
  if (!operation.resultingRevision || !REVISION_PATTERN.test(operation.resultingRevision)) {
    throw new Error("domain-rule operation has no written content");
  }
  if (operation.resultingRevision === operation.expectedSourceRevision) {
    throw new Error("domain-rule write must advance the prepared revision");
  }
  if (
    !operation.resultingContentSha256 ||
    !SHA256_PATTERN.test(operation.resultingContentSha256) ||
    operation.resultingContentSha256 !== operation.intendedContentSha256
  ) {
    throw new Error("domain-rule written content does not match prepared intent");
  }
  return {
    resultingContentSha256: operation.resultingContentSha256,
    revision: operation.resultingRevision,
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
  contentSha256: string,
  attempt: number,
  errorCategory: DomainRuleActivationErrorCategory,
): DomainRuleApplyOperationResult {
  return {
    operationId,
    phase: "partial",
    contentSha256,
    activationAttempt: attempt,
    errorCategory,
  };
}

function abortedResult(operationId: string): DomainRuleApplyOperationResult {
  return {
    operationId,
    phase: "aborted",
    contentSha256: null,
    activationAttempt: 0,
  };
}

function isReconciliationFailure(error: unknown): boolean {
  return (
    error instanceof DomainRuleOperationReconciliationError ||
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
    return abortedResult(operation.id);
  }
  if (operation.phase === "completed") {
    const committed = assertJournaledWrite(operation);
    return {
      operationId: operation.id,
      phase: "completed",
      contentSha256: committed.resultingContentSha256,
      activationAttempt: operation.activationAttemptCount,
    };
  }

  await dependencies.assertExecutionAllowed(options.signal);
  options.signal?.throwIfAborted();

  if (operation.phase === "prepared") {
    if (operation.action === "rollback") {
      throw new Error("domain-rule rollback execution unavailable");
    }
    let rawAttestation: AttestedLocalDomainRuleOperationState;
    try {
      rawAttestation = await dependencies.attestOperation({
        operationId: operation.id,
        expectedSourceRevision: operation.expectedSourceRevision,
        intendedContentSha256: operation.intendedContentSha256,
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

    let written: WrittenDomainRules;
    if (attested.state === "written") {
      written = assertWrittenResult(
        operation,
        {
          changed: false,
          revision: attested.revision,
          previousRevision: attested.previousRevision,
          contentSha256: attested.contentSha256,
        },
        false,
      );
    } else {
      if (attested.revision !== operation.expectedSourceRevision) {
        throw new Error("domain-rule attestation does not match prepared revision");
      }
      try {
        await dependencies.preflightPrepared(operation, options.signal);
        options.signal?.throwIfAborted();
        if (operation.action === "automatic-add") {
          assertPreparedAutomaticOperationAuthorized(db, operation.id);
        }
      } catch (error) {
        if (!(error instanceof DomainRulePreparedVetoError)) throw error;
        let aborted: boolean;
        try {
          aborted = await abortPreparedDomainRuleOperation(db, operation.id, {
            ...options,
            assertPreWriteState: async (intent) => {
              const state = parseAttestation(
                await dependencies.attestOperation({
                  operationId: intent.operationId,
                  expectedSourceRevision: intent.expectedSourceRevision,
                  intendedContentSha256: intent.intendedContentSha256,
                  ...signalOptions(options.signal),
                }),
                operation,
              );
              if (state.state !== "expected") {
                throw new DomainRuleOperationReconciliationError(
                  "domain-rule preflight veto raced a local write",
                );
              }
            },
          });
        } catch (abortError) {
          if (isReconciliationFailure(abortError)) {
            markDomainRuleOperationReconciliationRequired(db, operation.id, options);
          }
          throw abortError;
        }
        if (!aborted) {
          throw new DomainRuleOperationReconciliationError(
            "domain-rule preflight veto could not abort prepared operation",
          );
        }
        return abortedResult(operation.id);
      }
      options.signal?.throwIfAborted();
      try {
        written = assertWrittenResult(
          operation,
          await dependencies.commitPrepared({
            operationId: operation.id,
            expectedSourceRevision: operation.expectedSourceRevision,
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
    finalizeDomainRuleWrite(
      db,
      {
        operationId: operation.id,
        resultingRevision: written.revision,
        resultingContentSha256: written.contentSha256,
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
  assertJournaledWrite(operation);

  const activation = beginDomainRuleActivation(db, operation.id, options);
  const attempt = activation.attempt;
  operation = readOperation(db, operation.id);
  const { revision, resultingContentSha256 } = assertJournaledWrite(operation);

  try {
    await dependencies.attestWritten({
      operationId: operation.id,
      revision,
      contentSha256: resultingContentSha256,
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
    return partialResult(operation.id, resultingContentSha256, attempt, errorCategory);
  }

  let outcome: DomainRuleActivationOutcome | undefined;
  let activationErrorCategory: DomainRuleActivationErrorCategory | undefined;
  try {
    outcome = parseActivationOutcome(
      await dependencies.activateCommitted({ operation, attempt, revision }, options.signal),
    );
    options.signal?.throwIfAborted();
  } catch {
    activationErrorCategory = options.signal?.aborted ? "shutdown" : "infrastructure-failure";
  }

  try {
    await dependencies.attestWritten({
      operationId: operation.id,
      revision,
      contentSha256: resultingContentSha256,
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
    return partialResult(operation.id, resultingContentSha256, attempt, errorCategory);
  }

  if (activationErrorCategory) {
    completeDomainRuleActivation(
      db,
      {
        operationId: operation.id,
        attempt,
        outcome: "failed",
        errorCategory: activationErrorCategory,
      },
      options,
    );
    return partialResult(operation.id, resultingContentSha256, attempt, activationErrorCategory);
  }

  if (!outcome) throw new Error("domain-rule activation outcome unavailable");
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
    return partialResult(operation.id, resultingContentSha256, attempt, outcome.errorCategory);
  }

  completeDomainRuleActivation(
    db,
    { operationId: operation.id, attempt, outcome: "succeeded" },
    options,
  );
  return {
    operationId: operation.id,
    phase: "completed",
    contentSha256: resultingContentSha256,
    activationAttempt: attempt,
  };
}
