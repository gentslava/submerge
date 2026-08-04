import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "tldts";
import {
  type DomainRuleMaterializationResult,
  materializeCommittedDomainRules,
  reconcileInitialDomainRuleMaterialization,
} from "./materialization.js";
import { normalizeObservedFqdn } from "./observer.js";

export const MANAGED_RULES_BEGIN = "# BEGIN SUBMERGE MANAGED";
export const MANAGED_RULES_END = "# END SUBMERGE MANAGED";

export interface ManagedDomainRulesUpdate {
  content: string;
  changed: boolean;
}

export interface LocalRuleRepositoryState {
  baselineCreated: boolean;
  contentSha256: string;
  head: string;
  operationIds: readonly string[];
}

interface AttestedLocalRuleRepositoryState extends LocalRuleRepositoryState {
  content: string;
}

export interface LocalRuleRepositoryPaths {
  repositoryPath: string;
  trustedParentPath: string;
}

type PublisherTestFailpoint =
  | "after-baseline-commit"
  | "after-baseline-config"
  | "after-baseline-index"
  | "after-baseline-install"
  | "after-ref-update-ambiguous"
  | "after-ref-update-committed"
  | "after-seed-create"
  | "after-staging-init"
  | "after-worktree-rename"
  | "after-worktree-write";

type BaselineDurabilityTraceEvent =
  | "baseline-git-renamed"
  | "baseline-install-checkpoint"
  | "baseline-parent-fsynced"
  | "baseline-repository-fsynced"
  | "baseline-staging-fsynced";

export interface LocalRuleRepositoryOptions {
  signal?: AbortSignal | undefined;
  /** @internal Deterministic durability-order trace for publisher tests. */
  testDurabilityTrace?: ((event: BaselineDurabilityTraceEvent) => void) | undefined;
  /** @internal Deterministic failure injection for publisher tests. */
  testFailpoint?:
    | "after-baseline-commit"
    | "after-baseline-config"
    | "after-baseline-index"
    | "after-baseline-install"
    | "after-seed-create"
    | "after-staging-init"
    | undefined;
  trustedParentPath: string;
}

export interface ProvisionLocalDomainRuleStoreInput extends LocalRuleRepositoryOptions {
  mihomoConfigPath: string;
  repositoryPath: string;
  /** @internal Deterministic directory-creation race injection for materialization tests. */
  testBeforeMaterializationDirectoryCreate?: ((directoryPath: string) => void) | undefined;
  /** @internal Deterministic existing-file race injection for materialization tests. */
  testBeforeMaterializationExistingRead?: ((filesystemPath: string) => void) | undefined;
  /** @internal Deterministic publication-race injection for materialization tests. */
  testBeforeMaterializationPublish?: ((filesystemPath: string) => void) | undefined;
}

export interface ProvisionedLocalDomainRuleStore {
  materialization: DomainRuleMaterializationResult;
  repository: LocalRuleRepositoryState;
}

export interface MaterializeCommittedLocalDomainRuleStoreInput extends LocalRuleRepositoryOptions {
  committedContentSha256: string;
  commitSha: string;
  expectedParent: string;
  mihomoConfigPath: string;
  operationId: string;
  repositoryPath: string;
  /** @internal Deterministic publication-race injection for materialization tests. */
  testBeforeMaterializationPublish?: ((filesystemPath: string) => void) | undefined;
}

export interface LocalRuleRepositoryRecoveryOptions {
  /** Operator-only offline recovery after the Submerge service has been stopped. */
  operatorConfirmedStopped?: true | undefined;
  signal?: AbortSignal | undefined;
  /** @internal Deterministic post-repair mutation injection for publisher tests. */
  testAfterRecoveryRepair?: (() => void) | undefined;
  /** @internal Deterministic process-liveness injection for publisher tests. */
  testProcessAlive?: ((pid: number) => boolean) | undefined;
  trustedParentPath: string;
}

export interface CommitManagedDomainRulesInput {
  expectedParent: string;
  operationId: string;
  repositoryPath: string;
  rules: readonly string[];
  signal?: AbortSignal | undefined;
  /** @internal Deterministic failure injection for publisher tests. */
  testFailpoint?:
    | "after-ref-update-ambiguous"
    | "after-ref-update-committed"
    | "after-worktree-rename"
    | "after-worktree-write"
    | undefined;
  trustedParentPath: string;
}

export interface AttestLocalDomainRuleOperationStateInput extends LocalRuleRepositoryOptions {
  committedContentSha256: string;
  expectedParent: string;
  operationId: string;
  repositoryPath: string;
}

export type AttestedLocalDomainRuleOperationState =
  | {
      state: "parent";
      contentSha256: string;
      head: string;
    }
  | {
      state: "committed";
      contentSha256: string;
      head: string;
      parent: string;
    };

export interface CommittedDomainRules {
  changed: boolean;
  contentSha256: string;
  head: string;
  parent: string;
}

interface DirectoryIdentity {
  canonicalPath: string;
  dev: number;
  ino: number;
}

interface RunLocalGitOptions {
  indexPath?: string | undefined;
  signal?: AbortSignal | undefined;
}

interface RepositoryContext {
  parentIdentity: DirectoryIdentity;
  repositoryIdentity: DirectoryIdentity;
}

interface RepositoryLock {
  descriptor: number;
  dev: number;
  ino: number;
  parentIdentity: DirectoryIdentity;
  path: string;
}

interface PrivateFileIdentity {
  dev: number;
  ino: number;
  path: string;
}

interface BaselineStagingTreeEntry {
  dev: number;
  ino: number;
  kind: "directory" | "file";
  relativePath: string;
  size: number;
}

interface BaselineStagingTreeSnapshot {
  entries: readonly BaselineStagingTreeEntry[];
  rootIdentity: DirectoryIdentity;
}

const execFile = promisify(execFileCallback);
const TRUSTED_GIT_BINARY = "/usr/bin/git";
const MAX_CUSTOM_BYTES = 1024 * 1024;
const MAX_RULE_COUNT = 10_000;
const MAX_HISTORY_COMMITS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_GIT_METADATA_ENTRIES = 100_000;
const MAX_LOCAL_CONFIG_ENTRIES = 9;
const MAX_RECOVERY_ARTIFACTS = 8;
const MAX_BASELINE_STAGING_DEPTH = 16;
const MAX_BASELINE_STAGING_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BASELINE_STAGING_TOTAL_BYTES = 16 * 1024 * 1024;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TEMPORARY_INDEX_PATTERN =
  /^submerge-index-[1-9][0-9]{0,9}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\.lock)?$/u;
const TEMPORARY_RULE_FILE_PATTERN =
  /^custom\.txt\.[1-9][0-9]{0,9}\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const RETAIN_REPOSITORY_LOCK = Symbol("retainRepositoryLock");
const REQUIRED_LOCAL_CONFIG = new Map<string, readonly string[]>([
  ["core.repositoryformatversion", ["0"]],
  ["core.filemode", ["true"]],
  ["core.bare", ["false"]],
  ["core.logallrefupdates", ["true"]],
  ["core.autocrlf", ["false"]],
  ["core.fsync", ["committed"]],
  ["core.fsyncmethod", ["fsync"]],
]);
const OPTIONAL_BOOLEAN_LOCAL_CONFIG = new Set(["core.ignorecase", "core.precomposeunicode"]);
const BASELINE_STAGING_GIT_DIRECTORIES = [
  "hooks",
  "info",
  "objects",
  join("objects", "info"),
  join("objects", "pack"),
  "refs",
  join("refs", "heads"),
  join("refs", "tags"),
] as const;
const BASELINE_STAGING_GIT_FILES = ["HEAD", "config", join("info", "exclude")] as const;
const RECOVERABLE_GIT_LOCK_PATHS = [
  "HEAD.lock",
  "config.lock",
  "index.lock",
  "packed-refs.lock",
  join("refs", "heads", "main.lock"),
] as const;
const LOCAL_GIT_STAGES = new Set([
  "add",
  "branch",
  "cat-file",
  "commit",
  "commit-tree",
  "config",
  "diff",
  "for-each-ref",
  "init",
  "ls-files",
  "ls-tree",
  "read-tree",
  "remote",
  "rev-list",
  "rev-parse",
  "show",
  "status",
  "update-ref",
  "write-tree",
]);

export type LocalGitFailureReason = "exit" | "output-limit" | "spawn" | "timeout";

export class LocalGitCommandError extends Error {
  override readonly name = "LocalGitCommandError";

  constructor(
    readonly stage: string,
    readonly reason: LocalGitFailureReason,
    readonly exitCode: number | null,
    readonly signal: string | null,
  ) {
    super("local Git command failed");
  }
}

function abortError(): Error {
  const error = new Error("local Git operation aborted");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function assertTrustedGitBinary(): void {
  let stat: Stats;
  try {
    stat = lstatSync(TRUSTED_GIT_BINARY);
  } catch {
    throw new Error("trusted Git binary unavailable");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== 0)
  ) {
    throw new Error("trusted Git binary unavailable");
  }
}

function localGitEnvironment(indexPath?: string): NodeJS.ProcessEnv {
  return {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_AUTHOR_EMAIL: "submerge@localhost",
    GIT_AUTHOR_NAME: "Submerge",
    GIT_COMMITTER_EMAIL: "submerge@localhost",
    GIT_COMMITTER_NAME: "Submerge",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: "/tmp",
    ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
  };
}

async function runLocalGit(
  repositoryPath: string,
  args: readonly string[],
  options: RunLocalGitOptions = {},
): Promise<string> {
  assertNotAborted(options.signal);
  try {
    const { stdout } = await execFile(
      TRUSTED_GIT_BINARY,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "commit.gpgsign=false",
        "-C",
        repositoryPath,
        ...args,
      ],
      {
        encoding: "utf8",
        env: localGitEnvironment(options.indexPath),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        signal: options.signal,
        timeout: 10_000,
      },
    );
    return stdout;
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    const details =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; killed?: unknown; signal?: unknown })
        : {};
    const stage = args[0] && LOCAL_GIT_STAGES.has(args[0]) ? args[0] : "unknown";
    const exitCode =
      typeof details.code === "number" && Number.isSafeInteger(details.code) ? details.code : null;
    const signal =
      typeof details.signal === "string" && /^SIG[A-Z0-9]+$/u.test(details.signal)
        ? details.signal
        : null;
    const reason: LocalGitFailureReason =
      details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? "output-limit"
        : details.killed === true && signal !== null
          ? "timeout"
          : exitCode !== null
            ? "exit"
            : "spawn";
    throw new LocalGitCommandError(stage, reason, exitCode, signal);
  }
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
    throw new Error("invalid managed domain-rule block");
  }
}

function validateDomainRule(rule: string): void {
  const widened = rule.startsWith("+.");
  const hostname = widened ? rule.slice(2) : rule;
  if (normalizeObservedFqdn(hostname) !== hostname) throw new Error("invalid domain rule");
  if (!widened) return;
  const parsed = parse(hostname, { allowPrivateDomains: true, extractHostname: false });
  if (parsed.domain !== hostname) throw new Error("invalid domain rule");
}

function validateDomainRules(rules: readonly string[]): void {
  if (rules.length > MAX_RULE_COUNT) throw new Error("too many domain rules");
  const uniqueRules = new Set<string>();
  for (const rule of rules) {
    validateDomainRule(rule);
    if (uniqueRules.has(rule)) throw new Error("duplicate domain rule");
    uniqueRules.add(rule);
  }
}

function validateCompleteRuleList(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_CUSTOM_BYTES) {
    throw new Error("domain-rule list is too large");
  }
  assertManagedBlockMarkers(content);
  const rules: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.includes("\r")) throw new Error("invalid domain rule");
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
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** @internal Pure boundary used to verify the pre-mutation history-capacity gate. */
export function hasLocalRuleHistoryCapacity(
  operationCount: number,
  maximumCommitCount: number = MAX_HISTORY_COMMITS,
): boolean {
  return (
    Number.isSafeInteger(operationCount) &&
    operationCount >= 0 &&
    Number.isSafeInteger(maximumCommitCount) &&
    maximumCommitCount >= 1 &&
    operationCount + 2 <= maximumCommitCount
  );
}

function fsyncDirectory(path: string): void {
  const directoryDescriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function removeFileIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function assertPrivateDirectory(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("unsafe local domain-rule repository");
  }
  return { canonicalPath: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertOwnedDirectoryWithoutGroupWrite(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("unsafe local domain-rule data directory");
  }
  return { canonicalPath: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertStableOwnedDirectory(identity: DirectoryIdentity): void {
  const current = assertOwnedDirectoryWithoutGroupWrite(identity.canonicalPath);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("unsafe local domain-rule data directory");
  }
}

export function prepareLocalRuleRepositoryDirectories(
  dataDirectoryPath: string,
): LocalRuleRepositoryPaths {
  const dataIdentity = assertOwnedDirectoryWithoutGroupWrite(resolve(dataDirectoryPath));
  const trustedParentPath = join(dataIdentity.canonicalPath, "domain-rules");
  if (!existsSync(trustedParentPath)) {
    mkdirSync(trustedParentPath, { mode: 0o700 });
    fsyncDirectory(dataIdentity.canonicalPath);
  }
  const trustedParentIdentity = assertPrivateDirectory(trustedParentPath);
  const repositoryPath = join(trustedParentIdentity.canonicalPath, "repository");
  if (!existsSync(repositoryPath)) {
    mkdirSync(repositoryPath, { mode: 0o700 });
    fsyncDirectory(trustedParentIdentity.canonicalPath);
  }
  assertPrivateDirectory(repositoryPath);
  assertStableOwnedDirectory(dataIdentity);
  assertStableDirectory(trustedParentIdentity);
  return { repositoryPath, trustedParentPath: trustedParentIdentity.canonicalPath };
}

function assertStableDirectory(identity: DirectoryIdentity): void {
  const current = assertPrivateDirectory(identity.canonicalPath);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("unsafe local domain-rule repository");
  }
}

function assertPrivateFileStat(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > MAX_CUSTOM_BYTES ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("unsafe local domain-rule repository");
  }
}

function assertSafeGitLockFileStat(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > MAX_CUSTOM_BYTES ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("unsafe local Git lock");
  }
}

function resolveRepositoryContext(
  repositoryPath: string,
  trustedParentPath: string,
): RepositoryContext {
  const lexicalTrustedParentPath = resolve(trustedParentPath);
  const requestedRepositoryPath = resolve(repositoryPath);
  if (requestedRepositoryPath !== join(lexicalTrustedParentPath, "repository")) {
    throw new Error("unsafe local domain-rule repository");
  }
  const parentIdentity = assertPrivateDirectory(lexicalTrustedParentPath);
  const dedicatedRepositoryPath = join(parentIdentity.canonicalPath, "repository");
  let canonicalRequestedParentPath: string;
  try {
    canonicalRequestedParentPath = realpathSync(dirname(requestedRepositoryPath));
  } catch {
    throw new Error("unsafe local domain-rule repository");
  }
  if (canonicalRequestedParentPath !== parentIdentity.canonicalPath) {
    throw new Error("unsafe local domain-rule repository");
  }
  const repositoryIdentity = assertPrivateDirectory(requestedRepositoryPath);
  if (
    repositoryIdentity.canonicalPath !== dedicatedRepositoryPath ||
    dirname(repositoryIdentity.canonicalPath) !== parentIdentity.canonicalPath
  ) {
    throw new Error("unsafe local domain-rule repository");
  }
  assertStableDirectory(parentIdentity);
  return { parentIdentity, repositoryIdentity };
}

function repositoryLockPath(context: RepositoryContext): string {
  return join(
    context.parentIdentity.canonicalPath,
    `.${basename(context.repositoryIdentity.canonicalPath)}.submerge.lock`,
  );
}

function acquireRepositoryLock(context: RepositoryContext): RepositoryLock {
  assertStableDirectory(context.parentIdentity);
  assertStableDirectory(context.repositoryIdentity);
  const path = repositoryLockPath(context);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("local domain-rule repository is busy");
    }
    throw new Error("unsafe local domain-rule repository");
  }
  try {
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    assertPrivateFileStat(stat);
    fsyncDirectory(context.parentIdentity.canonicalPath);
    return {
      descriptor,
      dev: stat.dev,
      ino: stat.ino,
      parentIdentity: context.parentIdentity,
      path,
    };
  } catch (error) {
    closeSync(descriptor);
    removeFileIfPresent(path);
    throw error;
  }
}

function releaseRepositoryLock(lock: RepositoryLock): void {
  try {
    const stat = lstatSync(lock.path);
    assertPrivateFileStat(stat);
    if (stat.dev !== lock.dev || stat.ino !== lock.ino) {
      throw new Error("unsafe local domain-rule repository");
    }
    unlinkSync(lock.path);
    fsyncDirectory(lock.parentIdentity.canonicalPath);
  } finally {
    closeSync(lock.descriptor);
  }
}

async function withRepositoryLock<T>(
  context: RepositoryContext,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = acquireRepositoryLock(context);
  let retainLock = false;
  try {
    return await operation();
  } catch (error) {
    retainLock = shouldRetainRepositoryLock(error);
    throw error;
  } finally {
    if (retainLock) closeSync(lock.descriptor);
    else releaseRepositoryLock(lock);
  }
}

function shouldRetainRepositoryLock(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { [RETAIN_REPOSITORY_LOCK]?: true })[RETAIN_REPOSITORY_LOCK] === true
  );
}

function retainRepositoryLock(error: unknown): Error {
  const retainedError =
    error instanceof Error ? error : new Error("local domain-rule transaction failed");
  Object.defineProperty(retainedError, RETAIN_REPOSITORY_LOCK, { value: true });
  return retainedError;
}

function hitFailpoint(actual: string | undefined, expected: PublisherTestFailpoint): void {
  if (actual === expected) throw new Error("injected local publisher failure");
}

function hitRecoveryFailpoint(actual: string | undefined, expected: PublisherTestFailpoint): void {
  try {
    hitFailpoint(actual, expected);
  } catch (error) {
    throw retainRepositoryLock(error);
  }
}

function assertSafeGitMetadataLayout(
  gitPath: string,
  allowedRecoveryPaths: ReadonlySet<string> = new Set(),
): void {
  let entryCount = 0;
  const pendingDirectories = [gitPath];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (!directory) throw new Error("unsafe local Git configuration");
    const handle = opendirSync(directory);
    try {
      let entry = handle.readSync();
      while (entry !== null) {
        entryCount += 1;
        if (entryCount > MAX_GIT_METADATA_ENTRIES) {
          throw new Error("unsafe local Git configuration");
        }
        const path = join(directory, entry.name);
        if (
          (entry.name.endsWith(".lock") || entry.name.startsWith("submerge-index-")) &&
          !allowedRecoveryPaths.has(path)
        ) {
          throw new Error("unsafe local Git configuration");
        }
        const stat = lstatSync(path);
        if (
          stat.isSymbolicLink() ||
          (stat.mode & 0o022) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())
        ) {
          throw new Error("unsafe local Git configuration");
        }
        if (stat.isDirectory()) pendingDirectories.push(path);
        else if (!stat.isFile() || stat.nlink !== 1) {
          throw new Error("unsafe local Git configuration");
        }
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
  }

  const filePaths = [
    join(gitPath, "HEAD"),
    join(gitPath, "config"),
    join(gitPath, "index"),
    join(gitPath, "info", "exclude"),
  ];
  if (existsSync(join(gitPath, "packed-refs"))) filePaths.push(join(gitPath, "packed-refs"));
  for (const path of filePaths) {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("unsafe local Git configuration");
    }
  }

  const directoryPaths = [
    join(gitPath, "hooks"),
    join(gitPath, "info"),
    join(gitPath, "objects"),
    join(gitPath, "objects", "info"),
    join(gitPath, "objects", "pack"),
    join(gitPath, "refs"),
  ];
  if (existsSync(join(gitPath, "logs"))) directoryPaths.push(join(gitPath, "logs"));
  for (const path of directoryPaths) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("unsafe local Git configuration");
    }
  }
}

function assertPrivateOwnedTree(rootPath: string): void {
  const root = assertPrivateDirectory(rootPath);
  let entryCount = 0;
  const pendingDirectories = [root.canonicalPath];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (!directory) throw new Error("unsafe local domain-rule repository");
    const handle = opendirSync(directory);
    try {
      let entry = handle.readSync();
      while (entry !== null) {
        entryCount += 1;
        if (entryCount > MAX_GIT_METADATA_ENTRIES) {
          throw new Error("unsafe local domain-rule repository");
        }
        const path = join(directory, entry.name);
        const stat = lstatSync(path);
        if (
          stat.isSymbolicLink() ||
          (stat.mode & 0o022) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())
        ) {
          throw new Error("unsafe local domain-rule repository");
        }
        if (stat.isDirectory()) pendingDirectories.push(path);
        else if (!stat.isFile() || stat.nlink !== 1) {
          throw new Error("unsafe local domain-rule repository");
        }
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
  }
}

function readBoundedDirectoryNames(
  directoryPath: string,
  maximumEntries: number,
  errorMessage: string,
): string[] {
  const entries: string[] = [];
  const handle = opendirSync(directoryPath);
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      if (entries.length >= maximumEntries) throw new Error(errorMessage);
      entries.push(entry.name);
      entry = handle.readSync();
    }
  } finally {
    handle.closeSync();
  }
  return entries;
}

function assertExactDirectoryEntries(
  directoryPath: string,
  expectedEntries: readonly string[],
  errorMessage: string,
): void {
  const actualEntries = readBoundedDirectoryNames(
    directoryPath,
    expectedEntries.length + 1,
    errorMessage,
  ).sort();
  const sortedExpectedEntries = [...expectedEntries].sort();
  if (
    actualEntries.length !== sortedExpectedEntries.length ||
    actualEntries.some((entry, index) => entry !== sortedExpectedEntries[index])
  ) {
    throw new Error(errorMessage);
  }
}

function directoryHasEntry(directoryPath: string, predicate: (entry: string) => boolean): boolean {
  const handle = opendirSync(directoryPath);
  let entryCount = 0;
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      entryCount += 1;
      if (entryCount > MAX_GIT_METADATA_ENTRIES) {
        throw new Error("unsafe local Git configuration");
      }
      if (predicate(entry.name)) return true;
      entry = handle.readSync();
    }
    return false;
  } finally {
    handle.closeSync();
  }
}

function removeStagingDirectoryIfPresent(context: RepositoryContext, stagingPath: string): void {
  assertStableDirectory(context.parentIdentity);
  if (!existsSync(stagingPath)) return;
  if (dirname(stagingPath) !== context.parentIdentity.canonicalPath) {
    throw new Error("unsafe local domain-rule repository");
  }
  assertPrivateOwnedTree(stagingPath);
  rmSync(stagingPath, { recursive: true });
  fsyncDirectory(context.parentIdentity.canonicalPath);
  assertStableDirectory(context.parentIdentity);
}

function removeAttestedStagingDirectory(
  context: RepositoryContext,
  snapshot: BaselineStagingTreeSnapshot,
): void {
  const expectedPath = repositoryStagingPath(context);
  if (snapshot.rootIdentity.canonicalPath !== expectedPath) {
    throw new Error("unsafe local baseline staging state");
  }
  assertStableDirectory(context.parentIdentity);
  assertStableDirectory(context.repositoryIdentity);
  const currentSnapshot = scanBaselineStagingTree(expectedPath, true);
  if (
    currentSnapshot.rootIdentity.dev !== snapshot.rootIdentity.dev ||
    currentSnapshot.rootIdentity.ino !== snapshot.rootIdentity.ino ||
    currentSnapshot.entries.length !== snapshot.entries.length ||
    currentSnapshot.entries.some((entry, index) => {
      const expected = snapshot.entries[index];
      return (
        !expected ||
        entry.dev !== expected.dev ||
        entry.ino !== expected.ino ||
        entry.kind !== expected.kind ||
        entry.relativePath !== expected.relativePath ||
        entry.size !== expected.size
      );
    })
  ) {
    throw new Error("unsafe local baseline staging state");
  }
  rmSync(expectedPath, { recursive: true });
  fsyncDirectory(context.parentIdentity.canonicalPath);
  assertStableDirectory(context.parentIdentity);
  assertStableDirectory(context.repositoryIdentity);
}

function repositoryStagingPath(context: RepositoryContext): string {
  return join(
    context.parentIdentity.canonicalPath,
    `.${basename(context.repositoryIdentity.canonicalPath)}.submerge-init`,
  );
}

function hardenBaselineStagingGitTree(gitPath: string): void {
  mkdirSync(join(gitPath, "hooks"), { mode: 0o700 });
  mkdirSync(join(gitPath, "info"), { mode: 0o700 });
  createPrivateFile(join(gitPath, "info", "exclude"), "");
  chmodSync(gitPath, 0o700);
  for (const relativePath of BASELINE_STAGING_GIT_DIRECTORIES) {
    chmodSync(join(gitPath, relativePath), 0o700);
  }
  for (const relativePath of BASELINE_STAGING_GIT_FILES) {
    chmodSync(join(gitPath, relativePath), 0o600);
    fsyncRegularFile(join(gitPath, relativePath));
  }
  for (const relativePath of [...BASELINE_STAGING_GIT_DIRECTORIES].reverse()) {
    fsyncDirectory(join(gitPath, relativePath));
  }
  fsyncDirectory(gitPath);
}

function readPrivateTextFile(path: string): string {
  const before = lstatSync(path);
  assertPrivateFileStat(before);
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor);
    assertPrivateFileStat(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("unsafe local domain-rule repository");
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  assertPrivateFileStat(after);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error("unsafe local domain-rule repository");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid domain-rule list encoding");
  }
}

function readBoundedSafeGitTextFile(path: string): string {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > MAX_CUSTOM_BYTES ||
    (before.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  ) {
    throw new Error("unsafe local Git configuration");
  }
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      opened.size !== before.size
    ) {
      throw new Error("unsafe local Git configuration");
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error("unsafe local Git configuration");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("unsafe local Git configuration");
  }
}

function createPrivateFile(path: string, content: string): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function fsyncRegularFile(path: string): void {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  ) {
    throw new Error("unsafe local Git configuration");
  }
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1
    ) {
      throw new Error("unsafe local Git configuration");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncLooseObject(gitPath: string, objectId: string): void {
  if (!COMMIT_SHA_PATTERN.test(objectId)) throw new Error("unexpected local Git state");
  const objectDirectory = join(gitPath, "objects", objectId.slice(0, 2));
  const objectPath = join(objectDirectory, objectId.slice(2));
  if (!existsSync(objectPath)) throw new Error("unexpected local Git state");
  fsyncRegularFile(objectPath);
  fsyncDirectory(objectDirectory);
}

async function fsyncCommitState(
  repositoryPath: string,
  gitPath: string,
  commit: string,
  signal?: AbortSignal,
): Promise<void> {
  const tree = (
    await runLocalGit(repositoryPath, ["rev-parse", "--verify", `${commit}^{tree}`], { signal })
  ).trim();
  const blob = (
    await runLocalGit(repositoryPath, ["rev-parse", "--verify", `${commit}:custom.txt`], {
      signal,
    })
  ).trim();
  for (const objectId of [blob, tree, commit]) fsyncLooseObject(gitPath, objectId);
  for (const path of [
    join(gitPath, "HEAD"),
    join(gitPath, "config"),
    join(gitPath, "index"),
    join(gitPath, "info", "exclude"),
    join(gitPath, "refs", "heads", "main"),
  ]) {
    fsyncRegularFile(path);
  }
  for (const path of [
    join(gitPath, "info"),
    join(gitPath, "objects"),
    join(gitPath, "refs", "heads"),
    join(gitPath, "refs"),
    gitPath,
  ]) {
    fsyncDirectory(path);
  }
}

function scanBaselineStagingTree(
  stagingPath: string,
  requirePrivateModes: boolean,
): BaselineStagingTreeSnapshot {
  const rootIdentity = assertPrivateDirectory(stagingPath);
  let entryCount = 0;
  let totalBytes = 0;
  const entries: BaselineStagingTreeEntry[] = [];
  const pendingDirectories = [{ depth: 0, path: rootIdentity.canonicalPath, relativePath: "" }];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (!directory) throw new Error("unsafe local baseline staging state");
    const handle = opendirSync(directory.path);
    try {
      let entry = handle.readSync();
      while (entry !== null) {
        entryCount += 1;
        if (entryCount > MAX_GIT_METADATA_ENTRIES) {
          throw new Error("unsafe local baseline staging state");
        }
        const path = join(directory.path, entry.name);
        const relativePath = directory.relativePath
          ? join(directory.relativePath, entry.name)
          : entry.name;
        const stat = lstatSync(path);
        if (
          stat.isSymbolicLink() ||
          stat.dev !== rootIdentity.dev ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())
        ) {
          throw new Error("unsafe local baseline staging state");
        }
        if (stat.isDirectory()) {
          if (
            directory.depth >= MAX_BASELINE_STAGING_DEPTH ||
            (requirePrivateModes ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)
          ) {
            throw new Error("unsafe local baseline staging state");
          }
          entries.push({
            dev: stat.dev,
            ino: stat.ino,
            kind: "directory",
            relativePath,
            size: 0,
          });
          pendingDirectories.push({
            depth: directory.depth + 1,
            path,
            relativePath,
          });
        } else if (stat.isFile()) {
          if (
            stat.nlink !== 1 ||
            stat.size > MAX_BASELINE_STAGING_FILE_BYTES ||
            (requirePrivateModes ? (stat.mode & 0o777) !== 0o600 : (stat.mode & 0o022) !== 0)
          ) {
            throw new Error("unsafe local baseline staging state");
          }
          totalBytes += stat.size;
          if (totalBytes > MAX_BASELINE_STAGING_TOTAL_BYTES) {
            throw new Error("unsafe local baseline staging state");
          }
          entries.push({
            dev: stat.dev,
            ino: stat.ino,
            kind: "file",
            relativePath,
            size: stat.size,
          });
        } else {
          throw new Error("unsafe local baseline staging state");
        }
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  assertStableDirectory(rootIdentity);
  return { entries, rootIdentity };
}

function hardenBaselineStagingTree(stagingPath: string): void {
  const snapshot = scanBaselineStagingTree(stagingPath, false);
  for (const entry of [...snapshot.entries].reverse()) {
    chmodSync(
      join(snapshot.rootIdentity.canonicalPath, entry.relativePath),
      entry.kind === "directory" ? 0o700 : 0o600,
    );
  }
  const hardened = scanBaselineStagingTree(stagingPath, true);
  for (const entry of hardened.entries) {
    if (entry.kind === "file") {
      fsyncRegularFile(join(hardened.rootIdentity.canonicalPath, entry.relativePath));
    }
  }
  for (const entry of [...hardened.entries].reverse()) {
    if (entry.kind === "directory") {
      fsyncDirectory(join(hardened.rootIdentity.canonicalPath, entry.relativePath));
    }
  }
  fsyncDirectory(hardened.rootIdentity.canonicalPath);
}

function writePrivateFileAtomically(
  path: string,
  content: string,
  expectedSha256: string,
  afterRename?: (() => void) | undefined,
): void {
  if (sha256(readPrivateTextFile(path)) !== expectedSha256) {
    throw new Error("local domain-rule file changed concurrently");
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      0o600,
    );
    writeFileSync(fileDescriptor, content, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;
    if (sha256(readPrivateTextFile(path)) !== expectedSha256) {
      throw new Error("local domain-rule file changed concurrently");
    }
    renameSync(temporaryPath, path);
    afterRename?.();
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
    removeFileIfPresent(temporaryPath);
    throw error;
  }
}

async function readLocalConfig(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const keys = (
    await runLocalGit(repositoryPath, ["config", "--local", "--name-only", "--list", "-z"], {
      signal,
    })
  )
    .split("\0")
    .filter(Boolean);
  if (keys.length > MAX_LOCAL_CONFIG_ENTRIES) {
    throw new Error("unsafe local Git configuration");
  }
  const allowedKeys = new Set([...REQUIRED_LOCAL_CONFIG.keys(), ...OPTIONAL_BOOLEAN_LOCAL_CONFIG]);
  const normalizedKeys = keys.map((key) => key.toLowerCase());
  if (normalizedKeys.some((key) => !allowedKeys.has(key))) {
    throw new Error("unsafe local Git configuration");
  }
  const config = new Map<string, string[]>();
  for (const normalizedKey of new Set(normalizedKeys)) {
    const values = (
      await runLocalGit(repositoryPath, ["config", "--local", "-z", "--get-all", normalizedKey], {
        signal,
      })
    )
      .split("\0")
      .filter(Boolean);
    config.set(normalizedKey, values);
  }
  return config;
}

async function assertSafeLocalGitConfig(
  repositoryPath: string,
  gitPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const config = await readLocalConfig(repositoryPath, signal);
  for (const [key, values] of config) {
    const requiredValues = REQUIRED_LOCAL_CONFIG.get(key);
    if (requiredValues) {
      if (
        values.length !== requiredValues.length ||
        values.some((value) => value !== requiredValues[0])
      ) {
        throw new Error("unsafe local Git configuration");
      }
      continue;
    }
    if (
      !OPTIONAL_BOOLEAN_LOCAL_CONFIG.has(key) ||
      values.length !== 1 ||
      (values[0] !== "true" && values[0] !== "false")
    ) {
      throw new Error("unsafe local Git configuration");
    }
  }
  for (const key of REQUIRED_LOCAL_CONFIG.keys()) {
    if (!config.has(key)) throw new Error("unsafe local Git configuration");
  }

  const forbiddenPaths = [
    join(repositoryPath, ".gitattributes"),
    join(repositoryPath, ".gitmodules"),
    join(gitPath, "config.worktree"),
    join(gitPath, "commondir"),
    join(gitPath, "info", "attributes"),
    join(gitPath, "info", "grafts"),
    join(gitPath, "objects", "info", "alternates"),
    join(gitPath, "objects", "info", "http-alternates"),
    join(gitPath, "shallow"),
    join(gitPath, "worktrees"),
  ];
  if (forbiddenPaths.some(existsSync)) throw new Error("unsafe local Git configuration");

  const hooksPath = join(gitPath, "hooks");
  if (
    directoryHasEntry(hooksPath, (entry) => {
      const stat = lstatSync(join(hooksPath, entry));
      return !entry.endsWith(".sample") || !stat.isFile() || stat.isSymbolicLink();
    })
  ) {
    throw new Error("unsafe local Git configuration");
  }
  if (readBoundedSafeGitTextFile(join(gitPath, "info", "exclude")) !== "") {
    throw new Error("unsafe local Git configuration");
  }

  const packPath = join(gitPath, "objects", "pack");
  if (existsSync(packPath) && directoryHasEntry(packPath, (entry) => entry.endsWith(".promisor"))) {
    throw new Error("unsafe local Git configuration");
  }
  if (
    (
      await runLocalGit(repositoryPath, ["for-each-ref", "--format=%(refname)", "refs/replace"], {
        signal,
      })
    ).trim() !== ""
  ) {
    throw new Error("unsafe local Git configuration");
  }
  const refs = (
    await runLocalGit(repositoryPath, ["for-each-ref", "--format=%(refname)"], { signal })
  )
    .trim()
    .split("\n");
  if (refs.length !== 1 || refs[0] !== "refs/heads/main") {
    throw new Error("unsafe local Git configuration");
  }
  if ((await runLocalGit(repositoryPath, ["remote"], { signal })).trim() !== "") {
    throw new Error("unsafe local Git configuration");
  }
}

async function attestInterruptedBaselineStaging(
  context: RepositoryContext,
  stagingPath: string,
  signal?: AbortSignal,
): Promise<{ seededContent: string; stagingSnapshot: BaselineStagingTreeSnapshot }> {
  try {
    assertNotAborted(signal);
    assertStableDirectory(context.parentIdentity);
    assertStableDirectory(context.repositoryIdentity);
    if (stagingPath !== repositoryStagingPath(context)) {
      throw new Error("unsafe local baseline staging state");
    }

    const repositoryPath = context.repositoryIdentity.canonicalPath;
    assertExactDirectoryEntries(repositoryPath, ["custom.txt"], "unexpected local Git state");
    const seededContent = readPrivateTextFile(join(repositoryPath, "custom.txt"));
    validateCompleteRuleList(seededContent);

    const stagingIdentity = assertPrivateDirectory(stagingPath);
    if (stagingIdentity.canonicalPath !== stagingPath) {
      throw new Error("unsafe local baseline staging state");
    }
    assertExactDirectoryEntries(
      stagingIdentity.canonicalPath,
      [".git", "custom.txt"],
      "unsafe local baseline staging state",
    );
    const stagedContent = readPrivateTextFile(join(stagingIdentity.canonicalPath, "custom.txt"));
    if (stagedContent !== seededContent) {
      throw new Error("unsafe local baseline staging state");
    }
    assertPrivateDirectory(join(stagingIdentity.canonicalPath, ".git"));
    const stagingSnapshot = scanBaselineStagingTree(stagingIdentity.canonicalPath, true);
    assertStableDirectory(context.parentIdentity);
    assertStableDirectory(context.repositoryIdentity);
    assertStableDirectory(stagingIdentity);
    return { seededContent, stagingSnapshot };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("unsafe local baseline staging state");
  }
}

function parseCommitMetadataRecords(value: string): Map<string, string[]> {
  const records = new Map<string, string[]>();
  for (const rawRecord of value.split("\x1e")) {
    const record = rawRecord.replace(/^\n+/u, "");
    if (record === "") continue;
    const fields = record.split("\x1f");
    const commit = fields[0];
    if (!commit || fields.length !== 6 || records.has(commit)) {
      throw new Error("unexpected local Git state");
    }
    records.set(commit, fields.slice(1));
  }
  return records;
}

function parseRawCommitRecords(value: string): Map<string, string[]> {
  const records = new Map<string, string[]>();
  for (const rawRecord of value.split("\x1e")) {
    const lines = rawRecord
      .trim()
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const commit = lines[0];
    if (!commit || records.has(commit)) throw new Error("unexpected local Git state");
    records.set(commit, lines.slice(1));
  }
  return records;
}

async function assertAttestedHistory(
  repositoryPath: string,
  head: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const commitsWithParents = (
    await runLocalGit(repositoryPath, ["rev-list", "--reverse", "--parents", head], { signal })
  )
    .trim()
    .split("\n")
    .map((line) => line.split(" "));
  if (commitsWithParents.length === 0 || commitsWithParents.length > MAX_HISTORY_COMMITS) {
    throw new Error("unexpected local Git state");
  }

  const metadata = parseCommitMetadataRecords(
    await runLocalGit(
      repositoryPath,
      ["log", "--reverse", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e", head],
      { signal },
    ),
  );
  const rawChanges = parseRawCommitRecords(
    await runLocalGit(
      repositoryPath,
      ["log", "--reverse", "--format=%x1e%H", "--raw", "--no-abbrev", "--no-renames", head],
      { signal },
    ),
  );
  const operationIds = new Set<string>();

  for (const [index, commitWithParents] of commitsWithParents.entries()) {
    const [commit, ...parents] = commitWithParents;
    if (
      !commit ||
      (index === 0
        ? parents.length !== 0
        : parents.length !== 1 || parents[0] !== commitsWithParents[index - 1]?.[0])
    ) {
      throw new Error("unexpected local Git state");
    }
    const fields = metadata.get(commit);
    const changedLines = rawChanges.get(commit);
    if (!fields || !changedLines || changedLines.length !== 1) {
      throw new Error("unexpected local Git state");
    }
    const [authorName, authorEmail, committerName, committerEmail, rawBody] = fields;
    const body = rawBody?.trimEnd();
    const operationMatch = body?.match(
      /^Update managed domain rules\n\nSubmerge-Operation-Id: ([a-zA-Z0-9._-]{1,128})$/u,
    );
    if (
      authorName !== "Submerge" ||
      authorEmail !== "submerge@localhost" ||
      committerName !== "Submerge" ||
      committerEmail !== "submerge@localhost" ||
      (index === 0 ? body !== "Initialize local domain rules" : !operationMatch) ||
      !/^:[0-7]{6} 100644 [0-9a-f]{40} [0-9a-f]{40} [A-Z]\tcustom\.txt$/u.test(
        changedLines[0] ?? "",
      )
    ) {
      throw new Error("unexpected local Git state");
    }
    if (operationMatch) {
      const operationId = operationMatch[1];
      if (!operationId || operationIds.has(operationId)) {
        throw new Error("unexpected local Git state");
      }
      operationIds.add(operationId);
    }
  }
  return [...operationIds];
}

async function assertCommit(
  repositoryPath: string,
  commit: string,
  expectedParent: string,
  operationId: string,
  expectedContent: string,
  signal?: AbortSignal,
): Promise<string> {
  const parent = (
    await runLocalGit(repositoryPath, ["rev-parse", "--verify", `${commit}^`], { signal })
  ).trim();
  const metadata = await runLocalGit(
    repositoryPath,
    ["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", commit],
    { signal },
  );
  const [authorName, authorEmail, committerName, committerEmail, ...bodyLines] =
    metadata.split("\n");
  const body = bodyLines.join("\n").trimEnd();
  const changedPaths = (
    await runLocalGit(
      repositoryPath,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", commit],
      { signal },
    )
  )
    .trim()
    .split("\n");
  const treeEntry = (
    await runLocalGit(repositoryPath, ["ls-tree", commit, "--", "custom.txt"], { signal })
  )
    .trim()
    .split(/\s+/u);
  const committedContent = await runLocalGit(repositoryPath, ["show", `${commit}:custom.txt`], {
    signal,
  });
  if (
    parent !== expectedParent ||
    authorName !== "Submerge" ||
    authorEmail !== "submerge@localhost" ||
    committerName !== "Submerge" ||
    committerEmail !== "submerge@localhost" ||
    body !== `Update managed domain rules\n\nSubmerge-Operation-Id: ${operationId}` ||
    changedPaths.length !== 1 ||
    changedPaths[0] !== "custom.txt" ||
    treeEntry[0] !== "100644" ||
    !treeEntry[2] ||
    !COMMIT_SHA_PATTERN.test(treeEntry[2]) ||
    committedContent !== expectedContent
  ) {
    throw new Error("local domain-rule commit attestation failed");
  }
  return treeEntry[2];
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

async function validateExistingLocalRuleRepository(
  context: RepositoryContext,
  signal: AbortSignal | undefined,
  baselineCreated: boolean,
  allowedGitRecoveryPaths: ReadonlySet<string> = new Set(),
  allowRecoverableDirtyState: boolean = false,
  allowedRootRecoveryPaths: ReadonlySet<string> = new Set(),
): Promise<AttestedLocalRuleRepositoryState> {
  const canonicalRepositoryPath = context.repositoryIdentity.canonicalPath;
  const customPath = join(canonicalRepositoryPath, "custom.txt");
  const gitPath = join(canonicalRepositoryPath, ".git");
  assertNotAborted(signal);
  assertStableDirectory(context.parentIdentity);
  assertStableDirectory(context.repositoryIdentity);
  if (!existsSync(customPath) || !existsSync(gitPath))
    throw new Error("unexpected local Git state");
  const gitIdentity = assertPrivateDirectory(gitPath);
  assertSafeGitMetadataLayout(gitIdentity.canonicalPath, allowedGitRecoveryPaths);
  await assertSafeLocalGitConfig(canonicalRepositoryPath, gitIdentity.canonicalPath, signal);
  const rootEntries = readBoundedDirectoryNames(
    canonicalRepositoryPath,
    allowedRootRecoveryPaths.size + 3,
    "unexpected local Git state",
  ).sort();
  const allowedRootEntries = [
    ".git",
    "custom.txt",
    ...[...allowedRootRecoveryPaths].map((path) => {
      if (dirname(path) !== canonicalRepositoryPath) {
        throw new Error("unexpected local Git state");
      }
      return basename(path);
    }),
  ].sort();
  if (
    rootEntries.length !== allowedRootEntries.length ||
    rootEntries.some((entry, index) => entry !== allowedRootEntries[index])
  ) {
    throw new Error("unexpected local Git state");
  }
  const topLevel = (
    await runLocalGit(canonicalRepositoryPath, ["rev-parse", "--show-toplevel"], { signal })
  ).trim();
  const absoluteGitPath = (
    await runLocalGit(canonicalRepositoryPath, ["rev-parse", "--absolute-git-dir"], { signal })
  ).trim();
  if (
    realpathSync(topLevel) !== canonicalRepositoryPath ||
    realpathSync(absoluteGitPath) !== gitIdentity.canonicalPath ||
    (
      await runLocalGit(canonicalRepositoryPath, ["branch", "--show-current"], { signal })
    ).trim() !== "main"
  ) {
    throw new Error("unexpected local Git state");
  }
  const status = await runLocalGit(
    canonicalRepositoryPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { signal },
  );
  if (!allowRecoverableDirtyState) {
    const expectedRecoveryStatus = [...allowedRootRecoveryPaths]
      .map((path) => `?? ${basename(path)}\n`)
      .sort()
      .join("");
    if (status !== expectedRecoveryStatus) throw new Error("unexpected local Git state");
  }

  const head = (
    await runLocalGit(canonicalRepositoryPath, ["rev-parse", "--verify", "HEAD"], { signal })
  ).trim();
  const trackedPaths = (
    await runLocalGit(canonicalRepositoryPath, ["ls-tree", "-r", "--name-only", head], {
      signal,
    })
  )
    .trim()
    .split("\n");
  if (trackedPaths.length !== 1 || trackedPaths[0] !== "custom.txt") {
    throw new Error("unexpected local Git state");
  }
  const operationIds = await assertAttestedHistory(canonicalRepositoryPath, head, signal);
  const committedContent = await runLocalGit(canonicalRepositoryPath, ["show", "HEAD:custom.txt"], {
    signal,
  });
  const worktreeContent = readPrivateTextFile(customPath);
  if (!allowRecoverableDirtyState && committedContent !== worktreeContent) {
    throw new Error("unexpected local Git state");
  }
  validateCompleteRuleList(committedContent);
  validateCompleteRuleList(worktreeContent);
  assertSafeGitMetadataLayout(gitIdentity.canonicalPath, allowedGitRecoveryPaths);
  assertStableDirectory(context.parentIdentity);
  assertStableDirectory(context.repositoryIdentity);
  assertStableDirectory(gitIdentity);
  return {
    baselineCreated,
    content: committedContent,
    contentSha256: sha256(committedContent),
    head,
    operationIds,
  };
}

async function initializeBaselineRepository(
  context: RepositoryContext,
  seededContent: string,
  options: LocalRuleRepositoryOptions,
): Promise<void> {
  const canonicalRepositoryPath = context.repositoryIdentity.canonicalPath;
  const stagingPath = repositoryStagingPath(context);
  mkdirSync(stagingPath, { mode: 0o700 });
  chmodSync(stagingPath, 0o700);
  fsyncDirectory(context.parentIdentity.canonicalPath);
  let cleanupStaging = true;
  try {
    createPrivateFile(join(stagingPath, "custom.txt"), seededContent);
    await runLocalGit(stagingPath, ["init", "--initial-branch=main", "--template="], {
      signal: options.signal,
    });
    const stagingGitPath = join(stagingPath, ".git");
    hardenBaselineStagingGitTree(stagingGitPath);
    fsyncDirectory(stagingPath);
    fsyncDirectory(context.parentIdentity.canonicalPath);
    hitFailpoint(options.testFailpoint, "after-staging-init");
    for (const [key, value] of [
      ["core.autocrlf", "false"],
      ["core.fsync", "committed"],
      ["core.fsyncMethod", "fsync"],
    ] as const) {
      await runLocalGit(stagingPath, ["config", "--local", key, value], {
        signal: options.signal,
      });
    }
    fsyncRegularFile(join(stagingGitPath, "config"));
    fsyncDirectory(stagingGitPath);
    hitRecoveryFailpoint(options.testFailpoint, "after-baseline-config");
    await runLocalGit(stagingPath, ["add", "--", "custom.txt"], {
      signal: options.signal,
    });
    const stagedIndex = await runLocalGit(stagingPath, ["ls-files", "--stage"], {
      signal: options.signal,
    });
    const stagedMatch = stagedIndex.match(/^100644 ([0-9a-f]{40}) 0\tcustom\.txt\n$/u);
    const stagedBlob = stagedMatch?.[1];
    if (
      !stagedBlob ||
      (await runLocalGit(stagingPath, ["show", ":custom.txt"])) !== seededContent
    ) {
      throw new Error("unexpected local Git state");
    }
    chmodSync(join(stagingGitPath, "index"), 0o600);
    const stagedObjectDirectory = join(stagingGitPath, "objects", stagedBlob.slice(0, 2));
    chmodSync(stagedObjectDirectory, 0o700);
    chmodSync(join(stagedObjectDirectory, stagedBlob.slice(2)), 0o600);
    fsyncRegularFile(join(stagingGitPath, "index"));
    fsyncLooseObject(stagingGitPath, stagedBlob);
    fsyncDirectory(join(stagingGitPath, "objects"));
    fsyncDirectory(stagingGitPath);
    hitRecoveryFailpoint(options.testFailpoint, "after-baseline-index");
    await runLocalGit(
      stagingPath,
      ["commit", "--no-gpg-sign", "--no-verify", "-m", "Initialize local domain rules"],
      { signal: options.signal },
    );
    hardenBaselineStagingTree(stagingPath);
    const stagingContext: RepositoryContext = {
      parentIdentity: context.parentIdentity,
      repositoryIdentity: assertPrivateDirectory(stagingPath),
    };
    const stagedState = await validateExistingLocalRuleRepository(
      stagingContext,
      options.signal,
      true,
    );
    await fsyncCommitState(stagingPath, stagingGitPath, stagedState.head, options.signal);
    hardenBaselineStagingTree(stagingPath);
    hitRecoveryFailpoint(options.testFailpoint, "after-baseline-commit");
    assertStableDirectory(context.parentIdentity);
    assertStableDirectory(context.repositoryIdentity);
    if (existsSync(join(canonicalRepositoryPath, ".git"))) {
      throw new Error("unexpected local Git state");
    }
    renameSync(stagingGitPath, join(canonicalRepositoryPath, ".git"));
    options.testDurabilityTrace?.("baseline-git-renamed");
    fsyncDirectory(stagingPath);
    options.testDurabilityTrace?.("baseline-staging-fsynced");
    fsyncDirectory(canonicalRepositoryPath);
    options.testDurabilityTrace?.("baseline-repository-fsynced");
    fsyncDirectory(context.parentIdentity.canonicalPath);
    options.testDurabilityTrace?.("baseline-parent-fsynced");
    options.testDurabilityTrace?.("baseline-install-checkpoint");
    hitRecoveryFailpoint(options.testFailpoint, "after-baseline-install");
  } catch (error) {
    cleanupStaging = !shouldRetainRepositoryLock(error);
    throw error;
  } finally {
    if (cleanupStaging) removeStagingDirectoryIfPresent(context, stagingPath);
  }
}

async function provisionLocalRuleRepositoryUnlocked(
  context: RepositoryContext,
  options: LocalRuleRepositoryOptions,
): Promise<AttestedLocalRuleRepositoryState> {
  assertNotAborted(options.signal);
  const canonicalRepositoryPath = context.repositoryIdentity.canonicalPath;
  const customPath = join(canonicalRepositoryPath, "custom.txt");
  const gitPath = join(canonicalRepositoryPath, ".git");
  const stagingPath = repositoryStagingPath(context);
  const repositoryExists = existsSync(gitPath);
  const customExists = existsSync(customPath);

  if (existsSync(stagingPath)) throw new Error("unexpected local Git state");
  if (repositoryExists && !customExists) throw new Error("unexpected local Git state");
  if (repositoryExists) {
    return validateExistingLocalRuleRepository(context, options.signal, false);
  }
  const allowedEntries = customExists ? ["custom.txt"] : [];
  const entries = readBoundedDirectoryNames(
    canonicalRepositoryPath,
    allowedEntries.length + 1,
    "unexpected local Git state",
  ).sort();
  if (
    entries.length !== allowedEntries.length ||
    entries.some((entry, index) => entry !== allowedEntries[index])
  ) {
    throw new Error("unexpected local Git state");
  }
  if (!customExists) {
    assertNotAborted(options.signal);
    createPrivateFile(customPath, `${MANAGED_RULES_BEGIN}\n${MANAGED_RULES_END}\n`);
  }
  const seededContent = readPrivateTextFile(customPath);
  validateCompleteRuleList(seededContent);
  hitRecoveryFailpoint(options.testFailpoint, "after-seed-create");
  await initializeBaselineRepository(context, seededContent, options);

  return validateExistingLocalRuleRepository(context, options.signal, true);
}

export async function provisionLocalRuleRepository(
  repositoryPath: string,
  options: LocalRuleRepositoryOptions,
): Promise<LocalRuleRepositoryState> {
  assertNotAborted(options.signal);
  assertTrustedGitBinary();
  const context = resolveRepositoryContext(repositoryPath, options.trustedParentPath);
  return withRepositoryLock(context, async () => {
    const { content: _content, ...state } = await provisionLocalRuleRepositoryUnlocked(
      context,
      options,
    );
    return state;
  });
}

export async function provisionLocalDomainRuleStore(
  input: ProvisionLocalDomainRuleStoreInput,
): Promise<ProvisionedLocalDomainRuleStore> {
  assertNotAborted(input.signal);
  assertTrustedGitBinary();
  const context = resolveRepositoryContext(input.repositoryPath, input.trustedParentPath);
  return withRepositoryLock(context, async () => {
    const attested = await provisionLocalRuleRepositoryUnlocked(context, input);
    const materialization = reconcileInitialDomainRuleMaterialization({
      content: attested.content,
      contentSha256: attested.contentSha256,
      mihomoConfigPath: input.mihomoConfigPath,
      testBeforeDirectoryCreate: input.testBeforeMaterializationDirectoryCreate,
      testBeforeExistingRead: input.testBeforeMaterializationExistingRead,
      testBeforePublish: input.testBeforeMaterializationPublish,
    });
    const reattested = await validateExistingLocalRuleRepository(
      context,
      input.signal,
      attested.baselineCreated,
    );
    if (
      reattested.head !== attested.head ||
      reattested.contentSha256 !== attested.contentSha256 ||
      reattested.content !== attested.content
    ) {
      throw new Error("local domain-rule repository changed during materialization");
    }
    const { content: _content, ...repository } = reattested;
    return { materialization, repository };
  });
}

export async function materializeCommittedLocalDomainRuleStore(
  input: MaterializeCommittedLocalDomainRuleStoreInput,
): Promise<ProvisionedLocalDomainRuleStore> {
  assertNotAborted(input.signal);
  assertTrustedGitBinary();
  if (
    !OPERATION_ID_PATTERN.test(input.operationId) ||
    !COMMIT_SHA_PATTERN.test(input.expectedParent) ||
    !COMMIT_SHA_PATTERN.test(input.commitSha) ||
    !/^[0-9a-f]{64}$/u.test(input.committedContentSha256) ||
    input.commitSha === input.expectedParent
  ) {
    throw new Error("invalid committed domain-rule materialization input");
  }
  const context = resolveRepositoryContext(input.repositoryPath, input.trustedParentPath);
  return withRepositoryLock(context, async () => {
    const attested = await validateExistingLocalRuleRepository(context, input.signal, false);
    if (
      attested.head !== input.commitSha ||
      attested.contentSha256 !== input.committedContentSha256
    ) {
      throw new Error("unexpected local Git state");
    }
    await assertCommit(
      context.repositoryIdentity.canonicalPath,
      input.commitSha,
      input.expectedParent,
      input.operationId,
      attested.content,
      input.signal,
    );
    const previousContent = await runLocalGit(
      context.repositoryIdentity.canonicalPath,
      ["show", `${input.expectedParent}:custom.txt`],
      { signal: input.signal },
    );
    validateCompleteRuleList(previousContent);
    assertNotAborted(input.signal);
    const materialization = materializeCommittedDomainRules({
      content: attested.content,
      contentSha256: attested.contentSha256,
      expectedPreviousContentSha256: sha256(previousContent),
      mihomoConfigPath: input.mihomoConfigPath,
      testBeforePublish: input.testBeforeMaterializationPublish,
    });
    assertNotAborted(input.signal);
    const reattested = await validateExistingLocalRuleRepository(
      context,
      input.signal,
      attested.baselineCreated,
    );
    if (
      reattested.head !== attested.head ||
      reattested.contentSha256 !== attested.contentSha256 ||
      reattested.content !== attested.content
    ) {
      throw new Error("local domain-rule repository changed during materialization");
    }
    const { content: _content, ...repository } = reattested;
    return { materialization, repository };
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw new Error("unsafe local domain-rule repository lock");
  }
}

function readLockOwnerPid(lockPath: string): { identity: PrivateFileIdentity; pid: number } {
  const stat = lstatSync(lockPath);
  assertPrivateFileStat(stat);
  const content = readPrivateTextFile(lockPath);
  if (!/^[1-9][0-9]{0,9}\n$/u.test(content)) {
    throw new Error("unsafe local domain-rule repository lock");
  }
  const pid = Number.parseInt(content, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("unsafe local domain-rule repository lock");
  }
  return { identity: { dev: stat.dev, ino: stat.ino, path: lockPath }, pid };
}

function recoverableGitLocks(gitPath: string): PrivateFileIdentity[] {
  const locks: PrivateFileIdentity[] = [];
  for (const relativePath of RECOVERABLE_GIT_LOCK_PATHS) {
    const path = join(gitPath, relativePath);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    assertSafeGitLockFileStat(stat);
    locks.push({ dev: stat.dev, ino: stat.ino, path });
  }
  return locks;
}

function recoverableTemporaryIndexes(gitPath: string): PrivateFileIdentity[] {
  const indexes: PrivateFileIdentity[] = [];
  const handle = opendirSync(gitPath);
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      if (entry.name.startsWith("submerge-index-")) {
        if (!TEMPORARY_INDEX_PATTERN.test(entry.name) || indexes.length >= MAX_RECOVERY_ARTIFACTS) {
          throw new Error("unsafe local Git recovery artifact");
        }
        const path = join(gitPath, entry.name);
        const stat = lstatSync(path);
        assertSafeGitLockFileStat(stat);
        indexes.push({ dev: stat.dev, ino: stat.ino, path });
      }
      entry = handle.readSync();
    }
  } finally {
    handle.closeSync();
  }
  return indexes;
}

function recoverableTemporaryRuleFiles(repositoryPath: string): PrivateFileIdentity[] {
  const files: PrivateFileIdentity[] = [];
  const handle = opendirSync(repositoryPath);
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      if (entry.name.startsWith("custom.txt.")) {
        if (
          !TEMPORARY_RULE_FILE_PATTERN.test(entry.name) ||
          files.length >= MAX_RECOVERY_ARTIFACTS
        ) {
          throw new Error("unsafe local domain-rule recovery artifact");
        }
        const path = join(repositoryPath, entry.name);
        const stat = lstatSync(path);
        assertPrivateFileStat(stat);
        files.push({ dev: stat.dev, ino: stat.ino, path });
      }
      entry = handle.readSync();
    }
  } finally {
    handle.closeSync();
  }
  return files;
}

function unlinkStablePrivateFile(identity: PrivateFileIdentity): void {
  const stat = lstatSync(identity.path);
  assertPrivateFileStat(stat);
  if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw new Error("unsafe local domain-rule repository lock");
  }
  unlinkSync(identity.path);
  fsyncDirectory(dirname(identity.path));
}

function unlinkStableGitRecoveryArtifact(identity: PrivateFileIdentity): void {
  const stat = lstatSync(identity.path);
  assertSafeGitLockFileStat(stat);
  if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw new Error("unsafe local Git recovery artifact");
  }
  unlinkSync(identity.path);
  fsyncDirectory(dirname(identity.path));
}

function unlinkStablePrivateRecoveryArtifact(identity: PrivateFileIdentity): void {
  const stat = lstatSync(identity.path);
  assertPrivateFileStat(stat);
  if (stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw new Error("unsafe local domain-rule recovery artifact");
  }
  unlinkSync(identity.path);
  fsyncDirectory(dirname(identity.path));
}

async function readAttestedIndexContent(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const staged = await runLocalGit(repositoryPath, ["ls-files", "--stage"], { signal });
  if (!/^100644 [0-9a-f]{40} 0\tcustom\.txt\n$/u.test(staged)) {
    throw new Error("unexpected local Git state");
  }
  const content = await runLocalGit(repositoryPath, ["show", ":custom.txt"], { signal });
  validateCompleteRuleList(content);
  return content;
}

async function rebuildIndexFromHead(
  repositoryPath: string,
  gitPath: string,
  head: string,
  signal?: AbortSignal,
): Promise<void> {
  const temporaryIndexPath = join(gitPath, `submerge-index-${process.pid}-${randomUUID()}`);
  try {
    await runLocalGit(repositoryPath, ["read-tree", head], {
      indexPath: temporaryIndexPath,
      signal,
    });
    fsyncRegularFile(temporaryIndexPath);
    renameSync(temporaryIndexPath, join(gitPath, "index"));
    fsyncDirectory(gitPath);
  } finally {
    removeFileIfPresent(temporaryIndexPath);
    removeFileIfPresent(`${temporaryIndexPath}.lock`);
  }
}

export async function recoverStaleLocalRuleRepositoryLock(
  repositoryPath: string,
  options: LocalRuleRepositoryRecoveryOptions,
): Promise<boolean> {
  assertNotAborted(options.signal);
  assertTrustedGitBinary();
  const context = resolveRepositoryContext(repositoryPath, options.trustedParentPath);
  const lockPath = repositoryLockPath(context);
  const isAlive = options.operatorConfirmedStopped
    ? () => false
    : (options.testProcessAlive ?? processIsAlive);
  const staleLock = existsSync(lockPath) ? readLockOwnerPid(lockPath) : null;
  if (staleLock && isAlive(staleLock.pid)) {
    throw new Error("local domain-rule repository is busy");
  }
  const recoveryLock = staleLock ? null : acquireRepositoryLock(context);
  try {
    const canonicalRepositoryPath = context.repositoryIdentity.canonicalPath;
    const customPath = join(canonicalRepositoryPath, "custom.txt");
    const gitPath = join(canonicalRepositoryPath, ".git");
    const stagingPath = repositoryStagingPath(context);
    const gitExists = existsSync(gitPath);
    const stagingExists = existsSync(stagingPath);
    if (!gitExists) {
      if (!staleLock && !stagingExists) return false;
      if (!staleLock) throw new Error("unsafe local baseline staging state");
      if (!stagingExists) {
        assertExactDirectoryEntries(
          canonicalRepositoryPath,
          ["custom.txt"],
          "unsafe local baseline staging state",
        );
        const seededContent = readPrivateTextFile(customPath);
        validateCompleteRuleList(seededContent);
        if (isAlive(staleLock.pid)) throw new Error("local domain-rule repository is busy");
        if (readPrivateTextFile(customPath) !== seededContent) {
          throw new Error("unsafe local baseline staging state");
        }
        unlinkStablePrivateFile(staleLock.identity);
        assertStableDirectory(context.parentIdentity);
        assertStableDirectory(context.repositoryIdentity);
        return true;
      }
      const stagedState = await attestInterruptedBaselineStaging(
        context,
        stagingPath,
        options.signal,
      );
      if (isAlive(staleLock.pid)) throw new Error("local domain-rule repository is busy");
      if (readPrivateTextFile(customPath) !== stagedState.seededContent) {
        throw new Error("unsafe local baseline staging state");
      }
      removeAttestedStagingDirectory(context, stagedState.stagingSnapshot);
      assertExactDirectoryEntries(
        canonicalRepositoryPath,
        ["custom.txt"],
        "unsafe local baseline staging state",
      );
      if (readPrivateTextFile(customPath) !== stagedState.seededContent) {
        throw new Error("unsafe local baseline staging state");
      }
      unlinkStablePrivateFile(staleLock.identity);
      assertStableDirectory(context.parentIdentity);
      assertStableDirectory(context.repositoryIdentity);
      return true;
    }
    if (stagingExists) {
      if (!staleLock) throw new Error("unsafe local baseline staging state");
      const finalState = await validateExistingLocalRuleRepository(context, options.signal, false);
      const stagingIdentity = assertPrivateDirectory(stagingPath);
      if (stagingIdentity.canonicalPath !== stagingPath) {
        throw new Error("unsafe local baseline staging state");
      }
      assertExactDirectoryEntries(
        stagingIdentity.canonicalPath,
        ["custom.txt"],
        "unsafe local baseline staging state",
      );
      const stagingContent = readPrivateTextFile(join(stagingIdentity.canonicalPath, "custom.txt"));
      const committedContent = await runLocalGit(
        canonicalRepositoryPath,
        ["show", "HEAD:custom.txt"],
        { signal: options.signal },
      );
      if (
        stagingContent !== committedContent ||
        finalState.contentSha256 !== sha256(committedContent)
      ) {
        throw new Error("unsafe local baseline staging state");
      }
      const stagingSnapshot = scanBaselineStagingTree(stagingIdentity.canonicalPath, true);
      if (isAlive(staleLock.pid)) throw new Error("local domain-rule repository is busy");
      removeAttestedStagingDirectory(context, stagingSnapshot);
      const revalidatedState = await validateExistingLocalRuleRepository(
        context,
        options.signal,
        false,
      );
      if (
        revalidatedState.head !== finalState.head ||
        revalidatedState.contentSha256 !== finalState.contentSha256
      ) {
        throw new Error("unsafe local baseline staging state");
      }
      unlinkStablePrivateFile(staleLock.identity);
      assertStableDirectory(context.parentIdentity);
      assertStableDirectory(context.repositoryIdentity);
      return true;
    }
    const gitLocks = recoverableGitLocks(gitPath);
    const temporaryIndexes = recoverableTemporaryIndexes(gitPath);
    const temporaryRuleFiles = recoverableTemporaryRuleFiles(canonicalRepositoryPath);
    const gitRecoveryArtifacts = [...gitLocks, ...temporaryIndexes];
    const hasRecoveryArtifacts = gitRecoveryArtifacts.length > 0 || temporaryRuleFiles.length > 0;
    if (!staleLock && !hasRecoveryArtifacts) {
      await validateExistingLocalRuleRepository(context, options.signal, false);
      return false;
    }

    const allowedGitRecoveryPaths = new Set(gitRecoveryArtifacts.map((entry) => entry.path));
    const allowedRootRecoveryPaths = new Set(temporaryRuleFiles.map((entry) => entry.path));
    const state = await validateExistingLocalRuleRepository(
      context,
      options.signal,
      false,
      allowedGitRecoveryPaths,
      true,
      allowedRootRecoveryPaths,
    );
    if (staleLock && isAlive(staleLock.pid)) {
      throw new Error("local domain-rule repository is busy");
    }

    const committedContent = await runLocalGit(
      canonicalRepositoryPath,
      ["show", "HEAD:custom.txt"],
      { signal: options.signal },
    );
    const worktreeContent = readPrivateTextFile(customPath);
    const indexContent = await readAttestedIndexContent(canonicalRepositoryPath, options.signal);
    validateCompleteRuleList(committedContent);
    if (
      worktreeContent !== committedContent &&
      indexContent !== committedContent &&
      worktreeContent !== indexContent
    ) {
      throw new Error("unexpected local Git state");
    }

    if (worktreeContent !== committedContent) {
      writePrivateFileAtomically(customPath, committedContent, sha256(worktreeContent));
    }
    if (indexContent !== committedContent) {
      await rebuildIndexFromHead(canonicalRepositoryPath, gitPath, state.head, options.signal);
    }
    await fsyncCommitState(canonicalRepositoryPath, gitPath, state.head, options.signal);

    options.testAfterRecoveryRepair?.();
    await validateExistingLocalRuleRepository(
      context,
      options.signal,
      false,
      allowedGitRecoveryPaths,
      false,
      allowedRootRecoveryPaths,
    );

    for (const artifact of gitRecoveryArtifacts) unlinkStableGitRecoveryArtifact(artifact);
    for (const artifact of temporaryRuleFiles) unlinkStablePrivateRecoveryArtifact(artifact);
    await validateExistingLocalRuleRepository(context, options.signal, false);
    if (staleLock) unlinkStablePrivateFile(staleLock.identity);
    assertStableDirectory(context.parentIdentity);
    assertStableDirectory(context.repositoryIdentity);
    return true;
  } finally {
    if (recoveryLock) releaseRepositoryLock(recoveryLock);
  }
}

async function commitManagedDomainRulesUnlocked(
  input: CommitManagedDomainRulesInput,
  context: RepositoryContext,
): Promise<CommittedDomainRules> {
  if (!OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new Error("invalid domain-rule operation ID");
  }
  if (!COMMIT_SHA_PATTERN.test(input.expectedParent)) {
    throw new Error("unexpected local Git state");
  }
  assertNotAborted(input.signal);
  const state = await provisionLocalRuleRepositoryUnlocked(context, {
    signal: input.signal,
    trustedParentPath: input.trustedParentPath,
  });
  if (state.head !== input.expectedParent) throw new Error("unexpected local Git state");
  if (state.operationIds.includes(input.operationId)) {
    throw new Error("duplicate domain-rule operation ID");
  }

  const canonicalRepositoryPath = context.repositoryIdentity.canonicalPath;
  const customPath = join(canonicalRepositoryPath, "custom.txt");
  const gitPath = join(canonicalRepositoryPath, ".git");
  const gitIdentity = assertPrivateDirectory(gitPath);
  const existing = readPrivateTextFile(customPath);
  const existingSha256 = sha256(existing);
  const update = updateManagedDomainRules(existing, input.rules);
  if (!update.changed) {
    return {
      changed: false,
      contentSha256: existingSha256,
      head: state.head,
      parent: state.head,
    };
  }
  if (!hasLocalRuleHistoryCapacity(state.operationIds.length)) {
    throw new Error("local domain-rule history limit reached");
  }

  const temporaryIndexPath = join(gitPath, `submerge-index-${process.pid}-${randomUUID()}`);
  let worktreeOutcome: "ambiguous" | "before" | "written" = "before";
  let referenceOutcome: "ambiguous" | "before" | "committed" = "before";
  try {
    assertStableDirectory(context.parentIdentity);
    assertStableDirectory(context.repositoryIdentity);
    assertStableDirectory(gitIdentity);
    await runLocalGit(canonicalRepositoryPath, ["read-tree", input.expectedParent], {
      indexPath: temporaryIndexPath,
      signal: input.signal,
    });
    worktreeOutcome = "ambiguous";
    writePrivateFileAtomically(customPath, update.content, existingSha256, () =>
      hitFailpoint(input.testFailpoint, "after-worktree-rename"),
    );
    worktreeOutcome = "written";
    hitFailpoint(input.testFailpoint, "after-worktree-write");
    assertStableDirectory(context.parentIdentity);
    assertStableDirectory(context.repositoryIdentity);
    assertStableDirectory(gitIdentity);
    await runLocalGit(canonicalRepositoryPath, ["add", "--", "custom.txt"], {
      indexPath: temporaryIndexPath,
      signal: input.signal,
    });
    await runLocalGit(
      canonicalRepositoryPath,
      ["diff", "--cached", "--check", input.expectedParent, "--", "custom.txt"],
      { indexPath: temporaryIndexPath, signal: input.signal },
    );
    const tree = (
      await runLocalGit(canonicalRepositoryPath, ["write-tree"], {
        indexPath: temporaryIndexPath,
        signal: input.signal,
      })
    ).trim();
    const head = (
      await runLocalGit(
        canonicalRepositoryPath,
        [
          "commit-tree",
          tree,
          "-p",
          input.expectedParent,
          "-m",
          "Update managed domain rules",
          "-m",
          `Submerge-Operation-Id: ${input.operationId}`,
        ],
        { signal: input.signal },
      )
    ).trim();
    const blob = await assertCommit(
      canonicalRepositoryPath,
      head,
      input.expectedParent,
      input.operationId,
      update.content,
      input.signal,
    );
    assertNotAborted(input.signal);
    assertSafeGitMetadataLayout(gitIdentity.canonicalPath, new Set([temporaryIndexPath]));
    await assertSafeLocalGitConfig(
      canonicalRepositoryPath,
      gitIdentity.canonicalPath,
      input.signal,
    );
    assertStableDirectory(context.parentIdentity);
    assertStableDirectory(context.repositoryIdentity);
    assertStableDirectory(gitIdentity);
    fsyncRegularFile(temporaryIndexPath);
    for (const objectId of [blob, tree, head])
      fsyncLooseObject(gitIdentity.canonicalPath, objectId);
    referenceOutcome = "ambiguous";
    try {
      await runLocalGit(
        canonicalRepositoryPath,
        ["update-ref", "refs/heads/main", head, input.expectedParent],
        { signal: input.signal },
      );
      hitFailpoint(input.testFailpoint, "after-ref-update-ambiguous");
      referenceOutcome = "committed";
    } catch (error) {
      const observedHead = (
        await runLocalGit(canonicalRepositoryPath, ["rev-parse", "--verify", "refs/heads/main"])
      ).trim();
      if (observedHead === head) referenceOutcome = "committed";
      else if (observedHead === input.expectedParent) {
        referenceOutcome = "before";
        throw error;
      } else {
        throw new Error("unexpected local Git state");
      }
    }
    hitFailpoint(input.testFailpoint, "after-ref-update-committed");
    fsyncRegularFile(join(gitIdentity.canonicalPath, "refs", "heads", "main"));
    fsyncDirectory(join(gitIdentity.canonicalPath, "refs", "heads"));
    fsyncDirectory(join(gitIdentity.canonicalPath, "refs"));
    renameSync(temporaryIndexPath, join(gitPath, "index"));
    fsyncDirectory(gitPath);

    const finalState = await validateExistingLocalRuleRepository(context, undefined, false);
    if (finalState.head !== head || finalState.contentSha256 !== sha256(update.content)) {
      throw new Error("local domain-rule commit attestation failed");
    }
    return {
      changed: true,
      contentSha256: finalState.contentSha256,
      head,
      parent: input.expectedParent,
    };
  } catch (error) {
    if (worktreeOutcome === "written" && referenceOutcome === "before") {
      try {
        writePrivateFileAtomically(customPath, existing, sha256(update.content));
        worktreeOutcome = "before";
      } catch (recoveryError) {
        throw retainRepositoryLock(recoveryError);
      }
    }
    if (worktreeOutcome !== "before" || referenceOutcome !== "before") {
      throw retainRepositoryLock(error);
    }
    removeFileIfPresent(temporaryIndexPath);
    throw error;
  }
}

export async function commitManagedDomainRules(
  input: CommitManagedDomainRulesInput,
): Promise<CommittedDomainRules> {
  assertNotAborted(input.signal);
  assertTrustedGitBinary();
  const context = resolveRepositoryContext(input.repositoryPath, input.trustedParentPath);
  return withRepositoryLock(context, () => commitManagedDomainRulesUnlocked(input, context));
}

export async function attestLocalDomainRuleOperationState(
  input: AttestLocalDomainRuleOperationStateInput,
): Promise<AttestedLocalDomainRuleOperationState> {
  assertNotAborted(input.signal);
  assertTrustedGitBinary();
  if (
    !OPERATION_ID_PATTERN.test(input.operationId) ||
    !COMMIT_SHA_PATTERN.test(input.expectedParent) ||
    !/^[0-9a-f]{64}$/u.test(input.committedContentSha256)
  ) {
    throw new Error("invalid domain-rule operation attestation input");
  }
  const context = resolveRepositoryContext(input.repositoryPath, input.trustedParentPath);
  return withRepositoryLock(context, async () => {
    const attested = await validateExistingLocalRuleRepository(context, input.signal, false);
    if (attested.head === input.expectedParent) {
      return {
        state: "parent",
        contentSha256: attested.contentSha256,
        head: attested.head,
      };
    }
    if (attested.contentSha256 !== input.committedContentSha256) {
      throw new Error("unexpected local Git state");
    }
    await assertCommit(
      context.repositoryIdentity.canonicalPath,
      attested.head,
      input.expectedParent,
      input.operationId,
      attested.content,
      input.signal,
    );
    const reattested = await validateExistingLocalRuleRepository(context, input.signal, false);
    if (
      reattested.head !== attested.head ||
      reattested.contentSha256 !== attested.contentSha256 ||
      reattested.content !== attested.content
    ) {
      throw new Error("local domain-rule repository changed during operation attestation");
    }
    return {
      state: "committed",
      contentSha256: reattested.contentSha256,
      head: reattested.head,
      parent: input.expectedParent,
    };
  });
}
