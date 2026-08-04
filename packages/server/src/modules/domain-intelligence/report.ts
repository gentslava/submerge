import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type DomainCandidateList,
  type DomainCandidateListInput,
  type DomainCandidateReportItem,
  type DomainIntelligenceOverview,
  type DomainIntelligenceSettingsView,
  domainCandidateListSchema,
  domainCandidateReportItemSchema,
  domainIntelligenceApplyReadinessSchema,
  domainIntelligenceOverviewSchema,
  domainIntelligenceSettingsViewSchema,
} from "@submerge/shared";
import { z } from "zod";

const MAX_REPORT_CANDIDATES = 4_096;
const REPORT_PAGE_SIZE = 100;
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const reportObserverSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      health: domainIntelligenceOverviewSchema.shape.health,
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.literal("live-health-unavailable"),
    })
    .strict(),
]);

export const domainIntelligenceReportSchema = z
  .object({
    version: z.literal(1),
    generatedAt: domainIntelligenceOverviewSchema.shape.generatedAt,
    period: domainIntelligenceOverviewSchema.shape.period,
    configurationRevision: hashSchema,
    configurationState: domainIntelligenceSettingsViewSchema.shape.configurationState,
    observer: reportObserverSchema,
    counts: z
      .object({
        daily: domainIntelligenceOverviewSchema.shape.dailyAggregates,
        lifecycle: domainIntelligenceOverviewSchema.shape.candidateCounts,
        buckets: domainIntelligenceOverviewSchema.shape.bucketCounts,
        evidenceIntegrity: domainIntelligenceOverviewSchema.shape.evidenceIntegrityCounts,
        exclusions: domainIntelligenceOverviewSchema.shape.exclusionCounts,
      })
      .strict(),
    candidates: z.array(domainCandidateReportItemSchema).max(MAX_REPORT_CANDIDATES),
    applyReadiness: domainIntelligenceApplyReadinessSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (report.generatedAt !== report.period.to) {
      context.addIssue({ code: "custom", message: "report period does not match generation time" });
    }
    if (
      report.counts.buckets.candidate + report.counts.buckets.exclusion !==
      report.candidates.length
    ) {
      context.addIssue({ code: "custom", message: "report candidates do not match bucket counts" });
    }
  });

export type DomainIntelligenceReport = z.infer<typeof domainIntelligenceReportSchema>;

export interface BuildDomainIntelligenceReportInput {
  settingsView: DomainIntelligenceSettingsView;
  overview: DomainIntelligenceOverview;
  candidates: readonly DomainCandidateReportItem[];
  observer?: z.input<typeof reportObserverSchema>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function configurationRevision(view: DomainIntelligenceSettingsView): string {
  return `sha256:${createHash("sha256")
    .update(stableJson({ configurationState: view.configurationState, settings: view.settings }))
    .digest("hex")}`;
}

export function buildDomainIntelligenceReport(
  input: BuildDomainIntelligenceReportInput,
): DomainIntelligenceReport {
  const settingsView = domainIntelligenceSettingsViewSchema.parse(input.settingsView);
  const overview = domainIntelligenceOverviewSchema.parse(input.overview);
  const candidates = z
    .array(domainCandidateReportItemSchema)
    .max(MAX_REPORT_CANDIDATES)
    .parse(input.candidates);
  return domainIntelligenceReportSchema.parse({
    version: 1,
    generatedAt: overview.generatedAt,
    period: overview.period,
    configurationRevision: configurationRevision(settingsView),
    configurationState: settingsView.configurationState,
    observer: input.observer ?? { available: true, health: overview.health },
    counts: {
      daily: overview.dailyAggregates,
      lifecycle: overview.candidateCounts,
      buckets: overview.bucketCounts,
      evidenceIntegrity: overview.evidenceIntegrityCounts,
      exclusions: overview.exclusionCounts,
    },
    candidates,
    applyReadiness: settingsView.deployment.apply,
  });
}

export type DomainCandidatePageReader = (
  input: DomainCandidateListInput,
) => DomainCandidateList | Promise<DomainCandidateList>;

export type DomainCandidateSyncPageReader = (
  input: DomainCandidateListInput,
) => DomainCandidateList;

interface DomainCandidatePaginationState {
  items: DomainCandidateReportItem[];
  seen: Set<string>;
  cursor?: string;
}

function readNextCandidatePage(
  state: DomainCandidatePaginationState,
  pageInput: DomainCandidateList,
): string | null {
  const page = domainCandidateListSchema.parse(pageInput);
  if (page.nextCursor !== null && state.cursor !== undefined && page.nextCursor <= state.cursor) {
    throw new Error("candidate report cursor did not advance");
  }
  if (page.items.length === 0 && page.nextCursor !== null) {
    throw new Error("candidate report returned an empty non-terminal page");
  }
  for (const item of page.items) {
    if (state.seen.has(item.fqdn)) throw new Error("candidate report contains a duplicate domain");
    state.seen.add(item.fqdn);
    state.items.push(item);
    if (state.items.length > MAX_REPORT_CANDIDATES) {
      throw new Error("candidate report exceeds the protected artifact limit");
    }
  }
  return page.nextCursor;
}

function candidatePageInput(cursor: string | undefined): DomainCandidateListInput {
  return { view: "all", limit: REPORT_PAGE_SIZE, ...(cursor ? { cursor } : {}) };
}

export async function paginateDomainCandidateReport(
  readPage: DomainCandidatePageReader,
): Promise<DomainCandidateReportItem[]> {
  const state: DomainCandidatePaginationState = { items: [], seen: new Set() };
  for (;;) {
    const nextCursor = readNextCandidatePage(
      state,
      await readPage(candidatePageInput(state.cursor)),
    );
    if (nextCursor === null) return state.items;
    state.cursor = nextCursor;
  }
}

export function paginateDomainCandidateReportSync(
  readPage: DomainCandidateSyncPageReader,
): DomainCandidateReportItem[] {
  const state: DomainCandidatePaginationState = { items: [], seen: new Set() };
  for (;;) {
    const nextCursor = readNextCandidatePage(state, readPage(candidatePageInput(state.cursor)));
    if (nextCursor === null) return state.items;
    state.cursor = nextCursor;
  }
}

function formatAttempt(attempt: DomainCandidateReportItem["latestAttempts"]["direct"]): string {
  if (!attempt) return "нет данных";
  const result =
    attempt.category === "http_response" ? `HTTP ${attempt.httpStatus ?? "—"}` : attempt.category;
  const origin = attempt.finalOrigin ? `, ${attempt.finalOrigin}` : "";
  return `${result}, ${attempt.totalDurationMs} мс${origin}`;
}

function candidateReason(item: DomainCandidateReportItem): string {
  if (item.exclusionReason) return item.exclusionReason;
  if (item.decision?.reasons.length) return item.decision.reasons.join(", ");
  return item.status;
}

export function renderDomainIntelligenceMarkdown(report: DomainIntelligenceReport): string {
  const parsed = domainIntelligenceReportSchema.parse(report);
  const lines = [
    "# Domain intelligence report",
    "",
    `Generated: ${new Date(parsed.generatedAt).toISOString()}`,
    `Period: ${new Date(parsed.period.from).toISOString()} — ${new Date(parsed.period.to).toISOString()}`,
    `Configuration: ${parsed.configurationState}, ${parsed.configurationRevision}`,
    parsed.observer.available
      ? `Observer: ${parsed.observer.health.status} (${parsed.observer.health.reason})`
      : `Observer: unavailable (${parsed.observer.reason})`,
    `Candidates: ${parsed.counts.buckets.candidate}; exclusions: ${parsed.counts.buckets.exclusion}`,
    parsed.applyReadiness.available
      ? "Apply: available (private local repository)"
      : `Apply: unavailable (${parsed.applyReadiness.reason})`,
    "",
    "## Domains",
    "",
  ];
  if (parsed.candidates.length === 0) {
    lines.push("No candidates or exclusions in the report period.");
  } else {
    for (const item of parsed.candidates) {
      lines.push(
        `- **${item.fqdn}** — reason: ${candidateReason(item)}; rule: ${
          item.proposedRule ? `\`${item.proposedRule}\`` : "none"
        }; scope: ${item.selectedScope ?? "none"}; DIRECT: ${formatAttempt(
          item.latestAttempts.direct,
        )}; PROXY: ${formatAttempt(item.latestAttempts.proxy)}.`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function assertProtectedDirectory(directory: string): string {
  const target = resolve(directory);
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("report destination must be a real directory");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("report destination must be owner-only");
  }
  return target;
}

function pathIsSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function atomicWrite(path: string, content: string): void {
  if (pathIsSymbolicLink(path)) {
    throw new Error("report artifact cannot replace a symbolic link");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function writeDomainIntelligenceReportArtifacts(
  directory: string,
  report: DomainIntelligenceReport,
): { json: string; markdown: string } {
  const target = assertProtectedDirectory(directory);
  const parsed = domainIntelligenceReportSchema.parse(report);
  const json = join(target, "domain-intelligence-report.json");
  const markdown = join(target, "domain-intelligence-report.md");
  atomicWrite(json, `${JSON.stringify(parsed, null, 2)}\n`);
  atomicWrite(markdown, renderDomainIntelligenceMarkdown(parsed));
  return { json, markdown };
}
