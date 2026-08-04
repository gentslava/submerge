import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MATERIALIZATION_DIRECTORY_NAME = "domain-rules";
const MATERIALIZATION_FILE_NAME = "custom.txt";
const PROVIDER_PATH = `./${MATERIALIZATION_DIRECTORY_NAME}/${MATERIALIZATION_FILE_NAME}`;
const MAX_MATERIALIZATION_BYTES = 1024 * 1024;
const MATERIALIZATION_TEMPORARY_PATTERN =
  /^\.custom\.txt\.submerge-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type DomainRuleMaterializationFailureReason =
  | "local-store-migration-required"
  | "local-store-reconciliation-required"
  | "local-store-unsafe";

export class DomainRuleMaterializationError extends Error {
  readonly reason: DomainRuleMaterializationFailureReason;

  constructor(reason: DomainRuleMaterializationFailureReason, message: string) {
    super(message);
    this.name = "DomainRuleMaterializationError";
    this.reason = reason;
  }
}

export interface InitialDomainRuleMaterializationInput {
  content: string;
  contentSha256: string;
  mihomoConfigPath: string;
  /** @internal Deterministic directory-creation race injection for materialization tests. */
  testBeforeDirectoryCreate?: ((directoryPath: string) => void) | undefined;
  /** @internal Deterministic existing-file race injection for materialization tests. */
  testBeforeExistingRead?: ((filesystemPath: string) => void) | undefined;
  /** @internal Deterministic final path-attestation race injection for materialization tests. */
  testBeforeFinalProviderStat?: ((filesystemPath: string) => void) | undefined;
  /** @internal Deterministic publication-race injection for materialization tests. */
  testBeforePublish?: ((filesystemPath: string) => void) | undefined;
}

export interface DomainRuleMaterializationResult {
  changed: boolean;
  contentSha256: string;
  filesystemPath: string;
  providerPath: "./domain-rules/custom.txt";
}

interface DirectoryIdentity {
  canonicalPath: string;
  dev: number;
  ino: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isOwnedByRuntime(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function assertMihomoDirectory(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    !isOwnedByRuntime(stat.uid)
  ) {
    throw new DomainRuleMaterializationError("local-store-unsafe", "unsafe Mihomo home directory");
  }
  return { canonicalPath: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertMaterializationDirectory(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o755 ||
    !isOwnedByRuntime(stat.uid)
  ) {
    throw new DomainRuleMaterializationError(
      "local-store-unsafe",
      "unsafe domain-rule materialization directory",
    );
  }
  return { canonicalPath: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertStableDirectory(identity: DirectoryIdentity, kind: "materialization" | "mihomo") {
  const current =
    kind === "mihomo"
      ? assertMihomoDirectory(identity.canonicalPath)
      : assertMaterializationDirectory(identity.canonicalPath);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new DomainRuleMaterializationError(
      "local-store-unsafe",
      `unstable ${kind === "mihomo" ? "Mihomo home" : "domain-rule materialization"} directory`,
    );
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function prepareMaterializationDirectory(
  mihomoDirectory: DirectoryIdentity,
  testBeforeDirectoryCreate?: ((directoryPath: string) => void) | undefined,
): DirectoryIdentity {
  const path = join(mihomoDirectory.canonicalPath, MATERIALIZATION_DIRECTORY_NAME);
  if (!existsSync(path)) {
    testBeforeDirectoryCreate?.(path);
    try {
      mkdirSync(path, { mode: 0o755 });
      chmodSync(path, 0o755);
      fsyncDirectory(mihomoDirectory.canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const identity = assertMaterializationDirectory(path);
  if (dirname(identity.canonicalPath) !== mihomoDirectory.canonicalPath) {
    throw new DomainRuleMaterializationError(
      "local-store-unsafe",
      "unsafe domain-rule materialization directory",
    );
  }
  fsyncDirectory(mihomoDirectory.canonicalPath);
  assertStableDirectory(mihomoDirectory, "mihomo");
  return identity;
}

function readMaterializationDirectoryEntries(directoryPath: string): string[] {
  const directory = opendirSync(directoryPath);
  const entries: string[] = [];
  try {
    let entry = directory.readSync();
    while (entry) {
      entries.push(entry.name);
      if (entries.length > 2) {
        throw new DomainRuleMaterializationError(
          "local-store-reconciliation-required",
          "unexpected domain-rule materialization state",
        );
      }
      entry = directory.readSync();
    }
  } finally {
    directory.closeSync();
  }
  return entries.sort();
}

function assertExpectedDirectoryEntries(directoryPath: string): void {
  const entries = readMaterializationDirectoryEntries(directoryPath);
  if (entries.length > 1 || (entries.length === 1 && entries[0] !== MATERIALIZATION_FILE_NAME)) {
    throw new DomainRuleMaterializationError(
      "local-store-reconciliation-required",
      "unexpected domain-rule materialization state",
    );
  }
}

function assertMaterializationFile(
  path: string,
  allowedModes: ReadonlySet<number>,
  allowedLinkCounts: ReadonlySet<number>,
) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !allowedLinkCounts.has(stat.nlink) ||
    !allowedModes.has(stat.mode & 0o777) ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    stat.size > MAX_MATERIALIZATION_BYTES ||
    !isOwnedByRuntime(stat.uid)
  ) {
    throw new DomainRuleMaterializationError(
      "local-store-unsafe",
      "unsafe domain-rule materialization file",
    );
  }
  return stat;
}

function readStableMaterializationFile(
  path: string,
  allowedModes: ReadonlySet<number>,
  allowedLinkCounts: ReadonlySet<number>,
  testBeforeFinalPathStat?: ((filesystemPath: string) => void) | undefined,
): string {
  try {
    const before = assertMaterializationFile(path, allowedModes, allowedLinkCounts);
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        !opened.isFile() ||
        !allowedLinkCounts.has(opened.nlink) ||
        !allowedModes.has(opened.mode & 0o777) ||
        !Number.isSafeInteger(opened.size) ||
        opened.size < 0 ||
        opened.size > MAX_MATERIALIZATION_BYTES ||
        !isOwnedByRuntime(opened.uid)
      ) {
        throw new DomainRuleMaterializationError(
          "local-store-unsafe",
          "unstable domain-rule materialization file",
        );
      }
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (read === 0) {
          throw new DomainRuleMaterializationError(
            "local-store-unsafe",
            "unstable domain-rule materialization file",
          );
        }
        offset += read;
      }
      if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) {
        throw new DomainRuleMaterializationError(
          "local-store-unsafe",
          "unstable domain-rule materialization file",
        );
      }
      const after = fstatSync(descriptor);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        !after.isFile() ||
        !allowedLinkCounts.has(after.nlink) ||
        !allowedModes.has(after.mode & 0o777) ||
        !isOwnedByRuntime(after.uid) ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      ) {
        throw new DomainRuleMaterializationError(
          "local-store-unsafe",
          "unstable domain-rule materialization file",
        );
      }
      testBeforeFinalPathStat?.(path);
      const current = assertMaterializationFile(path, allowedModes, allowedLinkCounts);
      if (
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        current.size !== opened.size ||
        current.mtimeMs !== opened.mtimeMs ||
        current.ctimeMs !== opened.ctimeMs ||
        (current.mode & 0o777) !== (opened.mode & 0o777) ||
        current.uid !== opened.uid ||
        current.nlink !== opened.nlink
      ) {
        throw new DomainRuleMaterializationError(
          "local-store-unsafe",
          "unstable domain-rule materialization file",
        );
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new DomainRuleMaterializationError(
          "local-store-unsafe",
          "invalid UTF-8 in domain-rule materialization file",
        );
      }
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "domain-rule materialization disappeared during validation",
      );
    }
    throw error;
  }
}

function readStableProviderFile(
  path: string,
  testBeforeFinalPathStat?: ((filesystemPath: string) => void) | undefined,
): string {
  return readStableMaterializationFile(
    path,
    new Set([0o644]),
    new Set([1]),
    testBeforeFinalPathStat,
  );
}

function fsyncMaterializationFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function reconcileInterruptedMaterialization(
  directory: DirectoryIdentity,
  targetPath: string,
  expectedContent: string,
): boolean {
  const entries = readMaterializationDirectoryEntries(directory.canonicalPath);
  const temporaryEntries = entries.filter((entry) => MATERIALIZATION_TEMPORARY_PATTERN.test(entry));
  const unknownEntries = entries.filter(
    (entry) =>
      entry !== MATERIALIZATION_FILE_NAME && !MATERIALIZATION_TEMPORARY_PATTERN.test(entry),
  );
  if (unknownEntries.length > 0 || temporaryEntries.length > 1) {
    throw new DomainRuleMaterializationError(
      "local-store-reconciliation-required",
      "unexpected domain-rule materialization state",
    );
  }
  const temporaryName = temporaryEntries[0];
  if (!temporaryName) {
    assertExpectedDirectoryEntries(directory.canonicalPath);
    return false;
  }

  const temporaryPath = join(directory.canonicalPath, temporaryName);
  if (entries.includes(MATERIALIZATION_FILE_NAME)) {
    const temporary = assertMaterializationFile(temporaryPath, new Set([0o644]), new Set([1, 2]));
    const target = assertMaterializationFile(targetPath, new Set([0o644]), new Set([1, 2]));
    if (temporary.dev !== target.dev || temporary.ino !== target.ino) {
      throw new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "conflicting interrupted domain-rule materialization",
      );
    }
    if (temporary.nlink !== 2 || target.nlink !== 2) {
      throw new DomainRuleMaterializationError(
        "local-store-unsafe",
        "unsafe interrupted domain-rule materialization links",
      );
    }
    if (
      readStableMaterializationFile(temporaryPath, new Set([0o644]), new Set([2])) !==
      expectedContent
    ) {
      throw new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "interrupted domain-rule materialization differs from the repository baseline",
      );
    }
    unlinkSync(temporaryPath);
    fsyncDirectory(directory.canonicalPath);
    if (readStableProviderFile(targetPath) !== expectedContent) {
      throw new DomainRuleMaterializationError(
        "local-store-unsafe",
        "recovered domain-rule materialization does not match",
      );
    }
    return false;
  }

  const temporary = assertMaterializationFile(temporaryPath, new Set([0o600, 0o644]), new Set([1]));
  if (
    readStableMaterializationFile(temporaryPath, new Set([0o600, 0o644]), new Set([1])) !==
    expectedContent
  ) {
    throw new DomainRuleMaterializationError(
      "local-store-reconciliation-required",
      "interrupted domain-rule materialization differs from the repository baseline",
    );
  }
  if ((temporary.mode & 0o777) !== 0o644) chmodSync(temporaryPath, 0o644);
  fsyncMaterializationFile(temporaryPath);
  try {
    linkSync(temporaryPath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "domain-rule materialization appeared during recovery",
      );
    }
    throw error;
  }
  unlinkSync(temporaryPath);
  fsyncDirectory(directory.canonicalPath);
  if (readStableProviderFile(targetPath) !== expectedContent) {
    throw new DomainRuleMaterializationError(
      "local-store-unsafe",
      "recovered domain-rule materialization does not match",
    );
  }
  return true;
}

function createProviderFileAtomically(
  directory: DirectoryIdentity,
  targetPath: string,
  content: string,
  testBeforePublish?: ((filesystemPath: string) => void) | undefined,
): void {
  const temporaryPath = join(
    directory.canonicalPath,
    `.${basename(targetPath)}.submerge-${process.pid}-${randomUUID()}`,
  );
  let temporaryCreated = false;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      writeFileSync(descriptor, content, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporaryPath, 0o644);
    const modeDescriptor = openSync(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(modeDescriptor);
    } finally {
      closeSync(modeDescriptor);
    }
    assertStableDirectory(directory, "materialization");
    testBeforePublish?.(targetPath);
    try {
      linkSync(temporaryPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DomainRuleMaterializationError(
          "local-store-reconciliation-required",
          "domain-rule materialization appeared during publication",
        );
      }
      throw error;
    }
    unlinkSync(temporaryPath);
    temporaryCreated = false;
    fsyncDirectory(directory.canonicalPath);
  } finally {
    if (temporaryCreated && existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function reconcileInitialDomainRuleMaterializationUnchecked(
  input: InitialDomainRuleMaterializationInput,
): DomainRuleMaterializationResult {
  if (
    Buffer.byteLength(input.content, "utf8") > MAX_MATERIALIZATION_BYTES ||
    !/^[0-9a-f]{64}$/u.test(input.contentSha256) ||
    sha256(input.content) !== input.contentSha256
  ) {
    throw new DomainRuleMaterializationError(
      "local-store-unsafe",
      "attested domain-rule content digest does not match",
    );
  }

  const mihomoDirectory = assertMihomoDirectory(resolve(dirname(input.mihomoConfigPath)));
  const materializationDirectory = prepareMaterializationDirectory(
    mihomoDirectory,
    input.testBeforeDirectoryCreate,
  );
  const filesystemPath = join(materializationDirectory.canonicalPath, MATERIALIZATION_FILE_NAME);
  const recoveredPublication = reconcileInterruptedMaterialization(
    materializationDirectory,
    filesystemPath,
    input.content,
  );
  assertExpectedDirectoryEntries(materializationDirectory.canonicalPath);

  if (existsSync(filesystemPath)) {
    input.testBeforeExistingRead?.(filesystemPath);
    const existing = readStableProviderFile(filesystemPath, input.testBeforeFinalProviderStat);
    if (sha256(existing) !== input.contentSha256 || existing !== input.content) {
      throw new DomainRuleMaterializationError(
        "local-store-migration-required",
        "active domain-rule materialization differs from the repository baseline",
      );
    }
    assertStableDirectory(mihomoDirectory, "mihomo");
    assertStableDirectory(materializationDirectory, "materialization");
    fsyncDirectory(materializationDirectory.canonicalPath);
    assertExpectedDirectoryEntries(materializationDirectory.canonicalPath);
    return {
      changed: recoveredPublication,
      contentSha256: input.contentSha256,
      filesystemPath,
      providerPath: PROVIDER_PATH,
    };
  }

  createProviderFileAtomically(
    materializationDirectory,
    filesystemPath,
    input.content,
    input.testBeforePublish,
  );
  if (readStableProviderFile(filesystemPath) !== input.content) {
    throw new DomainRuleMaterializationError(
      "local-store-unsafe",
      "materialized domain-rule content does not match",
    );
  }
  assertStableDirectory(mihomoDirectory, "mihomo");
  assertStableDirectory(materializationDirectory, "materialization");
  fsyncDirectory(materializationDirectory.canonicalPath);
  assertExpectedDirectoryEntries(materializationDirectory.canonicalPath);
  return {
    changed: true,
    contentSha256: input.contentSha256,
    filesystemPath,
    providerPath: PROVIDER_PATH,
  };
}

export function reconcileInitialDomainRuleMaterialization(
  input: InitialDomainRuleMaterializationInput,
): DomainRuleMaterializationResult {
  try {
    return reconcileInitialDomainRuleMaterializationUnchecked(input);
  } catch (error) {
    if (error instanceof DomainRuleMaterializationError) throw error;
    throw new DomainRuleMaterializationError(
      "local-store-unsafe",
      "domain-rule materialization filesystem operation failed",
    );
  }
}
