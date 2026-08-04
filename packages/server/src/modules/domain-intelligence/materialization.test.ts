import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DomainRuleMaterializationError,
  reconcileInitialDomainRuleMaterialization,
} from "./materialization.js";
import {
  commitManagedDomainRules,
  prepareLocalRuleRepositoryDirectories,
  provisionLocalDomainRuleStore,
  provisionLocalRuleRepository,
} from "./publisher.js";

const temporaryDirectories: string[] = [];
const content = "# BEGIN SUBMERGE MANAGED\n+.service.example\n# END SUBMERGE MANAGED\n";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createMihomoDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "submerge-materialization-"));
  temporaryDirectories.push(path);
  chmodSync(path, 0o755);
  return path;
}

function reconcile(mihomoDirectoryPath: string, expectedContent: string = content) {
  return reconcileInitialDomainRuleMaterialization({
    content: expectedContent,
    contentSha256: sha256(expectedContent),
    mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("reconcileInitialDomainRuleMaterialization", () => {
  it("materializes the exact content returned by repository attestation", async () => {
    const dataDirectory = createMihomoDirectory();
    const mihomoDirectoryPath = createMihomoDirectory();
    const paths = prepareLocalRuleRepositoryDirectories(dataDirectory);
    writeFileSync(join(paths.repositoryPath, "custom.txt"), content, { mode: 0o600 });
    const result = await provisionLocalDomainRuleStore({
      mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
      repositoryPath: paths.repositoryPath,
      trustedParentPath: paths.trustedParentPath,
    });

    expect(result.repository.baselineCreated).toBe(true);
    expect(result.materialization.contentSha256).toBe(result.repository.contentSha256);
    expect(readFileSync(result.materialization.filesystemPath, "utf8")).toBe(content);

    const repeated = await provisionLocalDomainRuleStore({
      mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
      repositoryPath: paths.repositoryPath,
      trustedParentPath: paths.trustedParentPath,
    });
    expect(repeated.repository.baselineCreated).toBe(false);
  }, 15_000);

  it("holds the repository lock through final materialization attestation", async () => {
    const dataDirectory = createMihomoDirectory();
    const mihomoDirectoryPath = createMihomoDirectory();
    const paths = prepareLocalRuleRepositoryDirectories(dataDirectory);
    writeFileSync(join(paths.repositoryPath, "custom.txt"), content, { mode: 0o600 });
    const initial = await provisionLocalRuleRepository(paths.repositoryPath, {
      trustedParentPath: paths.trustedParentPath,
    });
    let competingCommit: Promise<unknown> | undefined;

    const result = await provisionLocalDomainRuleStore({
      mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
      repositoryPath: paths.repositoryPath,
      testBeforeMaterializationPublish: () => {
        competingCommit = commitManagedDomainRules({
          expectedParent: initial.head,
          operationId: "op-materialization-race",
          repositoryPath: paths.repositoryPath,
          rules: ["+.other.example"],
          trustedParentPath: paths.trustedParentPath,
        }).catch((error: unknown) => error);
      },
      trustedParentPath: paths.trustedParentPath,
    });

    expect(competingCommit).toBeDefined();
    await expect(competingCommit).resolves.toEqual(
      new Error("local domain-rule repository is busy"),
    );
    expect(result.repository.head).toBe(initial.head);
    expect(readFileSync(result.materialization.filesystemPath, "utf8")).toBe(content);
  });

  it("re-attests repository bytes after materialization before returning success", async () => {
    const dataDirectory = createMihomoDirectory();
    const mihomoDirectoryPath = createMihomoDirectory();
    const paths = prepareLocalRuleRepositoryDirectories(dataDirectory);
    writeFileSync(join(paths.repositoryPath, "custom.txt"), content, { mode: 0o600 });
    await provisionLocalRuleRepository(paths.repositoryPath, {
      trustedParentPath: paths.trustedParentPath,
    });
    const tampered = "# BEGIN SUBMERGE MANAGED\n+.tampered.example\n# END SUBMERGE MANAGED\n";

    await expect(
      provisionLocalDomainRuleStore({
        mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
        repositoryPath: paths.repositoryPath,
        testBeforeMaterializationPublish: () => {
          writeFileSync(join(paths.repositoryPath, "custom.txt"), tampered, { mode: 0o600 });
        },
        trustedParentPath: paths.trustedParentPath,
      }),
    ).rejects.toThrow("unexpected local Git state");
    expect(readFileSync(join(paths.repositoryPath, "custom.txt"), "utf8")).toBe(tampered);
    expect(readFileSync(join(mihomoDirectoryPath, "domain-rules", "custom.txt"), "utf8")).toBe(
      content,
    );
  });

  it("atomically creates the code-owned provider file with readable-only deployment mode", () => {
    const mihomoDirectoryPath = createMihomoDirectory();

    const result = reconcile(mihomoDirectoryPath);

    expect(result).toEqual({
      changed: true,
      contentSha256: sha256(content),
      filesystemPath: join(realpathSync(mihomoDirectoryPath), "domain-rules", "custom.txt"),
      providerPath: "./domain-rules/custom.txt",
    });
    expect(readFileSync(result.filesystemPath, "utf8")).toBe(content);
    expect(statSync(join(mihomoDirectoryPath, "domain-rules")).mode & 0o777).toBe(0o755);
    expect(statSync(result.filesystemPath).mode & 0o777).toBe(0o644);
  });

  it("accepts an identical existing materialization without replacing its inode", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const first = reconcile(mihomoDirectoryPath);
    const inode = lstatSync(first.filesystemPath).ino;

    const second = reconcile(mihomoDirectoryPath);

    expect(second.changed).toBe(false);
    expect(lstatSync(first.filesystemPath).ino).toBe(inode);
    expect(readFileSync(first.filesystemPath, "utf8")).toBe(content);
  });

  it("re-attests directory entries before returning an identical-file no-op", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const first = reconcile(mihomoDirectoryPath);
    const inode = lstatSync(first.filesystemPath).ino;
    const artifactPath = join(mihomoDirectoryPath, "domain-rules", ".operator-state");

    expect(() =>
      reconcileInitialDomainRuleMaterialization({
        content,
        contentSha256: sha256(content),
        mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
        testBeforeExistingRead: () => writeFileSync(artifactPath, "evidence\n", { mode: 0o600 }),
      }),
    ).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "unexpected domain-rule materialization state",
      ),
    );
    expect(lstatSync(first.filesystemPath).ino).toBe(inode);
    expect(readFileSync(first.filesystemPath, "utf8")).toBe(content);
    expect(readFileSync(artifactPath, "utf8")).toBe("evidence\n");
  });

  it("preserves a different existing file and requires an explicit migration", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const first = reconcile(
      mihomoDirectoryPath,
      "# BEGIN SUBMERGE MANAGED\n# END SUBMERGE MANAGED\n",
    );
    const previous = readFileSync(first.filesystemPath, "utf8");

    expect(() => reconcile(mihomoDirectoryPath)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-migration-required",
        "active domain-rule materialization differs from the repository baseline",
      ),
    );
    expect(readFileSync(first.filesystemPath, "utf8")).toBe(previous);
  });

  it("rejects a digest mismatch before creating the materialization directory", () => {
    const mihomoDirectoryPath = createMihomoDirectory();

    expect(() =>
      reconcileInitialDomainRuleMaterialization({
        content,
        contentSha256: "0".repeat(64),
        mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
      }),
    ).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-unsafe",
        "attested domain-rule content digest does not match",
      ),
    );
    expect(() => statSync(join(mihomoDirectoryPath, "domain-rules"))).toThrow();
  });

  it("classifies a missing Mihomo directory as an unsafe local store", () => {
    const missingDirectory = join(createMihomoDirectory(), "missing");

    expect(() => reconcile(missingDirectory)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-unsafe",
        "domain-rule materialization filesystem operation failed",
      ),
    );
  });

  it("attests a materialization directory created concurrently", () => {
    const mihomoDirectoryPath = createMihomoDirectory();

    const result = reconcileInitialDomainRuleMaterialization({
      content,
      contentSha256: sha256(content),
      mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
      testBeforeDirectoryCreate: (directoryPath) => mkdirSync(directoryPath, { mode: 0o755 }),
    });

    expect(readFileSync(result.filesystemPath, "utf8")).toBe(content);
  });

  it("rejects a symlinked materialization directory without touching its target", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const outside = createMihomoDirectory();
    symlinkSync(outside, join(mihomoDirectoryPath, "domain-rules"));

    expect(() => reconcile(mihomoDirectoryPath)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-unsafe",
        "unsafe domain-rule materialization directory",
      ),
    );
    expect(() => statSync(join(outside, "custom.txt"))).toThrow();
  });

  it("rejects an unsafe existing provider file and preserves it", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const first = reconcile(mihomoDirectoryPath);
    chmodSync(first.filesystemPath, 0o666);

    expect(() => reconcile(mihomoDirectoryPath)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-unsafe",
        "unsafe domain-rule materialization file",
      ),
    );
    expect(readFileSync(first.filesystemPath, "utf8")).toBe(content);
  });

  it("rejects invalid UTF-8 in an existing provider file", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const directoryPath = join(mihomoDirectoryPath, "domain-rules");
    mkdirSync(directoryPath, { mode: 0o755 });
    const providerPath = join(directoryPath, "custom.txt");
    writeFileSync(providerPath, Buffer.from([0xff]), { mode: 0o644 });

    expect(() => reconcile(mihomoDirectoryPath)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-unsafe",
        "invalid UTF-8 in domain-rule materialization file",
      ),
    );
    expect(readFileSync(providerPath)).toEqual(Buffer.from([0xff]));
  });

  it("rejects a symlinked provider file and preserves its target", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const outside = join(createMihomoDirectory(), "outside.txt");
    writeFileSync(outside, "outside\n", { mode: 0o644 });
    const materializationDirectory = join(mihomoDirectoryPath, "domain-rules");
    reconcile(mihomoDirectoryPath);
    rmSync(join(materializationDirectory, "custom.txt"));
    symlinkSync(outside, join(materializationDirectory, "custom.txt"));

    expect(() => reconcile(mihomoDirectoryPath)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-unsafe",
        "unsafe domain-rule materialization file",
      ),
    );
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("classifies an existing provider that disappears during validation", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const first = reconcile(mihomoDirectoryPath);

    expect(() =>
      reconcileInitialDomainRuleMaterialization({
        content,
        contentSha256: sha256(content),
        mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
        testBeforeExistingRead: (filesystemPath) => unlinkSync(filesystemPath),
      }),
    ).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "domain-rule materialization disappeared during validation",
      ),
    );
    expect(() => statSync(first.filesystemPath)).toThrow();
  });

  it("rejects a provider changed after the post-read descriptor check", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const first = reconcile(mihomoDirectoryPath);

    expect(() =>
      reconcileInitialDomainRuleMaterialization({
        content,
        contentSha256: sha256(content),
        mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
        testBeforeFinalProviderStat: (filesystemPath) => appendFileSync(filesystemPath, "x"),
      }),
    ).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-unsafe",
        "unstable domain-rule materialization file",
      ),
    );
    expect(readFileSync(first.filesystemPath, "utf8")).toBe(`${content}x`);
  });

  it("preserves a provider file created concurrently instead of overwriting it", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const concurrentContent = "concurrent owner\n";

    expect(() =>
      reconcileInitialDomainRuleMaterialization({
        content,
        contentSha256: sha256(content),
        mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
        testBeforePublish: (filesystemPath) => {
          writeFileSync(filesystemPath, concurrentContent, { mode: 0o644 });
        },
      }),
    ).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "domain-rule materialization appeared during publication",
      ),
    );
    const directoryPath = join(mihomoDirectoryPath, "domain-rules");
    expect(readFileSync(join(directoryPath, "custom.txt"), "utf8")).toBe(concurrentContent);
    expect(readdirSync(directoryPath)).toEqual(["custom.txt"]);
  });

  it("finishes a known interrupted temporary publication on retry", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const directoryPath = join(mihomoDirectoryPath, "domain-rules");
    mkdirSync(directoryPath, { mode: 0o755 });
    const temporaryPath = join(
      directoryPath,
      ".custom.txt.submerge-123-12345678-1234-4234-8234-123456789abc",
    );
    writeFileSync(temporaryPath, content, { mode: 0o600 });

    const result = reconcile(mihomoDirectoryPath);

    expect(result.changed).toBe(true);
    expect(readFileSync(result.filesystemPath, "utf8")).toBe(content);
    expect(lstatSync(result.filesystemPath).nlink).toBe(1);
    expect(() => statSync(temporaryPath)).toThrow();
  });

  it("preserves a partial known temporary publication for explicit reconciliation", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const directoryPath = join(mihomoDirectoryPath, "domain-rules");
    mkdirSync(directoryPath, { mode: 0o755 });
    const temporaryPath = join(
      directoryPath,
      ".custom.txt.submerge-123-12345678-1234-4234-8234-123456789abc",
    );
    writeFileSync(temporaryPath, "partial\n", { mode: 0o600 });

    expect(() => reconcile(mihomoDirectoryPath)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "interrupted domain-rule materialization differs from the repository baseline",
      ),
    );
    expect(readFileSync(temporaryPath, "utf8")).toBe("partial\n");
    expect(() => statSync(join(directoryPath, "custom.txt"))).toThrow();
  });

  it("cleans a known temporary hardlink left after atomic publication", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const directoryPath = join(mihomoDirectoryPath, "domain-rules");
    mkdirSync(directoryPath, { mode: 0o755 });
    const temporaryPath = join(
      directoryPath,
      ".custom.txt.submerge-123-12345678-1234-4234-8234-123456789abc",
    );
    const providerPath = join(directoryPath, "custom.txt");
    writeFileSync(temporaryPath, content, { mode: 0o644 });
    linkSync(temporaryPath, providerPath);

    const result = reconcile(mihomoDirectoryPath);

    expect(result.changed).toBe(false);
    expect(readFileSync(result.filesystemPath, "utf8")).toBe(content);
    expect(lstatSync(result.filesystemPath).nlink).toBe(1);
    expect(() => statSync(temporaryPath)).toThrow();
  });

  it("preserves distinct temporary and provider files as a restart conflict", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const directoryPath = join(mihomoDirectoryPath, "domain-rules");
    mkdirSync(directoryPath, { mode: 0o755 });
    const temporaryPath = join(
      directoryPath,
      ".custom.txt.submerge-123-12345678-1234-4234-8234-123456789abc",
    );
    const providerPath = join(directoryPath, "custom.txt");
    writeFileSync(temporaryPath, content, { mode: 0o644 });
    writeFileSync(providerPath, "concurrent owner\n", { mode: 0o644 });
    const temporaryInode = lstatSync(temporaryPath).ino;
    const providerInode = lstatSync(providerPath).ino;

    expect(() => reconcile(mihomoDirectoryPath)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "conflicting interrupted domain-rule materialization",
      ),
    );
    expect(lstatSync(temporaryPath).ino).toBe(temporaryInode);
    expect(lstatSync(providerPath).ino).toBe(providerInode);
    expect(readFileSync(temporaryPath, "utf8")).toBe(content);
    expect(readFileSync(providerPath, "utf8")).toBe("concurrent owner\n");
  });

  it("preserves unknown materialization artifacts for explicit reconciliation", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const directoryPath = join(mihomoDirectoryPath, "domain-rules");
    mkdirSync(directoryPath, { mode: 0o755 });
    writeFileSync(join(directoryPath, ".custom.txt.interrupted"), "evidence\n", { mode: 0o600 });

    expect(() => reconcile(mihomoDirectoryPath)).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "unexpected domain-rule materialization state",
      ),
    );
    expect(readFileSync(join(directoryPath, ".custom.txt.interrupted"), "utf8")).toBe("evidence\n");
  });

  it("detects an unknown artifact created during publication before reporting success", () => {
    const mihomoDirectoryPath = createMihomoDirectory();
    const directoryPath = join(mihomoDirectoryPath, "domain-rules");

    expect(() =>
      reconcileInitialDomainRuleMaterialization({
        content,
        contentSha256: sha256(content),
        mihomoConfigPath: join(mihomoDirectoryPath, "config.yaml"),
        testBeforePublish: () => {
          writeFileSync(join(directoryPath, ".operator-state"), "evidence\n", { mode: 0o600 });
        },
      }),
    ).toThrowError(
      new DomainRuleMaterializationError(
        "local-store-reconciliation-required",
        "unexpected domain-rule materialization state",
      ),
    );
    expect(readFileSync(join(directoryPath, "custom.txt"), "utf8")).toBe(content);
    expect(readFileSync(join(directoryPath, ".operator-state"), "utf8")).toBe("evidence\n");
  });
});
