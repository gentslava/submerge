import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainCandidateReportItem,
  type DomainIntelligenceOverview,
  type DomainIntelligenceSettingsView,
} from "@submerge/shared";
import { describe, expect, it } from "vitest";
import {
  buildDomainIntelligenceReport,
  paginateDomainCandidateReport,
  paginateDomainCandidateReportSync,
  renderDomainIntelligenceMarkdown,
  writeDomainIntelligenceReportArtifacts,
} from "./report.js";

const now = Date.parse("2026-08-04T06:00:00.000Z");

function settingsView(): DomainIntelligenceSettingsView {
  return {
    configurationState: "ready",
    settings: {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      defaultRuleScope: "exact",
    },
    deployment: {
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    },
  };
}

function overview(): DomainIntelligenceOverview {
  return {
    generatedAt: now,
    period: { from: now - 13 * 24 * 60 * 60 * 1_000, to: now },
    health: {
      status: "healthy",
      reason: "correlated",
      snapshotDomainConnections: 4,
      correlatedConnections: 4,
      updatedAt: now,
    },
    dailyAggregates: [{ day: "2026-08-04", connectionCount: 4, uniqueDomainCount: 1 }],
    candidateCounts: { queued: 1, pending: 0, confirmed: 0, blocked: 0, excluded: 0 },
    bucketCounts: { candidate: 1, exclusion: 0 },
    evidenceIntegrityCounts: { missingDecisions: 0, invalidDecisions: 0 },
    exclusionCounts: [],
  };
}

function candidate(): DomainCandidateReportItem {
  return {
    fqdn: "api.service.example",
    siteGroup: "service.example",
    bucket: "candidate",
    reviewState: "active",
    status: "queued",
    selectedScope: "exact",
    proposedRule: "api.service.example",
    eligibleScopes: ["exact", "site"],
    scopeValid: true,
    siteUnavailableReason: null,
    exclusionReason: null,
    policyExclusionReason: null,
    firstSeenAt: now - 60_000,
    lastSeenAt: now,
    lastValidationAt: now,
    nextValidationAt: now + 60_000,
    connectionCount: 4,
    evidenceAvailable: false,
    evidenceIntegrityIssue: null,
    decision: null,
    latestAttempts: {
      direct: {
        attemptedAt: now,
        category: "connect_timeout",
        transportSuccess: false,
        httpStatus: null,
        connectDurationMs: 8_000,
        tlsDurationMs: null,
        totalDurationMs: 8_000,
        redirectCount: 0,
        finalOrigin: "https://api.service.example",
      },
      proxy: {
        attemptedAt: now,
        category: "http_response",
        transportSuccess: true,
        httpStatus: 403,
        connectDurationMs: 120,
        tlsDurationMs: 80,
        totalDurationMs: 260,
        redirectCount: 0,
        finalOrigin: "https://api.service.example",
      },
    },
  };
}

describe("domain intelligence report", () => {
  it("builds a versioned, deterministic protected read model", () => {
    const input = { settingsView: settingsView(), overview: overview(), candidates: [candidate()] };
    const first = buildDomainIntelligenceReport(input);
    const second = buildDomainIntelligenceReport(input);

    expect(first).toEqual(second);
    expect(first.version).toBe(1);
    expect(first.configurationRevision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.observer).toEqual({ available: true, health: overview().health });
    expect(first.applyReadiness).toEqual({
      available: false,
      reason: "deployment-report-only",
    });
    expect(first.candidates[0]?.fqdn).toBe("api.service.example");
  });

  it("states when live observer health is unavailable to a separate CLI process", () => {
    const report = buildDomainIntelligenceReport({
      settingsView: settingsView(),
      overview: overview(),
      candidates: [candidate()],
      observer: { available: false, reason: "live-health-unavailable" },
    });

    expect(report.observer).toEqual({
      available: false,
      reason: "live-health-unavailable",
    });
    expect(renderDomainIntelligenceMarkdown(report)).toContain(
      "Observer: unavailable (live-health-unavailable)",
    );
  });

  it("renders the proposed rule and safe A/B evidence without URL paths", () => {
    const report = buildDomainIntelligenceReport({
      settingsView: settingsView(),
      overview: overview(),
      candidates: [candidate()],
    });
    const markdown = renderDomainIntelligenceMarkdown(report);

    expect(markdown).toContain("api.service.example");
    expect(markdown).toContain("connect_timeout");
    expect(markdown).toContain("HTTP 403");
    expect(markdown).toContain("`api.service.example`");
    expect(markdown).not.toContain("?");
    expect(markdown).not.toContain("cookie");
  });

  it("writes JSON and Markdown atomically with owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-domain-report-"));
    chmodSync(directory, 0o700);
    const report = buildDomainIntelligenceReport({
      settingsView: settingsView(),
      overview: overview(),
      candidates: [candidate()],
    });

    const paths = writeDomainIntelligenceReportArtifacts(directory, report);

    expect(JSON.parse(readFileSync(paths.json, "utf8"))).toEqual(report);
    expect(readFileSync(paths.markdown, "utf8")).toContain("# Domain intelligence report");
    expect(statSync(paths.json).mode & 0o777).toBe(0o600);
    expect(statSync(paths.markdown).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).sort()).toEqual([
      "domain-intelligence-report.json",
      "domain-intelligence-report.md",
    ]);
  });

  it("rejects a destination readable by other users", () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-domain-report-public-"));
    chmodSync(directory, 0o755);
    const report = buildDomainIntelligenceReport({
      settingsView: settingsView(),
      overview: overview(),
      candidates: [candidate()],
    });

    expect(() => writeDomainIntelligenceReportArtifacts(directory, report)).toThrow(
      "report destination must be owner-only",
    );
  });

  it("refuses to replace a symbolic-link artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-domain-report-link-"));
    chmodSync(directory, 0o700);
    symlinkSync("outside.json", join(directory, "domain-intelligence-report.json"));
    const report = buildDomainIntelligenceReport({
      settingsView: settingsView(),
      overview: overview(),
      candidates: [candidate()],
    });

    expect(() => writeDomainIntelligenceReportArtifacts(directory, report)).toThrow(
      "report artifact cannot replace a symbolic link",
    );
    expect(readdirSync(directory)).toEqual(["domain-intelligence-report.json"]);
  });

  it("paginates defensively and rejects a repeated cursor", async () => {
    const item = candidate();
    await expect(
      paginateDomainCandidateReport(async ({ cursor }) =>
        cursor
          ? { items: [], nextCursor: null }
          : { items: [item], nextCursor: "api.service.example" },
      ),
    ).resolves.toEqual([item]);

    await expect(
      paginateDomainCandidateReport(async () => ({
        items: [item],
        nextCursor: "api.service.example",
      })),
    ).rejects.toThrow("candidate report cursor did not advance");
  });

  it("paginates synchronously for a single SQLite read transaction", () => {
    const item = candidate();

    expect(
      paginateDomainCandidateReportSync(({ cursor }) =>
        cursor
          ? { items: [], nextCursor: null }
          : { items: [item], nextCursor: "api.service.example" },
      ),
    ).toEqual([item]);

    expect(() =>
      paginateDomainCandidateReportSync(() => ({
        items: [item],
        nextCursor: "api.service.example",
      })),
    ).toThrow("candidate report cursor did not advance");
  });
});
