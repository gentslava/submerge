import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "tldts";
import { normalizeObservedFqdn } from "./observer.js";

export const MANAGED_RULES_BEGIN = "# BEGIN SUBMERGE MANAGED";
export const MANAGED_RULES_END = "# END SUBMERGE MANAGED";
export const DOMAIN_RULE_DIRECTORY_PATH = "/domain-rules";

const MAX_CUSTOM_BYTES = 1024 * 1024;
const MAX_RULE_COUNT = 10_000;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/u;
const TEMPORARY_FILE_PATTERN =
  /^\.custom\.txt\.submerge-[0-9]+-[a-zA-Z0-9._-]+-[a-zA-Z0-9-]+\.tmp$/u;

type LocalDomainRuleStoreFailureReason =
  | "local-store-migration-required"
  | "local-store-reconciliation-required"
  | "local-store-unavailable"
  | "local-store-unsafe";

export class DomainRuleStoreError extends Error {
  override readonly name = "DomainRuleStoreError";

  constructor(
    readonly reason: LocalDomainRuleStoreFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface LocalDomainRuleStorePaths {
  lockFilePath: string;
  ruleDirectoryPath: string;
  ruleFilePath: string;
}

export interface LocalDomainRuleStoreState {
  baselineCreated: boolean;
  content: string;
  contentSha256: string;
  revision: string;
  ruleCount: number;
}

export interface ManagedDomainRulesUpdate {
  changed: boolean;
  content: string;
}

export interface PreparedLocalDomainRuleMutationIntent {
  expectedSourceRevision: string;
  intendedContentSha256: string;
}

export interface WrittenDomainRules {
  changed: boolean;
  contentSha256: string;
  previousRevision: string;
  revision: string;
}

export type AttestedLocalDomainRuleOperationState =
  | {
      contentSha256: string;
      revision: string;
      state: "expected";
    }
  | {
      contentSha256: string;
      previousRevision: string;
      revision: string;
      state: "written";
    };

interface StoreLock {
  descriptor: number;
  dev: number;
  ino: number;
  path: string;
}

export interface PrepareLocalDomainRuleMutationIntentInput {
  deleteRules: readonly string[];
  ruleDirectoryPath: string;
  signal?: AbortSignal | undefined;
  upsertRules: readonly string[];
}

type MutationInput = PrepareLocalDomainRuleMutationIntentInput;

function assertNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function revisionFor(content: string): string {
  return sha256(content).slice(0, 40);
}

function countOccurrences(value: string, token: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const occurrenceIndex = value.indexOf(token, index);
    if (occurrenceIndex === -1) return count;
    count += 1;
    index = occurrenceIndex + token.length;
  }
}

function isCompleteLineAt(value: string, index: number, token: string): boolean {
  const startsLine = index === 0 || value[index - 1] === "\n";
  const lineEnd = index + token.length;
  const endsLine =
    lineEnd === value.length || value[lineEnd] === "\n" || value.startsWith("\r\n", lineEnd);
  return startsLine && endsLine;
}

function assertManagedBlockMarkers(content: string): void {
  const beginCount = countOccurrences(content, MANAGED_RULES_BEGIN);
  const endCount = countOccurrences(content, MANAGED_RULES_END);
  const beginIndex = content.indexOf(MANAGED_RULES_BEGIN);
  const endIndex = content.indexOf(MANAGED_RULES_END);
  if (
    beginCount !== endCount ||
    beginCount > 1 ||
    (beginIndex !== -1 && !isCompleteLineAt(content, beginIndex, MANAGED_RULES_BEGIN)) ||
    (endIndex !== -1 && !isCompleteLineAt(content, endIndex, MANAGED_RULES_END)) ||
    (beginIndex !== -1 && endIndex < beginIndex)
  ) {
    throw new DomainRuleStoreError("local-store-unsafe", "invalid managed domain-rule block");
  }
}

function validateDomainRule(rule: string): void {
  const widened = rule.startsWith("+.");
  const hostname = widened ? rule.slice(2) : rule;
  if (normalizeObservedFqdn(hostname) !== hostname) {
    throw new DomainRuleStoreError("local-store-unsafe", "invalid domain rule");
  }
  if (!widened) return;
  const parsed = parse(hostname, { allowPrivateDomains: true, extractHostname: false });
  if (parsed.domain !== hostname) {
    throw new DomainRuleStoreError("local-store-unsafe", "invalid domain rule");
  }
}

function validateDomainRules(rules: readonly string[]): void {
  if (rules.length > MAX_RULE_COUNT) {
    throw new DomainRuleStoreError("local-store-unsafe", "too many domain rules");
  }
  const uniqueRules = new Set<string>();
  for (const rule of rules) {
    validateDomainRule(rule);
    if (uniqueRules.has(rule)) {
      throw new DomainRuleStoreError("local-store-unsafe", "duplicate domain rule");
    }
    uniqueRules.add(rule);
  }
}

function validateCompleteRuleList(content: string): number {
  if (Buffer.byteLength(content, "utf8") > MAX_CUSTOM_BYTES) {
    throw new DomainRuleStoreError("local-store-unsafe", "domain-rule list is too large");
  }
  assertManagedBlockMarkers(content);
  const rules: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.includes("\r")) {
      throw new DomainRuleStoreError("local-store-unsafe", "invalid domain rule");
    }
    if (
      line === "" ||
      line.startsWith("#") ||
      line === MANAGED_RULES_BEGIN ||
      line === MANAGED_RULES_END
    ) {
      continue;
    }
    rules.push(line);
  }
  validateDomainRules(rules);
  return rules.length;
}

function managedDomainRules(content: string): string[] {
  validateCompleteRuleList(content);
  const beginIndex = content.indexOf(MANAGED_RULES_BEGIN);
  if (beginIndex === -1) return [];
  const endIndex = content.indexOf(MANAGED_RULES_END);
  const blockStart = beginIndex + MANAGED_RULES_BEGIN.length;
  return content
    .slice(blockStart, endIndex)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function parseManagedDomainRules(content: string): readonly string[] {
  return managedDomainRules(content);
}

export function updateManagedDomainRules(
  existing: string,
  rules: readonly string[],
): ManagedDomainRulesUpdate {
  validateDomainRules(rules);
  const managedRules = [...rules].sort().join("\n");
  const block = `${MANAGED_RULES_BEGIN}\n${managedRules}${managedRules ? "\n" : ""}${MANAGED_RULES_END}\n`;
  assertManagedBlockMarkers(existing);
  const beginIndex = existing.indexOf(MANAGED_RULES_BEGIN);
  const endIndex = existing.indexOf(MANAGED_RULES_END);

  let content: string;
  if (beginIndex === -1) {
    const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
    content = `${prefix}${block}`;
  } else {
    const endLineIndex = endIndex + MANAGED_RULES_END.length;
    const suffixIndex = existing.startsWith("\r\n", endLineIndex)
      ? endLineIndex + 2
      : existing.startsWith("\n", endLineIndex)
        ? endLineIndex + 1
        : endLineIndex;
    content = `${existing.slice(0, beginIndex)}${block}${existing.slice(suffixIndex)}`;
  }
  validateCompleteRuleList(content);
  return { content, changed: content !== existing };
}

function assertSafeDirectory(path: string, requireRuntimeOwner: boolean = true): string {
  const stat = lstatSync(path);
  const effectiveUserId = process.geteuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (requireRuntimeOwner && effectiveUserId !== undefined && stat.uid !== effectiveUserId) ||
    (requireRuntimeOwner ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o022) !== 0)
  ) {
    throw new DomainRuleStoreError("local-store-unsafe", "unsafe local domain-rule directory");
  }
  return realpathSync(path);
}

export function ruleStorePaths(ruleDirectoryPath: string): LocalDomainRuleStorePaths {
  const requestedPath = resolve(ruleDirectoryPath);
  const trustedParentPath = assertSafeDirectory(dirname(requestedPath), false);
  const canonicalRuleDirectoryPath = join(trustedParentPath, basename(requestedPath));
  return {
    lockFilePath: join(canonicalRuleDirectoryPath, ".submerge-domain-rules.lock"),
    ruleDirectoryPath: canonicalRuleDirectoryPath,
    ruleFilePath: join(canonicalRuleDirectoryPath, "custom.txt"),
  };
}

function ensureRuleDirectory(ruleDirectoryPath: string): LocalDomainRuleStorePaths {
  const paths = ruleStorePaths(ruleDirectoryPath);
  if (!existsSync(paths.ruleDirectoryPath)) mkdirSync(paths.ruleDirectoryPath, { mode: 0o700 });
  if (assertSafeDirectory(paths.ruleDirectoryPath) !== paths.ruleDirectoryPath) {
    throw new DomainRuleStoreError("local-store-unsafe", "unsafe local domain-rule directory");
  }
  return paths;
}

function acquireStoreLock(paths: LocalDomainRuleStorePaths): StoreLock {
  let descriptor: number;
  try {
    descriptor = openSync(
      paths.lockFilePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    throw new DomainRuleStoreError(
      "local-store-unavailable",
      code === "EEXIST"
        ? "local domain-rule store is locked"
        : "local domain-rule lock unavailable",
      { cause: error },
    );
  }
  try {
    writeFileSync(descriptor, `${process.pid}:${randomUUID()}\n`, "utf8");
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    return { descriptor, dev: stat.dev, ino: stat.ino, path: paths.lockFilePath };
  } catch (error) {
    closeSync(descriptor);
    try {
      unlinkSync(paths.lockFilePath);
    } catch {
      // Preserve the original failure; a leftover lock fails closed on the next attempt.
    }
    throw new DomainRuleStoreError("local-store-unavailable", "local domain-rule lock failed", {
      cause: error,
    });
  }
}

function releaseStoreLock(lock: StoreLock): void {
  closeSync(lock.descriptor);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(lock.path);
  } catch (error) {
    throw new DomainRuleStoreError(
      "local-store-reconciliation-required",
      "local domain-rule lock disappeared",
      { cause: error },
    );
  }
  if (stat.isSymbolicLink() || stat.dev !== lock.dev || stat.ino !== lock.ino) {
    throw new DomainRuleStoreError(
      "local-store-reconciliation-required",
      "local domain-rule lock identity changed",
    );
  }
  try {
    unlinkSync(lock.path);
  } catch (error) {
    throw new DomainRuleStoreError(
      "local-store-reconciliation-required",
      "local domain-rule lock release failed",
      { cause: error },
    );
  }
}

function withStoreLock<T>(paths: LocalDomainRuleStorePaths, operation: () => T): T {
  const lock = acquireStoreLock(paths);
  let outcome: { ok: true; value: T } | { error: unknown; ok: false };
  try {
    const entries = readdirSync(paths.ruleDirectoryPath);
    if (entries.some((entry) => TEMPORARY_FILE_PATTERN.test(entry))) {
      throw new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "interrupted local domain-rule write requires reconciliation",
      );
    }
    outcome = { ok: true, value: operation() };
  } catch (error) {
    outcome = { error, ok: false };
  }
  try {
    releaseStoreLock(lock);
  } catch (error) {
    if (outcome.ok) throw error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function readRuleFile(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new DomainRuleStoreError(
      "local-store-unavailable",
      "local domain-rule file unavailable",
      {
        cause: error,
      },
    );
  }
  try {
    const stat = fstatSync(descriptor);
    const effectiveUserId = process.geteuid?.();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (effectiveUserId !== undefined && stat.uid !== effectiveUserId) ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_CUSTOM_BYTES
    ) {
      throw new DomainRuleStoreError("local-store-unsafe", "unsafe local domain-rule file");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        readFileSync(descriptor),
      );
    } catch (error) {
      throw new DomainRuleStoreError("local-store-unsafe", "invalid UTF-8 domain-rule file", {
        cause: error,
      });
    }
    validateCompleteRuleList(content);
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function stateFor(content: string, baselineCreated: boolean): LocalDomainRuleStoreState {
  return {
    baselineCreated,
    content,
    contentSha256: sha256(content),
    revision: revisionFor(content),
    ruleCount: validateCompleteRuleList(content),
  };
}

function createBaseline(paths: LocalDomainRuleStorePaths): string {
  const baseline = `${MANAGED_RULES_BEGIN}\n${MANAGED_RULES_END}\n`;
  const descriptor = openSync(
    paths.ruleFilePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, baseline, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directoryDescriptor = openSync(paths.ruleDirectoryPath, constants.O_RDONLY);
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  return baseline;
}

function atomicWrite(paths: LocalDomainRuleStorePaths, operationId: string, content: string): void {
  const temporaryPath = join(
    paths.ruleDirectoryPath,
    `.custom.txt.submerge-${process.pid}-${operationId}-${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, paths.ruleFilePath);
    const directoryDescriptor = openSync(paths.ruleDirectoryPath, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the publication failure; leftover files are rejected by operator inspection.
    }
    throw new DomainRuleStoreError("local-store-unavailable", "local domain-rule write failed", {
      cause: error,
    });
  }
}

function applyDelta(content: string, input: MutationInput): ManagedDomainRulesUpdate {
  const current = new Set(managedDomainRules(content));
  for (const rule of input.deleteRules) current.delete(rule);
  for (const rule of input.upsertRules) current.add(rule);
  return updateManagedDomainRules(content, [...current]);
}

export async function provisionLocalDomainRuleStore(input: {
  allowCreateBaseline?: boolean | undefined;
  ruleDirectoryPath: string;
  signal?: AbortSignal | undefined;
}): Promise<LocalDomainRuleStoreState> {
  assertNotAborted(input.signal);
  const paths = ensureRuleDirectory(input.ruleDirectoryPath);
  return withStoreLock(paths, () => {
    assertNotAborted(input.signal);
    if (!existsSync(paths.ruleFilePath)) {
      if (input.allowCreateBaseline === false) {
        throw new DomainRuleStoreError(
          "local-store-migration-required",
          "local domain-rule file is missing after prior provisioning",
        );
      }
      return stateFor(createBaseline(paths), true);
    }
    return stateFor(readRuleFile(paths.ruleFilePath), false);
  });
}

export function inspectLocalDomainRuleStore(input: {
  ruleDirectoryPath: string;
  signal?: AbortSignal | undefined;
}): LocalDomainRuleStoreState {
  assertNotAborted(input.signal);
  const paths = ruleStorePaths(input.ruleDirectoryPath);
  if (!existsSync(paths.ruleDirectoryPath)) {
    throw new DomainRuleStoreError(
      "local-store-unavailable",
      "local domain-rule directory missing",
    );
  }
  if (assertSafeDirectory(paths.ruleDirectoryPath) !== paths.ruleDirectoryPath) {
    throw new DomainRuleStoreError("local-store-unsafe", "unsafe local domain-rule directory");
  }
  const content = readRuleFile(paths.ruleFilePath);
  assertNotAborted(input.signal);
  return stateFor(content, false);
}

export async function prepareLocalDomainRuleMutationIntent(
  input: MutationInput,
): Promise<PreparedLocalDomainRuleMutationIntent> {
  assertNotAborted(input.signal);
  const paths = ensureRuleDirectory(input.ruleDirectoryPath);
  return withStoreLock(paths, () => {
    assertNotAborted(input.signal);
    const current = readRuleFile(paths.ruleFilePath);
    const intended = applyDelta(current, input);
    if (!intended.changed) {
      throw new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule mutation has no effect",
      );
    }
    return {
      expectedSourceRevision: revisionFor(current),
      intendedContentSha256: sha256(intended.content),
    };
  });
}

export async function commitPreparedDomainRuleMutation(
  input: MutationInput & {
    expectedSourceRevision: string;
    intendedContentSha256: string;
    operationId: string;
  },
): Promise<WrittenDomainRules> {
  if (!OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new DomainRuleStoreError("local-store-unsafe", "invalid domain-rule operation id");
  }
  assertNotAborted(input.signal);
  const paths = ensureRuleDirectory(input.ruleDirectoryPath);
  return withStoreLock(paths, () => {
    assertNotAborted(input.signal);
    const current = readRuleFile(paths.ruleFilePath);
    if (revisionFor(current) !== input.expectedSourceRevision) {
      throw new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule source changed",
      );
    }
    const intended = applyDelta(current, input);
    const intendedDigest = sha256(intended.content);
    if (!intended.changed || intendedDigest !== input.intendedContentSha256) {
      throw new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule intent changed",
      );
    }
    atomicWrite(paths, input.operationId, intended.content);
    const written = readRuleFile(paths.ruleFilePath);
    if (sha256(written) !== input.intendedContentSha256) {
      throw new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule write attestation failed",
      );
    }
    return {
      changed: true,
      previousRevision: input.expectedSourceRevision,
      contentSha256: input.intendedContentSha256,
      revision: revisionFor(written),
    };
  });
}

export function isLocalDomainRuleReconciliationFailure(error: unknown): boolean {
  return (
    error instanceof DomainRuleStoreError && error.reason === "local-store-reconciliation-required"
  );
}

export async function attestLocalDomainRuleOperationState(input: {
  expectedSourceRevision: string;
  intendedContentSha256: string;
  ruleDirectoryPath: string;
  operationId: string;
  signal?: AbortSignal | undefined;
}): Promise<AttestedLocalDomainRuleOperationState> {
  if (!OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new DomainRuleStoreError("local-store-unsafe", "invalid domain-rule operation id");
  }
  assertNotAborted(input.signal);
  const paths = ensureRuleDirectory(input.ruleDirectoryPath);
  return withStoreLock(paths, () => {
    assertNotAborted(input.signal);
    const content = readRuleFile(paths.ruleFilePath);
    const contentSha256 = sha256(content);
    const revision = revisionFor(content);
    if (revision === input.expectedSourceRevision) {
      return { state: "expected", revision, contentSha256 };
    }
    if (contentSha256 === input.intendedContentSha256) {
      return {
        state: "written",
        revision,
        previousRevision: input.expectedSourceRevision,
        contentSha256,
      };
    }
    throw new DomainRuleStoreError(
      "local-store-reconciliation-required",
      "local domain-rule source changed",
    );
  });
}

export async function attestWrittenLocalDomainRuleStore(input: {
  contentSha256: string;
  ruleDirectoryPath: string;
  revision: string;
  signal?: AbortSignal | undefined;
}): Promise<LocalDomainRuleStoreState> {
  assertNotAborted(input.signal);
  const paths = ensureRuleDirectory(input.ruleDirectoryPath);
  return withStoreLock(paths, () => {
    const content = readRuleFile(paths.ruleFilePath);
    const state = stateFor(content, false);
    if (state.revision !== input.revision || state.contentSha256 !== input.contentSha256) {
      throw new DomainRuleStoreError(
        "local-store-reconciliation-required",
        "local domain-rule write attestation failed",
      );
    }
    return state;
  });
}
