import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitManagedDomainRules as commitManagedDomainRulesImpl,
  hasLocalRuleHistoryCapacity,
  prepareLocalRuleRepositoryDirectories,
  provisionLocalRuleRepository as provisionLocalRuleRepositoryImpl,
  recoverStaleLocalRuleRepositoryLock as recoverStaleLocalRuleRepositoryLockImpl,
  updateManagedDomainRules,
} from "./publisher.js";

const temporaryDirectories: string[] = [];

vi.setConfig({ testTimeout: 15_000 });

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(repositoryPath: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createInterruptedBaselineStaging(stagingPath: string, seededContent: string): void {
  writeFileSync(join(stagingPath, "custom.txt"), seededContent, { mode: 0o600 });
  git(stagingPath, ["init", "--initial-branch=main", "--template="]);
  const gitPath = join(stagingPath, ".git");
  mkdirSync(join(gitPath, "hooks"), { mode: 0o700 });
  mkdirSync(join(gitPath, "info"), { mode: 0o700 });
  writeFileSync(join(gitPath, "info", "exclude"), "", { mode: 0o600 });
  chmodSync(gitPath, 0o700);
  for (const relativePath of [
    "hooks",
    "info",
    "objects",
    join("objects", "info"),
    join("objects", "pack"),
    "refs",
    join("refs", "heads"),
    join("refs", "tags"),
  ]) {
    chmodSync(join(gitPath, relativePath), 0o700);
  }
  for (const relativePath of ["HEAD", "config", join("info", "exclude")]) {
    chmodSync(join(gitPath, relativePath), 0o600);
  }
}

type ProvisionOptions = Omit<
  NonNullable<Parameters<typeof provisionLocalRuleRepositoryImpl>[1]>,
  "testFailpoint"
> & {
  testDurabilityTrace?: (
    event:
      | "baseline-git-renamed"
      | "baseline-install-checkpoint"
      | "baseline-parent-fsynced"
      | "baseline-repository-fsynced"
      | "baseline-staging-fsynced",
  ) => void;
  testFailpoint?:
    | "after-baseline-commit"
    | "after-baseline-config"
    | "after-baseline-index"
    | "after-baseline-install"
    | "after-seed-create"
    | "after-staging-init";
  trustedParentPath?: string;
};

type RecoveryOptions = Parameters<typeof recoverStaleLocalRuleRepositoryLockImpl>[1] & {
  testAfterRecoveryRepair?: (() => void) | undefined;
};

function provisionLocalRuleRepository(
  repositoryPath: string,
  options: Omit<ProvisionOptions, "trustedParentPath"> = {},
) {
  return provisionLocalRuleRepositoryImpl(repositoryPath, {
    trustedParentPath: dirname(repositoryPath),
    ...options,
  } as ProvisionOptions);
}

function recoverStaleLocalRuleRepositoryLock(
  repositoryPath: string,
  testProcessAlive: (pid: number) => boolean,
) {
  return recoverStaleLocalRuleRepositoryLockImpl(repositoryPath, {
    testProcessAlive,
    trustedParentPath: dirname(repositoryPath),
  });
}

type CommitInput = Parameters<typeof commitManagedDomainRulesImpl>[0] & {
  testFailpoint?:
    | "after-ref-update-ambiguous"
    | "after-ref-update-committed"
    | "after-worktree-rename"
    | "after-worktree-write";
  trustedParentPath?: string;
};

function commitManagedDomainRules(input: Omit<CommitInput, "trustedParentPath">) {
  return commitManagedDomainRulesImpl({
    trustedParentPath: dirname(input.repositoryPath),
    ...input,
  } as CommitInput);
}

describe("updateManagedDomainRules", () => {
  it("reserves the final history slot before a commit mutates repository state", () => {
    expect(hasLocalRuleHistoryCapacity(0, 2)).toBe(true);
    expect(hasLocalRuleHistoryCapacity(1, 2)).toBe(false);
    expect(hasLocalRuleHistoryCapacity(9_998, 10_000)).toBe(true);
    expect(hasLocalRuleHistoryCapacity(9_999, 10_000)).toBe(false);
  });

  it("appends a sorted managed block without changing existing bytes", () => {
    const existing = "# maintained by the operator\n+.legacy.example\n";

    const result = updateManagedDomainRules(existing, ["+.service.example", "api.service.example"]);

    expect(result).toEqual({
      changed: true,
      content:
        "# maintained by the operator\n+.legacy.example\n# BEGIN SUBMERGE MANAGED\n+.service.example\napi.service.example\n# END SUBMERGE MANAGED\n",
    });
  });

  it("replaces only the managed block and is idempotent", () => {
    const existing =
      "# prefix\r\n# BEGIN SUBMERGE MANAGED\nold.example\n# END SUBMERGE MANAGED\n# suffix\r\n";

    const first = updateManagedDomainRules(existing, ["z.example", "a.example"]);
    const second = updateManagedDomainRules(first.content, ["a.example", "z.example"]);

    expect(first.content).toBe(
      "# prefix\r\n# BEGIN SUBMERGE MANAGED\na.example\nz.example\n# END SUBMERGE MANAGED\n# suffix\r\n",
    );
    expect(second).toEqual({ content: first.content, changed: false });
  });

  it("rejects malformed or repeated managed-block markers", () => {
    expect(() =>
      updateManagedDomainRules("# BEGIN SUBMERGE MANAGED\nold.example\n", ["new.example"]),
    ).toThrow("invalid managed domain-rule block");

    expect(() =>
      updateManagedDomainRules(
        "# BEGIN SUBMERGE MANAGED\na.example\n# END SUBMERGE MANAGED\n# BEGIN SUBMERGE MANAGED\nb.example\n# END SUBMERGE MANAGED\n",
        ["new.example"],
      ),
    ).toThrow("invalid managed domain-rule block");
  });

  it("treats managed-block markers as complete lines only", () => {
    expect(() =>
      updateManagedDomainRules(
        `prefix ${"# BEGIN SUBMERGE MANAGED"}\nold.example\nsuffix ${"# END SUBMERGE MANAGED"}\n`,
        ["new.example"],
      ),
    ).toThrow("invalid managed domain-rule block");
  });

  it("rejects invalid and duplicate proposed rules", () => {
    expect(() => updateManagedDomainRules("", ["https://service.example"])).toThrow(
      "invalid domain rule",
    );
    expect(() =>
      updateManagedDomainRules("", ["api.service.example", "api.service.example"]),
    ).toThrow("duplicate domain rule");
  });

  it("rejects public-suffix widening and duplicates across the complete resulting list", () => {
    expect(() => updateManagedDomainRules("", ["+.co.uk"])).toThrow("invalid domain rule");
    expect(() =>
      updateManagedDomainRules("# operator\n+.legacy.example\n", ["+.legacy.example"]),
    ).toThrow("duplicate domain rule");
  });

  it("rejects invalid operator-owned lines before producing a managed block", () => {
    expect(() =>
      updateManagedDomainRules("https://service.example\n", ["api.service.example"]),
    ).toThrow("invalid domain rule");
  });

  it("rejects malformed managed markers in a complete list", () => {
    expect(() =>
      updateManagedDomainRules(
        "# BEGIN SUBMERGE MANAGED\napi.service.example\n# END SUBMERGE MANAGED suffix\n",
        ["api.service.example"],
      ),
    ).toThrow("invalid managed domain-rule block");
  });
});

describe("provisionLocalRuleRepository", () => {
  it("creates a private nested repository under an existing 0755 data volume", async () => {
    const dataPath = mkdtempSync(join(tmpdir(), "submerge-existing-data-"));
    temporaryDirectories.push(dataPath);
    chmodSync(dataPath, 0o755);

    const paths = prepareLocalRuleRepositoryDirectories(dataPath);
    expect(statSync(paths.trustedParentPath).mode & 0o777).toBe(0o700);
    expect(statSync(paths.repositoryPath).mode & 0o777).toBe(0o700);
    await expect(
      provisionLocalRuleRepositoryImpl(paths.repositoryPath, {
        trustedParentPath: paths.trustedParentPath,
      }),
    ).resolves.toMatchObject({ baselineCreated: true });
  });

  it("does not prepare local rule directories under an unsafe data volume", () => {
    const dataPath = mkdtempSync(join(tmpdir(), "submerge-unsafe-data-"));
    temporaryDirectories.push(dataPath);
    chmodSync(dataPath, 0o777);

    expect(() => prepareLocalRuleRepositoryDirectories(dataPath)).toThrow(
      "unsafe local domain-rule data directory",
    );
    expect(() => statSync(join(dataPath, "domain-rules"))).toThrow();
  });

  it("creates an empty managed baseline on a new install", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);

    const result = await provisionLocalRuleRepository(repositoryPath);

    expect(result.baselineCreated).toBe(true);
    expect(readFileSync(join(repositoryPath, "custom.txt"), "utf8")).toBe(
      "# BEGIN SUBMERGE MANAGED\n# END SUBMERGE MANAGED\n",
    );
    expect(git(repositoryPath, ["show", "HEAD:custom.txt"])).toBe(
      "# BEGIN SUBMERGE MANAGED\n# END SUBMERGE MANAGED\n",
    );
  });

  it("creates a private local main repository and preserves a seeded list byte-for-byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const customPath = join(repositoryPath, "custom.txt");
    const seededContent = "# operator list\r\n+.legacy.example\r\n";
    writeFileSync(customPath, seededContent, { mode: 0o600 });

    const result = await provisionLocalRuleRepository(repositoryPath);

    expect(result.baselineCreated).toBe(true);
    expect(result.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(git(repositoryPath, ["branch", "--show-current"]).trim()).toBe("main");
    expect(git(repositoryPath, ["remote"]).trim()).toBe("");
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
    expect(git(repositoryPath, ["show", "HEAD:custom.txt"])).toBe(seededContent);
    expect(readFileSync(customPath, "utf8")).toBe(seededContent);
    expect(statSync(repositoryPath).mode & 0o777).toBe(0o700);
    expect(statSync(customPath).mode & 0o777).toBe(0o600);
    expect(git(repositoryPath, ["config", "--local", "--get", "core.fsync"]).trim()).toBe(
      "committed",
    );
    expect(git(repositoryPath, ["config", "--local", "--get", "core.fsyncMethod"]).trim()).toBe(
      "fsync",
    );
    expect(git(repositoryPath, ["log", "-1", "--format=%an <%ae>%n%B"])).toContain(
      "Submerge <submerge@localhost>\nInitialize local domain rules",
    );
  });

  it("fails closed when a remote is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    git(repositoryPath, ["remote", "add", "origin", "https://example.invalid/rules.git"]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("fails closed when local Git config can execute a hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    git(repositoryPath, ["config", "core.hooksPath", "hooks"]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("fails closed when local Git config can invoke a credential helper", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    git(repositoryPath, ["config", "credential.helper", "store"]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("fails closed when an active repository hook exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const hookPath = join(repositoryPath, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("fails closed when Git object alternates are configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    writeFileSync(join(repositoryPath, ".git", "objects", "info", "alternates"), "/tmp/objects\n", {
      mode: 0o600,
    });

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("does not inherit ambient Git repository overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, "outside.git");

    let baselineCreated = false;
    try {
      baselineCreated = (await provisionLocalRuleRepository(repositoryPath)).baselineCreated;
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
    expect(baselineCreated).toBe(true);
    expect(git(repositoryPath, ["rev-parse", "--git-dir"])).toContain(".git");
  });

  it("fails closed outside the main branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    git(repositoryPath, ["switch", "-c", "unexpected"]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("fails closed when the repository tracks anything except custom.txt", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    writeFileSync(join(repositoryPath, "unexpected.txt"), "unexpected\n", { mode: 0o600 });
    git(repositoryPath, ["add", "--", "unexpected.txt"]);
    git(repositoryPath, [
      "-c",
      "user.name=Submerge",
      "-c",
      "user.email=submerge@localhost",
      "commit",
      "-m",
      "unexpected",
    ]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unexpected local Git state",
    );
  });

  it("fails closed on an un-attested custom.txt commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    writeFileSync(join(repositoryPath, "custom.txt"), "manual history\n", { mode: 0o600 });
    git(repositoryPath, ["add", "--", "custom.txt"]);
    git(repositoryPath, [
      "-c",
      "user.name=Submerge",
      "-c",
      "user.email=submerge@localhost",
      "commit",
      "-m",
      "unexpected",
    ]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unexpected local Git state",
    );
  });

  it("rejects delete-and-recreate history even when commit messages imitate Submerge", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    git(repositoryPath, ["rm", "--", "custom.txt"]);
    git(repositoryPath, [
      "-c",
      "user.name=Submerge",
      "-c",
      "user.email=submerge@localhost",
      "commit",
      "-m",
      "Update managed domain rules",
      "-m",
      "Submerge-Operation-Id: forged-delete",
    ]);
    writeFileSync(
      join(repositoryPath, "custom.txt"),
      "# BEGIN SUBMERGE MANAGED\napi.service.example\n# END SUBMERGE MANAGED\n",
      { mode: 0o600 },
    );
    git(repositoryPath, ["add", "--", "custom.txt"]);
    git(repositoryPath, [
      "-c",
      "user.name=Submerge",
      "-c",
      "user.email=submerge@localhost",
      "commit",
      "-m",
      "Update managed domain rules",
      "-m",
      "Submerge-Operation-Id: forged-recreate",
    ]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unexpected local Git state",
    );
  });

  it("fails closed when the worktree is dirty", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    writeFileSync(join(repositoryPath, "custom.txt"), "manual change\n", { mode: 0o600 });

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unexpected local Git state",
    );
  });

  it("fails closed on extra worktree files hidden by a repository ignore file", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    writeFileSync(join(repositoryPath, ".gitignore"), "*\n", { mode: 0o600 });
    writeFileSync(join(repositoryPath, "hidden.txt"), "hidden\n", { mode: 0o600 });
    expect(git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unexpected local Git state",
    );
  });

  it("fails closed instead of repairing an insecure repository mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o770);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local domain-rule repository",
    );
    expect(statSync(repositoryPath).mode & 0o777).toBe(0o770);
  });

  it("fails closed instead of repairing an insecure custom.txt mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const customPath = join(repositoryPath, "custom.txt");
    writeFileSync(customPath, "", { mode: 0o666 });
    chmodSync(customPath, 0o666);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local domain-rule repository",
    );
    expect(statSync(customPath).mode & 0o777).toBe(0o666);
  });

  it("fails closed on a symlinked custom.txt and on invalid UTF-8", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const outsidePath = join(root, "outside.txt");
    writeFileSync(outsidePath, "outside.example\n", { mode: 0o600 });
    symlinkSync(outsidePath, join(repositoryPath, "custom.txt"));

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local domain-rule repository",
    );

    unlinkSync(join(repositoryPath, "custom.txt"));
    writeFileSync(join(repositoryPath, "custom.txt"), Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "invalid domain-rule list encoding",
    );
  });

  it("fails closed when existing Git metadata is not private", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const gitPath = join(repositoryPath, ".git");
    chmodSync(gitPath, 0o770);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local domain-rule repository",
    );
    expect(statSync(gitPath).mode & 0o777).toBe(0o770);
  });

  it("does not create custom.txt inside an existing repository that is missing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    git(repositoryPath, ["init", "--initial-branch=main"]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unexpected local Git state",
    );
    expect(() => statSync(join(repositoryPath, "custom.txt"))).toThrow();
  });

  it("fails closed on unknown local config and worktree config", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    git(repositoryPath, ["config", "user.name", "Unexpected"]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );

    git(repositoryPath, ["config", "--unset-all", "user.name"]);
    git(repositoryPath, ["config", "extensions.worktreeConfig", "true"]);
    writeFileSync(
      join(repositoryPath, ".git", "config.worktree"),
      "[core]\n\thooksPath = hooks\n",
      {
        mode: 0o600,
      },
    );
    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("bounds local config entries before reading per-key values", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    for (let index = 0; index < 10; index += 1) {
      git(repositoryPath, ["config", "--add", "core.ignorecase", "true"]);
    }

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("fails closed on content transforms and repository-local attributes", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    git(repositoryPath, ["config", "core.autocrlf", "true"]);

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );

    git(repositoryPath, ["config", "--unset-all", "core.autocrlf"]);
    writeFileSync(join(repositoryPath, ".gitattributes"), "custom.txt filter=unsafe\n", {
      mode: 0o600,
    });
    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });

  it("fails closed when excludes can hide files or extra refs exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    writeFileSync(join(repositoryPath, ".git", "info", "exclude"), "*\n", { mode: 0o600 });
    writeFileSync(join(repositoryPath, "hidden.txt"), "hidden\n", { mode: 0o600 });

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );

    unlinkSync(join(repositoryPath, "hidden.txt"));
    writeFileSync(join(repositoryPath, ".git", "info", "exclude"), "", { mode: 0o600 });
    git(repositoryPath, ["tag", "unexpected"]);
    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  }, 15_000);

  it("fails closed on shallow, grafted, or replaced history", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const shallowPath = join(repositoryPath, ".git", "shallow");
    writeFileSync(shallowPath, `${baseline.head}\n`, { mode: 0o600 });
    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );

    unlinkSync(shallowPath);
    writeFileSync(join(repositoryPath, ".git", "info", "grafts"), `${baseline.head}\n`, {
      mode: 0o600,
    });
    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );

    unlinkSync(join(repositoryPath, ".git", "info", "grafts"));
    mkdirSync(join(repositoryPath, ".git", "refs", "replace"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(repositoryPath, ".git", "refs", "replace", baseline.head),
      `${baseline.head}\n`,
      {
        mode: 0o600,
      },
    );
    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  }, 15_000);

  it("uses the trusted Git binary instead of an ambient PATH entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const fakeBin = join(root, "bin");
    const markerPath = join(root, "fake-git-ran");
    mkdirSync(repositoryPath, { mode: 0o700 });
    mkdirSync(fakeBin, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\nexit 42\n`, {
      mode: 0o700,
    });
    chmodSync(fakeGit, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      await expect(provisionLocalRuleRepository(repositoryPath)).resolves.toMatchObject({
        baselineCreated: true,
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(() => statSync(markerPath)).toThrow();
  });

  it("honours cancellation before provisioning mutates the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const controller = new AbortController();
    controller.abort();

    await expect(
      provisionLocalRuleRepository(repositoryPath, { signal: controller.signal }),
    ).rejects.toThrow(/abort/iu);
    expect(() => statSync(join(repositoryPath, "custom.txt"))).toThrow();
    expect(() => statSync(join(repositoryPath, ".git"))).toThrow();
  });

  it("rejects a repository redirected through a parent outside the trusted data directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const redirectedParent = join(root, "redirected");
    const repositoryPath = join(redirectedParent, "repository");
    mkdirSync(repositoryPath, { recursive: true, mode: 0o700 });
    chmodSync(redirectedParent, 0o700);
    chmodSync(repositoryPath, 0o700);
    const symlinkedParent = join(root, "rules");
    symlinkSync(redirectedParent, symlinkedParent);

    await expect(
      provisionLocalRuleRepositoryImpl(join(symlinkedParent, "repository"), {
        trustedParentPath: root,
      } as ProvisionOptions),
    ).rejects.toThrow("unsafe local domain-rule repository");
    expect(() => statSync(join(repositoryPath, "custom.txt"))).toThrow();
  });

  it("rejects a safe sibling instead of treating it as the dedicated repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const siblingPath = join(root, "safe-sibling");
    mkdirSync(siblingPath, { mode: 0o700 });
    chmodSync(siblingPath, 0o700);

    await expect(
      provisionLocalRuleRepositoryImpl(siblingPath, {
        trustedParentPath: root,
      } as ProvisionOptions),
    ).rejects.toThrow("unsafe local domain-rule repository");
    expect(() => statSync(join(siblingPath, "custom.txt"))).toThrow();
    expect(() => statSync(join(root, ".safe-sibling.submerge.lock"))).toThrow();
  });

  it("rejects the dedicated repository when it is reached through a parent symlink alias", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const trustedParentPath = join(root, "domain-rules");
    const repositoryPath = join(trustedParentPath, "repository");
    const aliasPath = join(root, "alias");
    mkdirSync(trustedParentPath, { mode: 0o700 });
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(trustedParentPath, 0o700);
    chmodSync(repositoryPath, 0o700);
    symlinkSync(trustedParentPath, aliasPath);

    await expect(
      provisionLocalRuleRepositoryImpl(join(aliasPath, "repository"), {
        trustedParentPath,
      } as ProvisionOptions),
    ).rejects.toThrow("unsafe local domain-rule repository");
    expect(() => statSync(join(repositoryPath, "custom.txt"))).toThrow();
    expect(() => statSync(join(trustedParentPath, ".repository.submerge.lock"))).toThrow();
  });

  it("fails closed while another process owns the repository lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const lockPath = join(root, `.${basename(repositoryPath)}.submerge.lock`);
    writeFileSync(lockPath, "held\n", { mode: 0o600 });

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "local domain-rule repository is busy",
    );
    expect(() => statSync(join(repositoryPath, "custom.txt"))).toThrow();
  });

  it("recovers a stale publisher lock and known Git lock files after validating the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    const gitLockPath = join(repositoryPath, ".git", "index.lock");
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });
    writeFileSync(gitLockPath, "", { mode: 0o644 });

    await expect(
      recoverStaleLocalRuleRepositoryLock(repositoryPath, (pid) => {
        expect(pid).toBe(4242);
        return false;
      }),
    ).resolves.toBe(true);

    expect(() => statSync(publisherLockPath)).toThrow();
    expect(() => statSync(gitLockPath)).toThrow();
    await expect(provisionLocalRuleRepository(repositoryPath)).resolves.toMatchObject({
      baselineCreated: false,
      head: baseline.head,
    });
  });

  it("recovers a known Git lock even when the cooperative parent lock is already absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const gitLockPath = join(repositoryPath, ".git", "index.lock");
    writeFileSync(gitLockPath, "", { mode: 0o644 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).resolves.toBe(
      true,
    );
    expect(() => statSync(gitLockPath)).toThrow();
    await expect(provisionLocalRuleRepository(repositoryPath)).resolves.toMatchObject({
      baselineCreated: false,
    });
  });

  it("restores HEAD and index authority after a crash before the ref CAS", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const customPath = join(repositoryPath, "custom.txt");
    const original = readFileSync(customPath, "utf8");
    const interrupted = updateManagedDomainRules(original, ["api.service.example"]).content;
    writeFileSync(customPath, interrupted);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    const temporaryIndexPath = join(
      repositoryPath,
      ".git",
      "submerge-index-4242-12345678-1234-1234-1234-123456789abc",
    );
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });
    writeFileSync(temporaryIndexPath, readFileSync(join(repositoryPath, ".git", "index")), {
      mode: 0o644,
    });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).resolves.toBe(
      true,
    );
    expect(git(repositoryPath, ["rev-parse", "HEAD"]).trim()).toBe(baseline.head);
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
    expect(readFileSync(customPath, "utf8")).toBe(original);
    expect(() => statSync(temporaryIndexPath)).toThrow();
  });

  it("retains recovery evidence when the repaired state fails full attestation", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const customPath = join(repositoryPath, "custom.txt");
    const original = readFileSync(customPath, "utf8");
    const interrupted = updateManagedDomainRules(original, ["api.service.example"]).content;
    const tampered = updateManagedDomainRules(original, ["tampered.service.example"]).content;
    writeFileSync(customPath, interrupted);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    const temporaryIndexPath = join(
      repositoryPath,
      ".git",
      "submerge-index-4242-12345678-1234-1234-1234-123456789abc",
    );
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });
    writeFileSync(temporaryIndexPath, readFileSync(join(repositoryPath, ".git", "index")), {
      mode: 0o644,
    });

    await expect(
      recoverStaleLocalRuleRepositoryLockImpl(repositoryPath, {
        testAfterRecoveryRepair: () => writeFileSync(customPath, tampered),
        testProcessAlive: () => false,
        trustedParentPath: root,
      } as RecoveryOptions),
    ).rejects.toThrow("unexpected local Git state");

    expect(readFileSync(publisherLockPath, "utf8")).toBe("4242\n");
    expect(statSync(temporaryIndexPath).isFile()).toBe(true);
    expect(readFileSync(customPath, "utf8")).toBe(tampered);
  });

  it("rebuilds the index from the attested HEAD after a crash following the ref CAS", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const committed = await commitManagedDomainRules({
      expectedParent: baseline.head,
      operationId: "op-post-cas-crash",
      repositoryPath,
      rules: ["api.service.example"],
    });
    const committedContent = readFileSync(join(repositoryPath, "custom.txt"), "utf8");
    git(repositoryPath, ["read-tree", baseline.head]);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).resolves.toBe(
      true,
    );
    expect(git(repositoryPath, ["rev-parse", "HEAD"]).trim()).toBe(committed.head);
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
    expect(readFileSync(join(repositoryPath, "custom.txt"), "utf8")).toBe(committedContent);
  });

  it("removes a known interrupted rule-file write after attesting HEAD", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const temporaryRulePath = join(
      repositoryPath,
      "custom.txt.4242.12345678-1234-1234-1234-123456789abc.tmp",
    );
    writeFileSync(temporaryRulePath, "partial", { mode: 0o600 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).resolves.toBe(
      true,
    );
    expect(() => statSync(temporaryRulePath)).toThrow();
    expect(git(repositoryPath, ["rev-parse", "HEAD"]).trim()).toBe(baseline.head);
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
  });

  it("keeps all state in place when HEAD, index, and worktree disagree", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const committed = await commitManagedDomainRules({
      expectedParent: baseline.head,
      operationId: "op-three-way-recovery",
      repositoryPath,
      rules: ["head.service.example"],
    });
    const customPath = join(repositoryPath, "custom.txt");
    const headContent = readFileSync(customPath, "utf8");
    const worktreeContent = updateManagedDomainRules(headContent, [
      "worktree.service.example",
    ]).content;
    writeFileSync(customPath, worktreeContent);
    git(repositoryPath, ["read-tree", baseline.head]);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).rejects.toThrow(
      "unexpected local Git state",
    );
    expect(git(repositoryPath, ["rev-parse", "HEAD"]).trim()).toBe(committed.head);
    expect(readFileSync(customPath, "utf8")).toBe(worktreeContent);
    expect(readFileSync(publisherLockPath, "utf8")).toBe("4242\n");
  });

  it("does not recover a lock owned by a live process", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => true)).rejects.toThrow(
      "local domain-rule repository is busy",
    );
    expect(readFileSync(publisherLockPath, "utf8")).toBe("4242\n");
  });

  it("supports explicit offline recovery after the operator stops the service", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    writeFileSync(publisherLockPath, "1\n", { mode: 0o600 });

    await expect(
      recoverStaleLocalRuleRepositoryLockImpl(repositoryPath, {
        operatorConfirmedStopped: true,
        testProcessAlive: () => {
          throw new Error("offline recovery must not inspect a recycled container PID");
        },
        trustedParentPath: root,
      }),
    ).resolves.toBe(true);
    expect(() => statSync(publisherLockPath)).toThrow();
  });

  it("rejects an unknown Git lock instead of deleting it during stale-lock recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    const unknownLockPath = join(repositoryPath, ".git", "unexpected.lock");
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });
    writeFileSync(unknownLockPath, "unknown\n", { mode: 0o600 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).rejects.toThrow(
      "unsafe local Git",
    );
    expect(readFileSync(publisherLockPath, "utf8")).toBe("4242\n");
    expect(readFileSync(unknownLockPath, "utf8")).toBe("unknown\n");
  });

  it("rejects a publisher-like temporary index with an unknown name", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const unknownIndexPath = join(repositoryPath, ".git", "submerge-index-not-owned");
    writeFileSync(unknownIndexPath, "unknown\n", { mode: 0o600 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).rejects.toThrow(
      "unsafe local Git recovery artifact",
    );
    expect(readFileSync(unknownIndexPath, "utf8")).toBe("unknown\n");
  });

  it("rejects a writable known Git lock during stale-lock recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    const gitLockPath = join(repositoryPath, ".git", "index.lock");
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });
    writeFileSync(gitLockPath, "", { mode: 0o660 });
    chmodSync(gitLockPath, 0o660);

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).rejects.toThrow(
      "unsafe local Git lock",
    );
    expect(statSync(gitLockPath).mode & 0o777).toBe(0o660);
    expect(readFileSync(publisherLockPath, "utf8")).toBe("4242\n");
  });

  it("cleans an interrupted staging repository and can retry baseline provisioning", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);

    await expect(
      provisionLocalRuleRepository(repositoryPath, { testFailpoint: "after-staging-init" }),
    ).rejects.toThrow("injected local publisher failure");
    expect(() => statSync(join(repositoryPath, ".git"))).toThrow();
    expect(statSync(join(repositoryPath, "custom.txt")).mode & 0o777).toBe(0o600);
    expect(() => statSync(join(root, ".repository.submerge-init"))).toThrow();
    expect(() => statSync(join(root, ".repository.submerge.lock"))).toThrow();

    await expect(provisionLocalRuleRepository(repositoryPath)).resolves.toMatchObject({
      baselineCreated: true,
    });
  });

  it.each([
    ["after-seed-create", "seeded"],
    ["after-baseline-config", "configured"],
    ["after-baseline-index", "indexed"],
    ["after-baseline-commit", "committed"],
    ["after-baseline-install", "installed"],
  ] as const)(
    "recovers the exact %s baseline crash state without changing seeded bytes",
    async (testFailpoint, phase) => {
      const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
      temporaryDirectories.push(root);
      const repositoryPath = join(root, "repository");
      const stagingPath = join(root, ".repository.submerge-init");
      const customPath = join(repositoryPath, "custom.txt");
      const publisherLockPath = join(root, ".repository.submerge.lock");
      const seededContent = "# maintained by the operator\n+.legacy.example\n";
      mkdirSync(repositoryPath, { mode: 0o700 });
      chmodSync(repositoryPath, 0o700);
      writeFileSync(customPath, seededContent, { mode: 0o600 });

      await expect(provisionLocalRuleRepository(repositoryPath, { testFailpoint })).rejects.toThrow(
        "injected local publisher failure",
      );
      expect(readFileSync(customPath, "utf8")).toBe(seededContent);
      expect(statSync(publisherLockPath).isFile()).toBe(true);

      if (phase === "seeded") {
        expect(() => statSync(stagingPath)).toThrow();
        expect(() => statSync(join(repositoryPath, ".git"))).toThrow();
      } else if (phase === "configured") {
        expect(git(stagingPath, ["config", "--local", "core.autocrlf"]).trim()).toBe("false");
        expect(() => statSync(join(stagingPath, ".git", "index"))).toThrow();
      } else if (phase === "indexed") {
        expect(statSync(join(stagingPath, ".git", "index")).isFile()).toBe(true);
        expect(git(stagingPath, ["show", ":custom.txt"])).toBe(seededContent);
      } else if (phase === "committed") {
        expect(git(stagingPath, ["show", "HEAD:custom.txt"])).toBe(seededContent);
        expect(() => statSync(join(repositoryPath, ".git"))).toThrow();
      } else {
        expect(git(repositoryPath, ["show", "HEAD:custom.txt"])).toBe(seededContent);
        expect(() => statSync(join(stagingPath, ".git"))).toThrow();
      }

      await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).resolves.toBe(
        true,
      );
      expect(readFileSync(customPath, "utf8")).toBe(seededContent);
      expect(() => statSync(stagingPath)).toThrow();
      expect(() => statSync(publisherLockPath)).toThrow();

      const provisioned = await provisionLocalRuleRepository(repositoryPath);
      expect(provisioned.baselineCreated).toBe(phase !== "installed");
      expect(readFileSync(customPath, "utf8")).toBe(seededContent);
      expect(git(repositoryPath, ["show", "HEAD:custom.txt"])).toBe(seededContent);
    },
  );

  it("fsyncs both sides of the baseline Git rename before the installed checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const durabilityTrace: string[] = [];

    await expect(
      provisionLocalRuleRepository(repositoryPath, {
        testDurabilityTrace: (event) => durabilityTrace.push(event),
        testFailpoint: "after-baseline-install",
      }),
    ).rejects.toThrow("injected local publisher failure");

    expect(durabilityTrace).toEqual([
      "baseline-git-renamed",
      "baseline-staging-fsynced",
      "baseline-repository-fsynced",
      "baseline-parent-fsynced",
      "baseline-install-checkpoint",
    ]);
  });

  it("recovers an attested baseline-init crash without losing the seeded rule list", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const stagingPath = join(root, ".repository.submerge-init");
    const customPath = join(repositoryPath, "custom.txt");
    const seededContent = "# maintained by the operator\n+.legacy.example\n";
    mkdirSync(repositoryPath, { mode: 0o700 });
    mkdirSync(stagingPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    chmodSync(stagingPath, 0o700);
    writeFileSync(customPath, seededContent, { mode: 0o600 });
    createInterruptedBaselineStaging(stagingPath, seededContent);
    const publisherLockPath = join(root, ".repository.submerge.lock");
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).resolves.toBe(
      true,
    );
    expect(readFileSync(customPath, "utf8")).toBe(seededContent);
    expect(() => statSync(stagingPath)).toThrow();
    expect(() => statSync(publisherLockPath)).toThrow();
    expect(() => statSync(join(repositoryPath, ".git"))).toThrow();

    await expect(provisionLocalRuleRepository(repositoryPath)).resolves.toMatchObject({
      baselineCreated: true,
    });
    expect(readFileSync(customPath, "utf8")).toBe(seededContent);
    expect(git(repositoryPath, ["show", "HEAD:custom.txt"])).toBe(seededContent);
  });

  it("retains a malformed baseline staging tree and its stale-lock evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const stagingPath = join(root, ".repository.submerge-init");
    const customPath = join(repositoryPath, "custom.txt");
    const seededContent = "# maintained by the operator\n+.legacy.example\n";
    mkdirSync(repositoryPath, { mode: 0o700 });
    mkdirSync(stagingPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    chmodSync(stagingPath, 0o700);
    writeFileSync(customPath, seededContent, { mode: 0o600 });
    createInterruptedBaselineStaging(stagingPath, seededContent);
    writeFileSync(join(stagingPath, "unknown-artifact"), "unknown\n", { mode: 0o600 });
    const publisherLockPath = join(root, ".repository.submerge.lock");
    writeFileSync(publisherLockPath, "4242\n", { mode: 0o600 });

    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).rejects.toThrow(
      "unsafe local baseline staging state",
    );
    expect(readFileSync(customPath, "utf8")).toBe(seededContent);
    expect(statSync(stagingPath).isDirectory()).toBe(true);
    expect(readFileSync(join(stagingPath, "unknown-artifact"), "utf8")).toBe("unknown\n");
    expect(readFileSync(publisherLockPath, "utf8")).toBe("4242\n");
    expect(() => statSync(join(repositoryPath, ".git"))).toThrow();
  });

  it("fails closed on an unattested staging tree before provisioning", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const stagingPath = join(root, ".repository.submerge-init");
    mkdirSync(repositoryPath, { mode: 0o700 });
    mkdirSync(join(stagingPath, "nested"), { recursive: true, mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    chmodSync(stagingPath, 0o700);
    chmodSync(join(stagingPath, "nested"), 0o700);
    writeFileSync(join(stagingPath, "nested", "partial"), "interrupted\n", { mode: 0o600 });

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unexpected local Git state",
    );
    expect(readFileSync(join(stagingPath, "nested", "partial"), "utf8")).toBe("interrupted\n");
    expect(() => statSync(join(repositoryPath, "custom.txt"))).toThrow();
    expect(() => statSync(join(root, ".repository.submerge.lock"))).toThrow();
  });

  it("fails closed on a staging tree beside an existing repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    const stagingPath = join(root, ".repository.submerge-init");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    mkdirSync(stagingPath, { mode: 0o700 });
    chmodSync(stagingPath, 0o700);
    writeFileSync(join(stagingPath, "custom.txt"), "post-rename crash\n", { mode: 0o600 });

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unexpected local Git state",
    );
    expect(readFileSync(join(stagingPath, "custom.txt"), "utf8")).toBe("post-rename crash\n");
  });

  it("sanitizes Git failures without attaching command output", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    writeFileSync(join(repositoryPath, ".git", "config"), "[broken secret-cookie\n", {
      mode: 0o600,
    });

    const error = await provisionLocalRuleRepository(repositoryPath).catch((caught: unknown) =>
      caught instanceof Error ? caught : new Error("unexpected rejection"),
    );
    expect(error.message).toBe("local Git command failed");
    expect(error).toMatchObject({
      name: "LocalGitCommandError",
      stage: "config",
      reason: "exit",
    });
    expect(error).toHaveProperty("exitCode", expect.any(Number));
    expect(error).not.toHaveProperty("stdout");
    expect(error).not.toHaveProperty("stderr");
    expect(JSON.stringify(error)).not.toContain("secret-cookie");
  });

  it("rejects an oversized Git exclude file before reading it into publisher state", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    await provisionLocalRuleRepository(repositoryPath);
    writeFileSync(
      join(repositoryPath, ".git", "info", "exclude"),
      Buffer.alloc(1024 * 1024 + 1, "x"),
    );

    await expect(provisionLocalRuleRepository(repositoryPath)).rejects.toThrow(
      "unsafe local Git configuration",
    );
  });
});

describe("commitManagedDomainRules", () => {
  it("creates one attested local commit without configuring or contacting a remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    writeFileSync(join(repositoryPath, "custom.txt"), "# operator\n+.legacy.example\n", {
      mode: 0o600,
    });
    const baseline = await provisionLocalRuleRepository(repositoryPath);

    const result = await commitManagedDomainRules({
      expectedParent: baseline.head,
      operationId: "op-20260804-001",
      repositoryPath,
      rules: ["api.service.example", "+.service.example"],
    });

    expect(result.changed).toBe(true);
    expect(result.parent).toBe(baseline.head);
    expect(result.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.head).not.toBe(baseline.head);
    expect(git(repositoryPath, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
    expect(git(repositoryPath, ["show", "-s", "--format=%B", "HEAD"])).toContain(
      "Submerge-Operation-Id: op-20260804-001",
    );
    expect(git(repositoryPath, ["diff", "--check", `${baseline.head}..${result.head}`])).toBe("");
    expect(git(repositoryPath, ["remote"])).toBe("");
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
    expect(readFileSync(join(repositoryPath, "custom.txt"), "utf8")).toBe(
      "# operator\n+.legacy.example\n# BEGIN SUBMERGE MANAGED\n+.service.example\napi.service.example\n# END SUBMERGE MANAGED\n",
    );
  });

  it("rejects reuse of an operation ID already attested in history", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const first = await commitManagedDomainRules({
      expectedParent: baseline.head,
      operationId: "op-duplicate",
      repositoryPath,
      rules: ["one.service.example"],
    });

    await expect(
      commitManagedDomainRules({
        expectedParent: first.head,
        operationId: "op-duplicate",
        repositoryPath,
        rules: ["two.service.example"],
      }),
    ).rejects.toThrow("duplicate domain-rule operation ID");
    expect(git(repositoryPath, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
  });

  it("restores the clean worktree when preparation fails before the ref CAS", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const customPath = join(repositoryPath, "custom.txt");
    const original = readFileSync(customPath, "utf8");
    await expect(
      commitManagedDomainRules({
        expectedParent: baseline.head,
        operationId: "op-fails-before-cas",
        repositoryPath,
        rules: ["api.service.example"],
        testFailpoint: "after-worktree-write",
      }),
    ).rejects.toThrow("injected local publisher failure");

    expect(git(repositoryPath, ["rev-parse", "HEAD"]).trim()).toBe(baseline.head);
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
    expect(readFileSync(customPath, "utf8")).toBe(original);
  });

  it("retains recovery evidence when the worktree rename result is not yet durable", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const customPath = join(repositoryPath, "custom.txt");
    const original = readFileSync(customPath, "utf8");
    const publisherLockPath = join(root, ".repository.submerge.lock");

    await expect(
      commitManagedDomainRules({
        expectedParent: baseline.head,
        operationId: "op-worktree-rename-crash",
        repositoryPath,
        rules: ["api.service.example"],
        testFailpoint: "after-worktree-rename",
      }),
    ).rejects.toThrow("injected local publisher failure");

    expect(statSync(publisherLockPath).isFile()).toBe(true);
    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).resolves.toBe(
      true,
    );
    expect(git(repositoryPath, ["rev-parse", "HEAD"]).trim()).toBe(baseline.head);
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
    expect(readFileSync(customPath, "utf8")).toBe(original);
    expect(() => statSync(publisherLockPath)).toThrow();
  });

  it("retains recovery evidence after the ref CAS and completes from authoritative HEAD", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);
    const publisherLockPath = join(root, ".repository.submerge.lock");

    await expect(
      commitManagedDomainRules({
        expectedParent: baseline.head,
        operationId: "op-post-cas-finalization-crash",
        repositoryPath,
        rules: ["api.service.example"],
        testFailpoint: "after-ref-update-committed",
      }),
    ).rejects.toThrow("injected local publisher failure");

    expect(statSync(publisherLockPath).isFile()).toBe(true);
    const committedHead = git(repositoryPath, ["rev-parse", "HEAD"]).trim();
    expect(committedHead).not.toBe(baseline.head);
    await expect(recoverStaleLocalRuleRepositoryLock(repositoryPath, () => false)).resolves.toBe(
      true,
    );
    expect(git(repositoryPath, ["rev-parse", "HEAD"]).trim()).toBe(committedHead);
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
    expect(readFileSync(join(repositoryPath, "custom.txt"), "utf8")).toContain(
      "api.service.example",
    );
    expect(() => statSync(publisherLockPath)).toThrow();
  });

  it("finishes the commit when update-ref succeeded but its command result is ambiguous", async () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-local-rules-"));
    temporaryDirectories.push(root);
    const repositoryPath = join(root, "repository");
    mkdirSync(repositoryPath, { mode: 0o700 });
    chmodSync(repositoryPath, 0o700);
    const baseline = await provisionLocalRuleRepository(repositoryPath);

    const result = await commitManagedDomainRules({
      expectedParent: baseline.head,
      operationId: "op-ambiguous-cas",
      repositoryPath,
      rules: ["api.service.example"],
      testFailpoint: "after-ref-update-ambiguous",
    });

    expect(result.changed).toBe(true);
    expect(result.parent).toBe(baseline.head);
    expect(git(repositoryPath, ["rev-parse", "HEAD"]).trim()).toBe(result.head);
    expect(git(repositoryPath, ["status", "--porcelain=v1"])).toBe("");
    expect(readFileSync(join(repositoryPath, "custom.txt"), "utf8")).toContain(
      "api.service.example",
    );
  });
});
