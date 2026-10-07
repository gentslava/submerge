import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attestLocalDomainRuleOperationState,
  commitPreparedDomainRuleMutation,
  DOMAIN_RULE_DIRECTORY_PATH,
  MANAGED_RULES_BEGIN,
  MANAGED_RULES_END,
  prepareLocalDomainRuleMutationIntent,
  provisionLocalDomainRuleStore,
  ruleStorePaths,
  updateManagedDomainRules,
} from "./rule-store.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "submerge-rule-store-"));
  chmodSync(root, 0o700);
  const ruleDirectoryPath = join(root, "domain-rules");
  return { ruleDirectoryPath, root };
}

describe("plain local domain rule store", () => {
  it("resolves the code-owned production mount below a root-owned parent", () => {
    expect(ruleStorePaths(DOMAIN_RULE_DIRECTORY_PATH).ruleFilePath).toBe(
      "/domain-rules/custom.txt",
    );
  });

  it("provisions a valid empty canonical file without a Git repository", async () => {
    const { ruleDirectoryPath } = fixture();

    const state = await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    const paths = ruleStorePaths(ruleDirectoryPath);

    expect(state).toMatchObject({ baselineCreated: true, contentSha256: sha256(state.content) });
    expect(state.content).toBe(`${MANAGED_RULES_BEGIN}\n${MANAGED_RULES_END}\n`);
    expect(readFileSync(paths.ruleFilePath, "utf8")).toBe(state.content);
    expect(paths.ruleFilePath.endsWith("/domain-rules/custom.txt")).toBe(true);
  });

  it("preserves unrelated bytes and deterministically updates only the managed block", () => {
    const original = `# operator line\n+.existing.example\n${MANAGED_RULES_BEGIN}\nold.example\n${MANAGED_RULES_END}\n`;

    const first = updateManagedDomainRules(original, ["+.service.example", "api.example"]);
    const replay = updateManagedDomainRules(first.content, ["api.example", "+.service.example"]);

    expect(first).toEqual({
      changed: true,
      content:
        `# operator line\n+.existing.example\n${MANAGED_RULES_BEGIN}\n` +
        `+.service.example\napi.example\n${MANAGED_RULES_END}\n`,
    });
    expect(replay).toEqual({ changed: false, content: first.content });
  });

  it("prepares and atomically writes an attested digest transition", async () => {
    const { ruleDirectoryPath } = fixture();
    await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    const intent = await prepareLocalDomainRuleMutationIntent({
      ruleDirectoryPath,
      upsertRules: ["+.service.example"],
      deleteRules: [],
    });

    const written = await commitPreparedDomainRuleMutation({
      ruleDirectoryPath,
      operationId: "manual-add-1",
      expectedSourceRevision: intent.expectedSourceRevision,
      intendedContentSha256: intent.intendedContentSha256,
      upsertRules: ["+.service.example"],
      deleteRules: [],
    });

    expect(written).toMatchObject({
      changed: true,
      previousRevision: intent.expectedSourceRevision,
      contentSha256: intent.intendedContentSha256,
    });
    await expect(
      attestLocalDomainRuleOperationState({
        ruleDirectoryPath,
        expectedSourceRevision: intent.expectedSourceRevision,
        intendedContentSha256: intent.intendedContentSha256,
        operationId: "manual-add-1",
      }),
    ).resolves.toMatchObject({
      state: "written",
      previousRevision: intent.expectedSourceRevision,
      contentSha256: intent.intendedContentSha256,
    });
  });

  it("fails closed when another writer changes the canonical file after preparation", async () => {
    const { ruleDirectoryPath } = fixture();
    await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    const intent = await prepareLocalDomainRuleMutationIntent({
      ruleDirectoryPath,
      upsertRules: ["+.service.example"],
      deleteRules: [],
    });
    const { ruleFilePath } = ruleStorePaths(ruleDirectoryPath);
    writeFileSync(
      ruleFilePath,
      `${MANAGED_RULES_BEGIN}\nexternal.example\n${MANAGED_RULES_END}\n`,
      { mode: 0o600 },
    );

    await expect(
      commitPreparedDomainRuleMutation({
        ruleDirectoryPath,
        operationId: "manual-add-raced",
        expectedSourceRevision: intent.expectedSourceRevision,
        intendedContentSha256: intent.intendedContentSha256,
        upsertRules: ["+.service.example"],
        deleteRules: [],
      }),
    ).rejects.toThrow("local domain-rule source changed");
    expect(readFileSync(ruleFilePath, "utf8")).toContain("external.example");
  });

  it("rejects an unsafe group-writable rule directory", async () => {
    const { ruleDirectoryPath, root } = fixture();
    const directory = join(root, "domain-rules");
    mkdirSync(directory, { mode: 0o770 });
    chmodSync(directory, 0o770);

    await expect(provisionLocalDomainRuleStore({ ruleDirectoryPath })).rejects.toThrow(
      "unsafe local domain-rule directory",
    );
  });

  it("never removes a stale-looking lock while the service is online", async () => {
    const { ruleDirectoryPath } = fixture();
    await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    const { lockFilePath } = ruleStorePaths(ruleDirectoryPath);
    writeFileSync(lockFilePath, "999999:interrupted\n", { mode: 0o600 });
    const staleAt = new Date(Date.now() - 60_000);
    utimesSync(lockFilePath, staleAt, staleAt);

    await expect(provisionLocalDomainRuleStore({ ruleDirectoryPath })).rejects.toThrow(
      "local domain-rule store is locked",
    );
    expect(readFileSync(lockFilePath, "utf8")).toBe("999999:interrupted\n");
  });

  it("fails closed while another writer holds a fresh lock", async () => {
    const { ruleDirectoryPath } = fixture();
    await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    const { lockFilePath } = ruleStorePaths(ruleDirectoryPath);
    writeFileSync(lockFilePath, "999999:active-writer\n", { mode: 0o600 });

    await expect(provisionLocalDomainRuleStore({ ruleDirectoryPath })).rejects.toThrow(
      "local domain-rule store is locked",
    );
    expect(readFileSync(lockFilePath, "utf8")).toBe("999999:active-writer\n");
  });

  it("rejects rule directories and files readable by another uid", async () => {
    const { ruleDirectoryPath } = fixture();
    mkdirSync(ruleDirectoryPath, { mode: 0o755 });
    chmodSync(ruleDirectoryPath, 0o755);
    await expect(provisionLocalDomainRuleStore({ ruleDirectoryPath })).rejects.toThrow(
      "unsafe local domain-rule directory",
    );

    chmodSync(ruleDirectoryPath, 0o700);
    await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    const { ruleFilePath } = ruleStorePaths(ruleDirectoryPath);
    chmodSync(ruleFilePath, 0o644);
    await expect(provisionLocalDomainRuleStore({ ruleDirectoryPath })).rejects.toThrow(
      "unsafe local domain-rule file",
    );
  });

  it("fails closed when an interrupted atomic-write artifact remains", async () => {
    const { ruleDirectoryPath } = fixture();
    await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    writeFileSync(
      join(ruleDirectoryPath, ".custom.txt.submerge-42-manual-add-1-deadbeef.tmp"),
      "unpublished content\n",
      { mode: 0o600 },
    );

    await expect(provisionLocalDomainRuleStore({ ruleDirectoryPath })).rejects.toThrow(
      "interrupted local domain-rule write requires reconciliation",
    );
  });

  it("does not recreate a missing file after the store was already provisioned", async () => {
    const { ruleDirectoryPath } = fixture();
    await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    const { ruleFilePath } = ruleStorePaths(ruleDirectoryPath);
    unlinkSync(ruleFilePath);

    await expect(
      provisionLocalDomainRuleStore({ ruleDirectoryPath, allowCreateBaseline: false }),
    ).rejects.toMatchObject({ reason: "local-store-migration-required" });
  });

  it("rejects invalid UTF-8 without rewriting unrelated bytes", async () => {
    const { ruleDirectoryPath } = fixture();
    await provisionLocalDomainRuleStore({ ruleDirectoryPath });
    const { ruleFilePath } = ruleStorePaths(ruleDirectoryPath);
    const invalid = Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]);
    writeFileSync(ruleFilePath, invalid, { mode: 0o600 });

    await expect(provisionLocalDomainRuleStore({ ruleDirectoryPath })).rejects.toMatchObject({
      reason: "local-store-unsafe",
    });
    expect(readFileSync(ruleFilePath)).toEqual(invalid);
  });
});
