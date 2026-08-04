import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it, vi } from "vitest";
import type { MihomoConnection } from "./clients/mihomo.js";
import { createDb } from "./db/client.js";
import { createReadOnlyDb } from "./db/read-only.js";
import {
  collectDomainSnapshotDryRun,
  createCliValidationExecutor,
  type DomainIntelligenceCliDeps,
  DomainIntelligenceCliError,
  formatDomainIntelligenceCliError,
  parseDomainIntelligenceCliArgs,
  readDomainIntelligenceReportSnapshot,
  runDomainIntelligenceCli,
  validateDomainCandidateDryRun,
} from "./domain-intelligence-cli.js";
import { fingerprintObservation } from "./modules/domain-intelligence/observer.js";
import type { DomainIntelligenceReport } from "./modules/domain-intelligence/report.js";
import type { DomainValidationExecution } from "./modules/domain-intelligence/scheduler.js";
import {
  type DueDomainCandidate,
  getDomainIntelligenceOverview,
  getDomainIntelligenceSettingsView,
  listDomainCandidateReport,
  queueDomainCandidate,
  readDomainIntelligenceFilterPolicy,
  recordObservation,
  setDomainIntelligenceReportSettings,
} from "./modules/domain-intelligence/service.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const reportNow = Date.parse("2026-08-04T06:00:00.000Z");
const unavailableHealth = {
  status: "inactive" as const,
  reason: "disabled" as const,
  snapshotDomainConnections: 0,
  correlatedConnections: 0,
  updatedAt: reportNow,
};

const report = {
  version: 1,
  generatedAt: 1,
  period: { from: 0, to: 1 },
  configurationRevision: `sha256:${"a".repeat(64)}`,
  configurationState: "ready",
  observer: { available: false, reason: "live-health-unavailable" },
  counts: {
    daily: [],
    lifecycle: { queued: 1, pending: 0, confirmed: 0, blocked: 0, excluded: 0 },
    buckets: { candidate: 1, exclusion: 0 },
    evidenceIntegrity: { missingDecisions: 0, invalidDecisions: 0 },
    exclusions: [],
  },
  candidates: [
    {
      fqdn: "private-report.example",
    },
  ],
  applyReadiness: { available: false, reason: "publisher-unavailable" },
} as unknown as DomainIntelligenceReport;

function deps(): DomainIntelligenceCliDeps {
  return {
    collectSnapshotDryRun: vi.fn(async () => ({
      action: "collect-snapshot",
      dryRun: true,
      snapshotAt: 1,
      connectionCount: 3,
      eligibleObservationCount: 2,
    })),
    validateDryRun: vi.fn(async () => ({
      action: "validate",
      dryRun: true,
      observerHealth: "unavailable",
      candidateAvailable: true,
      decisionStatus: "pending",
      decisionReasons: ["insufficient-direct-failures"],
      directCategory: "connect_timeout",
      proxyCategory: "http_response",
    })),
    readReport: vi.fn(async () => report),
    writeReportArtifacts: vi.fn(() => ({ json: "/safe/report.json", markdown: "/safe/report.md" })),
    writeStdout: vi.fn(),
  };
}

describe("domain intelligence CLI", () => {
  it("defaults to report and accepts the collect alias", () => {
    expect(parseDomainIntelligenceCliArgs([])).toEqual({ action: "report", dryRun: false });
    expect(parseDomainIntelligenceCliArgs(["--collect", "--dry-run"])).toEqual({
      action: "collect-snapshot",
      dryRun: true,
    });
  });

  it("rejects ambiguous actions and mutating diagnostics", () => {
    expect(() => parseDomainIntelligenceCliArgs(["--report", "--validate"])).toThrow(
      "choose exactly one action",
    );
    expect(() => parseDomainIntelligenceCliArgs(["--validate"])).toThrow(
      "validate requires --dry-run",
    );
    expect(() => parseDomainIntelligenceCliArgs(["--collect-snapshot"])).toThrow(
      "collect-snapshot requires --dry-run",
    );
  });

  it("does not echo unexpected error details to stderr", () => {
    expect(
      formatDomainIntelligenceCliError(
        new Error("token=private-secret for api.private-report.example"),
      ),
    ).toBe("domain intelligence command failed");
  });

  it("runs collection through the non-persisting boundary", async () => {
    const services = deps();
    await runDomainIntelligenceCli(["--collect-snapshot", "--dry-run"], services);

    expect(services.collectSnapshotDryRun).toHaveBeenCalledOnce();
    expect(services.validateDryRun).not.toHaveBeenCalled();
    expect(services.readReport).not.toHaveBeenCalled();
    expect(services.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining('"eligibleObservationCount":2'),
    );
  });

  it("writes protected report artifacts only for an explicit destination", async () => {
    const services = deps();
    await runDomainIntelligenceCli(["--report", "--dry-run", "--output-dir", "/safe"], services);

    expect(services.writeReportArtifacts).toHaveBeenCalledWith("/safe", report);
    const stdout = vi.mocked(services.writeStdout).mock.calls.join("\n");
    expect(stdout).toContain('"candidateCount":1');
    expect(stdout).not.toContain("private-report.example");
  });

  it("keeps report stdout free of observed domain names", async () => {
    const services = deps();
    await runDomainIntelligenceCli(["--report", "--dry-run"], services);

    expect(services.writeReportArtifacts).not.toHaveBeenCalled();
    expect(vi.mocked(services.writeStdout).mock.calls.join("\n")).not.toContain(
      "private-report.example",
    );
  });

  it("fails closed for apply until the publisher slice exists", async () => {
    const services = deps();
    await expect(runDomainIntelligenceCli(["--apply", "--dry-run"], services)).rejects.toEqual(
      new DomainIntelligenceCliError("publisher-unavailable"),
    );
    expect(services.collectSnapshotDryRun).not.toHaveBeenCalled();
    expect(services.validateDryRun).not.toHaveBeenCalled();
    expect(services.readReport).not.toHaveBeenCalled();
  });

  it("summarizes a Mihomo snapshot without returning connection or domain identity", async () => {
    const connection = (host: string, id: string): MihomoConnection => ({
      id,
      metadata: {
        network: "tcp",
        host,
        destinationIP: "203.0.113.10",
        destinationPort: "443",
        sourceIP: "192.0.2.10",
        process: "private-process",
      },
      upload: 0,
      download: 0,
      start: "",
      chains: ["private-chain"],
    });

    const result = await collectDomainSnapshotDryRun(
      async () => [
        connection("api.service.example", "private-id"),
        connection("", "another-private-id"),
      ],
      () => 1_000,
    );

    expect(result).toEqual({
      action: "collect-snapshot",
      dryRun: true,
      snapshotAt: 1_000,
      connectionCount: 2,
      eligibleObservationCount: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/service\.example|private-id|private-process/u);
  });

  it("executes one due validation without claiming or persisting the candidate", async () => {
    const candidate: DueDomainCandidate = {
      fqdn: "api.service.example",
      registrableSite: "service.example",
      selectedScope: "exact",
      proposedRule: "api.service.example",
      nextValidationAt: 1,
      failureStreak: 0,
      updatedAt: 1,
    };
    const execute = vi.fn(
      async () =>
        ({
          attempts: [
            { result: { category: "connect_timeout" } },
            { result: { category: "http_response" } },
          ],
          decision: {
            value: { status: "pending", reasons: ["insufficient-direct-failures"] },
          },
        }) as unknown as DomainValidationExecution,
    );
    const readDueCandidates = vi.fn(() => [candidate]);

    const result = await validateDomainCandidateDryRun({
      readDueCandidates,
      execute,
      now: () => 10,
    });

    expect(readDueCandidates).toHaveBeenCalledWith({ now: 10, limit: 1 });
    expect(execute).toHaveBeenCalledWith(candidate, expect.any(AbortSignal));
    expect(result).toEqual({
      action: "validate",
      dryRun: true,
      observerHealth: "unavailable",
      candidateAvailable: true,
      decisionStatus: "pending",
      decisionReasons: ["insufficient-direct-failures"],
      directCategory: "connect_timeout",
      proxyCategory: "http_response",
    });
    expect(JSON.stringify(result)).not.toContain(candidate.fqdn);
  });

  it("wires the separate CLI validator with unavailable observer health", () => {
    const factory = vi.fn((_db: { readonly: true }, observationHealthy: () => boolean) => ({
      observationHealthy,
    }));

    const executor = createCliValidationExecutor({ readonly: true as const }, factory);

    expect(factory).toHaveBeenCalledOnce();
    expect(executor.observationHealthy()).toBe(false);
  });

  it("reads settings, counts, policy, and pages from one SQLite snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-domain-report-snapshot-"));
    const path = join(directory, "submerge.db");
    const writer = createDb(path);
    migrate(writer, { migrationsFolder });
    setDomainIntelligenceReportSettings(writer, {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      defaultRuleScope: "exact",
    });
    const reader = createReadOnlyDb(path);
    let mutated = false;
    const service = {
      getDomainIntelligenceSettingsView: (snapshot: typeof writer) => {
        const view = getDomainIntelligenceSettingsView(snapshot);
        if (!mutated) {
          const filterPolicy = readDomainIntelligenceFilterPolicy(writer);
          if (!filterPolicy) throw new Error("test filter policy is unavailable");
          recordObservation(writer, {
            fqdn: "api.concurrent.example",
            observedAt: reportNow,
            transport: "tcp",
            source: "mihomo-log",
            fingerprint: fingerprintObservation("api.concurrent.example", "tcp", reportNow),
          });
          queueDomainCandidate(writer, {
            fqdn: "api.concurrent.example",
            filterPolicy,
            preferredScope: "exact",
            now: reportNow,
          });
          mutated = true;
        }
        return view;
      },
      getDomainIntelligenceOverview,
      readDomainIntelligenceFilterPolicy,
      listDomainCandidateReport,
    };

    try {
      const report = readDomainIntelligenceReportSnapshot(reader, service, reportNow);

      expect(mutated).toBe(true);
      expect(report.counts.buckets).toEqual({ candidate: 0, exclusion: 0 });
      expect(report.candidates).toEqual([]);
      expect(
        getDomainIntelligenceOverview(writer, {
          now: reportNow,
          health: unavailableHealth,
        }).bucketCounts,
      ).toEqual({ candidate: 1, exclusion: 0 });
    } finally {
      reader.$client.close();
      writer.$client.close();
    }
  });
});
