import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  channelPool,
  channels,
  domainAutomaticBudgets,
  domainAutomaticConsents,
  domainCandidates,
  domainDailyStats,
  domainDecisions,
  domainObservations,
  domainRuleOperations,
  domainRuleOwnership,
  domainValidationAttempts,
  domainValidationRuns,
  settings,
  sources,
} from "./schema.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

function migrationsThrough(lastIndex: number, name: string): string {
  const folder = mkdtempSync(join(tmpdir(), `submerge-${name}-`));
  mkdirSync(join(folder, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  for (let index = 0; index <= lastIndex; index++) {
    const prefix = `${String(index).padStart(4, "0")}_`;
    const entry = journal.entries.find((candidate) => candidate.idx === index);
    if (!entry?.tag.startsWith(prefix)) throw new Error(`missing migration ${prefix}`);
    copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({
      ...journal,
      entries: journal.entries.filter((entry) => entry.idx <= lastIndex),
    }),
  );
  return folder;
}

const preDirectMigrationsFolder = () => migrationsThrough(6, "pre-direct");
const preRefreshMigrationsFolder = () => migrationsThrough(7, "pre-refresh");
const preDomainMigrationsFolder = () => migrationsThrough(8, "pre-domain");
const preDomainEvidenceMigrationsFolder = () => migrationsThrough(9, "pre-domain-evidence");
const preDomainReviewMigrationsFolder = () => migrationsThrough(10, "pre-domain-review");
const preDomainApplyMigrationsFolder = () => migrationsThrough(11, "pre-domain-apply");

describe("db", () => {
  it("creates and reads a source in an in-memory DB", () => {
    // Use :memory: so the test never touches the filesystem.
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

    db.insert(sources).values({ kind: "sub", value: "https://x", label: "X" }).run();

    const rows = db.select().from(sources).where(eq(sources.kind, "sub")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
    expect(rows[0]?.hwid).toBe(false);
    expect(rows[0]?.proxies).toEqual([]);
  });

  it("adds refresh state without damaging an existing source row", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: preRefreshMigrationsFolder() });
    const meta = JSON.stringify({ used: null, total: null, expire: null, updateHours: 6 });
    testDb.$client
      .prepare(
        "INSERT INTO sources (kind, value, sub_url, label, hwid, enabled, sort_order, proxies, meta, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "sub",
        "https://provider.example/sub",
        "https://provider.example/sub",
        "Existing",
        1,
        0,
        7,
        "[]",
        meta,
        "2026-07-20 10:00:00",
        "2026-07-19 09:00:00",
      );

    migrate(testDb, { migrationsFolder });

    const row = testDb.select().from(sources).get();
    expect(row).toMatchObject({
      kind: "sub",
      value: "https://provider.example/sub",
      subUrl: "https://provider.example/sub",
      label: "Existing",
      hwid: true,
      enabled: false,
      sortOrder: 7,
      proxies: [],
      meta: { used: null, total: null, expire: null, updateHours: 6 },
      updatedAt: "2026-07-20 10:00:00",
      createdAt: "2026-07-19 09:00:00",
      lastRefreshAttemptAt: null,
      lastRefreshSuccessAt: null,
      nextRefreshAttemptAt: null,
      refreshFailures: 0,
      lastRefreshError: null,
    });

    testDb
      .update(sources)
      .set({
        lastRefreshAttemptAt: 100,
        lastRefreshSuccessAt: 90,
        nextRefreshAttemptAt: 200,
        refreshFailures: 2,
        lastRefreshError: "timeout",
      })
      .run();
    expect(testDb.select().from(sources).get()).toMatchObject({
      lastRefreshAttemptAt: 100,
      lastRefreshSuccessAt: 90,
      nextRefreshAttemptAt: 200,
      refreshFailures: 2,
      lastRefreshError: "timeout",
    });
  });

  it("has a channels table after migrations", () => {
    const testDb = createDb(":memory:");
    // Apply migrations against the in-memory db the same way runMigrations does.
    migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    expect(() => testDb.select().from(channels).all()).not.toThrow();
  });

  it("has a channel_pool table after migrations", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    expect(() => testDb.select().from(channelPool).all()).not.toThrow();
  });

  it("adds domain observation tables without changing existing application rows", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: preDomainMigrationsFolder() });
    testDb
      .insert(sources)
      .values({ kind: "sub", value: "https://provider.example/sub", label: "Existing" })
      .run();
    testDb.insert(settings).values({ key: "existing", value: "preserved" }).run();

    migrate(testDb, { migrationsFolder });

    expect(testDb.select().from(sources).get()).toMatchObject({
      kind: "sub",
      value: "https://provider.example/sub",
      label: "Existing",
    });
    expect(testDb.select().from(settings).get()).toEqual({
      key: "existing",
      value: "preserved",
    });
    expect(testDb.select().from(domainObservations).all()).toEqual([]);
    expect(testDb.select().from(domainDailyStats).all()).toEqual([]);
    expect(testDb.$client.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("adds domain evidence tables without changing existing observations or application rows", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: preDomainEvidenceMigrationsFolder() });
    testDb
      .insert(sources)
      .values({ kind: "sub", value: "https://provider.example/sub", label: "Existing" })
      .run();
    testDb.insert(settings).values({ key: "existing", value: "preserved" }).run();
    testDb
      .insert(domainObservations)
      .values({
        fingerprint: "existing-observation",
        fqdn: "api.service.example",
        observedAt: 100,
        lastSeenAt: 100,
        transport: "tcp",
        source: "mihomo-log",
        count: 1,
      })
      .run();
    testDb
      .insert(domainDailyStats)
      .values({
        day: "1970-01-01",
        fqdn: "api.service.example",
        connectionCount: 1,
        firstSeenAt: 100,
        lastSeenAt: 100,
      })
      .run();

    migrate(testDb, { migrationsFolder });

    expect(testDb.select().from(sources).get()?.label).toBe("Existing");
    expect(testDb.select().from(settings).get()).toEqual({
      key: "existing",
      value: "preserved",
    });
    expect(testDb.select().from(domainObservations).get()?.fingerprint).toBe(
      "existing-observation",
    );
    expect(testDb.select().from(domainDailyStats).get()?.connectionCount).toBe(1);
    expect(testDb.select().from(domainCandidates).all()).toEqual([]);
    expect(testDb.select().from(domainValidationRuns).all()).toEqual([]);
    expect(testDb.select().from(domainValidationAttempts).all()).toEqual([]);
    expect(testDb.select().from(domainDecisions).all()).toEqual([]);
    expect(testDb.$client.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("adds an active review state to existing domain candidates without changing evidence", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: preDomainReviewMigrationsFolder() });
    testDb.$client
      .prepare(
        "INSERT INTO domain_candidates (fqdn, registrable_site, selected_scope, proposed_rule, exclusion_reason, status, first_seen_at, last_seen_at, next_validation_at, last_validation_at, failure_streak, lease_id, lease_until, lease_generation, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "api.service.example",
        "service.example",
        "site",
        "+.service.example",
        null,
        "pending",
        100,
        200,
        300,
        250,
        0,
        null,
        null,
        1,
        250,
      );
    testDb.$client
      .prepare(
        "INSERT INTO domain_decisions (id, fqdn, evaluated_at, status, confidence, reasons, window_start, evidence, selected_scope, proposed_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "existing-review-decision",
        "api.service.example",
        250,
        "pending",
        "low",
        JSON.stringify(["insufficient-direct-failures"]),
        100,
        JSON.stringify({
          directQualifyingFailures: 1,
          directSpacedFailures: 1,
          directAddressDiversityRequired: false,
          directAddressDiversitySatisfied: true,
          proxyHttpSuccesses: 1,
          proxyTransportFailures: 0,
          proxyUncertainFailures: 0,
        }),
        "site",
        "+.service.example",
      );

    migrate(testDb, { migrationsFolder });

    expect(
      testDb.$client
        .prepare("SELECT review_state FROM domain_candidates WHERE fqdn = ?")
        .get("api.service.example"),
    ).toEqual({ review_state: "active" });
    expect(testDb.select().from(domainDecisions).get()).toMatchObject({
      id: "existing-review-decision",
      fqdn: "api.service.example",
      selectedScope: "site",
      proposedRule: "+.service.example",
    });
    expect(() =>
      testDb.$client
        .prepare("UPDATE domain_candidates SET review_state = 'invalid' WHERE fqdn = ?")
        .run("api.service.example"),
    ).toThrow(/check constraint/i);
    expect(testDb.$client.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("adds the domain apply journal without changing existing candidates or application rows", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: preDomainApplyMigrationsFolder() });
    testDb
      .insert(sources)
      .values({ kind: "sub", value: "https://provider.example/sub", label: "Existing" })
      .run();
    testDb.insert(settings).values({ key: "existing", value: "preserved" }).run();
    testDb
      .insert(domainCandidates)
      .values({
        fqdn: "api.service.example",
        registrableSite: "service.example",
        selectedScope: "site",
        proposedRule: "+.service.example",
        status: "confirmed",
        reviewState: "active",
        firstSeenAt: 100,
        lastSeenAt: 200,
        nextValidationAt: 300,
        lastValidationAt: 200,
        failureStreak: 0,
        leaseId: null,
        leaseUntil: null,
        leaseGeneration: 0,
        updatedAt: 200,
      })
      .run();

    migrate(testDb, { migrationsFolder });

    expect(testDb.select().from(sources).get()?.label).toBe("Existing");
    expect(testDb.select().from(settings).get()).toEqual({
      key: "existing",
      value: "preserved",
    });
    expect(testDb.select().from(domainCandidates).get()).toMatchObject({
      fqdn: "api.service.example",
      status: "confirmed",
      reviewState: "active",
    });
    expect(testDb.select().from(domainRuleOperations).all()).toEqual([]);
    expect(testDb.select().from(domainAutomaticBudgets).all()).toEqual([]);
    expect(testDb.select().from(domainAutomaticConsents).all()).toEqual([]);
    expect(testDb.select().from(domainRuleOwnership).all()).toEqual([]);
    const baseOperation = {
      expectedParentCommit: "1".repeat(40),
      intendedContentSha256: "a".repeat(64),
      proposedRule: "api.service.example",
      ownershipDelta: {
        upserts: [{ rule: "api.service.example", ownership: "manual" as const }],
        deletes: [],
      },
      createdAt: 100,
      updatedAt: 200,
    };
    expect(() =>
      testDb
        .insert(domainRuleOperations)
        .values({
          ...baseOperation,
          id: "invalid-committed",
          idempotencyKey: "invalid-committed",
          action: "manual-add",
          phase: "committed",
        })
        .run(),
    ).toThrow(/phase_commit_check/u);
    expect(() =>
      testDb
        .insert(domainRuleOperations)
        .values({
          ...baseOperation,
          id: "invalid-rollback-target",
          idempotencyKey: "invalid-rollback-target",
          action: "rollback",
          phase: "prepared",
        })
        .run(),
    ).toThrow(/rollback_target_check/u);
    expect(() =>
      testDb
        .insert(domainRuleOperations)
        .values({
          ...baseOperation,
          id: "invalid-half-commit",
          idempotencyKey: "invalid-half-commit",
          action: "manual-add",
          phase: "committed",
          commitSha: "2".repeat(40),
        })
        .run(),
    ).toThrow(/commit_pair_check/u);
    expect(() =>
      testDb
        .insert(domainRuleOperations)
        .values({
          ...baseOperation,
          id: "invalid-completed",
          idempotencyKey: "invalid-completed",
          action: "manual-add",
          phase: "completed",
          commitSha: "2".repeat(40),
          committedContentSha256: "a".repeat(64),
          activationStatus: "succeeded",
          activationAttemptCount: 1,
          lastActivationAttemptAt: 200,
        })
        .run(),
    ).toThrow(/completion_check/u);
    expect(() =>
      testDb
        .insert(domainRuleOperations)
        .values({
          ...baseOperation,
          id: "invalid-activation-time",
          idempotencyKey: "invalid-activation-time",
          action: "manual-add",
          phase: "partial",
          commitSha: "2".repeat(40),
          committedContentSha256: "a".repeat(64),
          activationStatus: "failed",
          activationAttemptCount: 1,
          lastActivationAttemptAt: 50,
          activationErrorCategory: "route-proof-failure",
        })
        .run(),
    ).toThrow(/timestamp_check/u);
    expect(() =>
      testDb
        .insert(domainRuleOperations)
        .values({
          ...baseOperation,
          id: "invalid-failed-reason",
          idempotencyKey: "invalid-failed-reason",
          action: "manual-add",
          phase: "partial",
          commitSha: "2".repeat(40),
          committedContentSha256: "a".repeat(64),
          activationStatus: "failed",
          activationAttemptCount: 1,
          lastActivationAttemptAt: 200,
        })
        .run(),
    ).toThrow(/activation_shape_check/u);
    expect(() =>
      testDb
        .insert(domainAutomaticConsents)
        .values({
          id: "invalid-consent",
          revision: `domain-auto-v1:sha256:${"z".repeat(64)}`,
          enabledAt: 100,
          revokedAt: null,
        })
        .run(),
    ).toThrow(/revision_check/u);
    testDb
      .insert(domainAutomaticConsents)
      .values({
        id: "active-consent",
        revision: `domain-auto-v1:sha256:${"a".repeat(64)}`,
        enabledAt: 100,
        revokedAt: null,
      })
      .run();
    expect(() =>
      testDb
        .insert(domainAutomaticConsents)
        .values({
          id: "second-active-consent",
          revision: `domain-auto-v1:sha256:${"b".repeat(64)}`,
          enabledAt: 100,
          revokedAt: null,
        })
        .run(),
    ).toThrow(/unique/u);
    expect(testDb.$client.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("upgrades the real pre-Direct schema without losing channels or pool rows", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: preDirectMigrationsFolder() });

    const policy = JSON.stringify({ kind: "manual", pinnedNode: "A", onFailure: "hold" });
    const matcher = JSON.stringify({
      presets: ["youtube"],
      domains: ["example.com"],
      keywords: [],
      ruleProviders: [],
      geosite: [],
      geoip: [],
      cidrs: ["10.0.0.0/8"],
    });
    const insertLegacy = testDb.$client.prepare(
      "INSERT INTO channels (id, name, priority, enabled, is_default, policy, matcher, last_reason, last_reason_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertLegacy.run("default", "Default", 7, 1, 1, policy, matcher, "default reason", 100);
    insertLegacy.run("ch-a", "A", -3, 1, 0, policy, matcher, "reason a", 101);
    insertLegacy.run("ch-b", "B", -3, 0, 0, policy, matcher, null, null);
    const insertPool = testDb.$client.prepare(
      "INSERT INTO channel_pool (channel_id, kind, ref) VALUES (?, ?, ?)",
    );
    insertPool.run("ch-a", "source", "1");
    insertPool.run("ch-a", "node", "NL-1");
    insertPool.run("ch-b", "node", "DE-1");

    migrate(testDb, { migrationsFolder });

    expect(
      testDb.$client
        .prepare(
          "SELECT id, name, priority, enabled, is_default, target, policy, matcher, last_reason, last_reason_at, direct_presets FROM channels ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "ch-a",
        name: "A",
        priority: -3,
        enabled: 1,
        is_default: 0,
        target: "proxy",
        policy,
        matcher,
        last_reason: "reason a",
        last_reason_at: 101,
        direct_presets: null,
      },
      {
        id: "ch-b",
        name: "B",
        priority: -3,
        enabled: 0,
        is_default: 0,
        target: "proxy",
        policy,
        matcher,
        last_reason: null,
        last_reason_at: null,
        direct_presets: null,
      },
      {
        id: "default",
        name: "Default",
        priority: 7,
        enabled: 1,
        is_default: 1,
        target: "proxy",
        policy,
        matcher,
        last_reason: "default reason",
        last_reason_at: 100,
        direct_presets: null,
      },
    ]);
    expect(
      testDb.$client
        .prepare("SELECT channel_id, kind, ref FROM channel_pool ORDER BY channel_id, kind, ref")
        .all(),
    ).toEqual([
      { channel_id: "ch-a", kind: "node", ref: "NL-1" },
      { channel_id: "ch-a", kind: "source", ref: "1" },
      { channel_id: "ch-b", kind: "node", ref: "DE-1" },
    ]);

    expect(() =>
      testDb.$client
        .prepare(
          "INSERT INTO channels (id, name, target, policy, matcher) VALUES ('bad-proxy', 'Bad proxy', 'proxy', NULL, '{}')",
        )
        .run(),
    ).toThrow();

    const insertDirect = testDb.$client.prepare(
      "INSERT INTO channels (id, name, target, is_default, policy, matcher, direct_presets) VALUES (?, ?, 'direct', ?, ?, '{}', ?)",
    );
    expect(() => insertDirect.run("direct-policy", "Direct policy", 0, policy, "{}")).toThrow();
    expect(() => insertDirect.run("direct-default", "Direct default", 1, null, "{}")).toThrow();
    expect(() => insertDirect.run("direct-presets", "Direct presets", 0, null, null)).toThrow();
    insertDirect.run(
      "direct",
      "Direct",
      0,
      null,
      JSON.stringify({ privateNetworks: true, localDomains: true }),
    );
    expect(() =>
      insertDirect.run(
        "direct-2",
        "Direct 2",
        0,
        null,
        JSON.stringify({ privateNetworks: true, localDomains: true }),
      ),
    ).toThrow();

    expect(testDb.$client.pragma("foreign_key_check")).toEqual([]);
    expect(testDb.$client.pragma("foreign_key_list(channel_pool)")).toEqual([
      expect.objectContaining({ table: "channels", from: "channel_id", to: "id" }),
    ]);

    testDb.$client.prepare("DELETE FROM channels WHERE id = 'ch-a'").run();
    expect(
      testDb.$client.prepare("SELECT channel_id FROM channel_pool WHERE channel_id = 'ch-a'").all(),
    ).toEqual([]);
  });
});
