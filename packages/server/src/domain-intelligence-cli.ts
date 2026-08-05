import { pathToFileURL } from "node:url";
import type { DomainDecisionReason, DomainProbeCategory } from "@submerge/shared";
import type { MihomoConnection } from "./clients/mihomo.js";
import type { Db } from "./db/client.js";
import { observationFromConnection } from "./modules/domain-intelligence/observer.js";
import {
  buildDomainIntelligenceReport,
  type DomainIntelligenceReport,
  paginateDomainCandidateReportSync,
  writeDomainIntelligenceReportArtifacts,
} from "./modules/domain-intelligence/report.js";
import type { DomainValidationExecution } from "./modules/domain-intelligence/scheduler.js";
import type { DueDomainCandidate } from "./modules/domain-intelligence/service.js";

type DomainIntelligenceCliAction = "collect-snapshot" | "validate" | "report";

export interface DomainIntelligenceCliOptions {
  action: DomainIntelligenceCliAction;
  dryRun: boolean;
  outputDir?: string;
}

type DomainIntelligenceCliErrorCode = "invalid-arguments" | "dry-run-required";

const cliErrorMessages: Record<DomainIntelligenceCliErrorCode, string> = {
  "invalid-arguments": "invalid domain intelligence arguments",
  "dry-run-required": "diagnostic command requires --dry-run",
};

export class DomainIntelligenceCliError extends Error {
  constructor(
    readonly code: DomainIntelligenceCliErrorCode,
    message: string = cliErrorMessages[code],
  ) {
    super(message);
    this.name = "DomainIntelligenceCliError";
  }
}

export interface DomainCollectionDryRunResult {
  action: "collect-snapshot";
  dryRun: true;
  snapshotAt: number;
  connectionCount: number;
  eligibleObservationCount: number;
}

export interface DomainValidationDryRunResult {
  action: "validate";
  dryRun: true;
  observerHealth: "unavailable";
  candidateAvailable: boolean;
  decisionStatus: "confirmed" | "pending" | "blocked" | null;
  decisionReasons: DomainDecisionReason[];
  directCategory: DomainProbeCategory | null;
  proxyCategory: DomainProbeCategory | null;
}

export interface DomainIntelligenceCliDeps {
  collectSnapshotDryRun: () => Promise<DomainCollectionDryRunResult>;
  validateDryRun: () => Promise<DomainValidationDryRunResult>;
  readReport: () => Promise<DomainIntelligenceReport>;
  writeReportArtifacts: (
    directory: string,
    report: DomainIntelligenceReport,
  ) => { json: string; markdown: string };
  writeStdout: (value: string) => void;
}

export function parseDomainIntelligenceCliArgs(
  argv: readonly string[],
): DomainIntelligenceCliOptions {
  const actions: DomainIntelligenceCliAction[] = [];
  let dryRun = false;
  let outputDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--collect" || argument === "--collect-snapshot") {
      actions.push("collect-snapshot");
    } else if (argument === "--validate") {
      actions.push("validate");
    } else if (argument === "--report") {
      actions.push("report");
    } else if (argument === "--dry-run") {
      if (dryRun) {
        throw new DomainIntelligenceCliError("invalid-arguments", "--dry-run was provided twice");
      }
      dryRun = true;
    } else if (argument === "--output-dir") {
      if (outputDir !== undefined) {
        throw new DomainIntelligenceCliError(
          "invalid-arguments",
          "--output-dir was provided twice",
        );
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new DomainIntelligenceCliError("invalid-arguments", "--output-dir requires a path");
      }
      outputDir = value;
      index += 1;
    } else {
      throw new DomainIntelligenceCliError("invalid-arguments");
    }
  }
  if (actions.length > 1) {
    throw new DomainIntelligenceCliError("invalid-arguments", "choose exactly one action");
  }
  const action = actions[0] ?? "report";
  if ((action === "collect-snapshot" || action === "validate") && !dryRun) {
    throw new DomainIntelligenceCliError("dry-run-required", `${action} requires --dry-run`);
  }
  if (outputDir !== undefined && action !== "report") {
    throw new DomainIntelligenceCliError(
      "invalid-arguments",
      "--output-dir is available only with --report",
    );
  }
  return { action, dryRun, ...(outputDir === undefined ? {} : { outputDir }) };
}

function writeSummary(deps: DomainIntelligenceCliDeps, value: unknown): void {
  deps.writeStdout(`${JSON.stringify(value)}\n`);
}

export async function runDomainIntelligenceCli(
  argv: readonly string[],
  deps: DomainIntelligenceCliDeps,
): Promise<void> {
  const options = parseDomainIntelligenceCliArgs(argv);
  if (options.action === "collect-snapshot") {
    writeSummary(deps, await deps.collectSnapshotDryRun());
    return;
  }
  if (options.action === "validate") {
    writeSummary(deps, await deps.validateDryRun());
    return;
  }

  const report = await deps.readReport();
  const artifacts = options.outputDir
    ? deps.writeReportArtifacts(options.outputDir, report)
    : undefined;
  writeSummary(deps, {
    action: "report",
    dryRun: options.dryRun,
    generatedAt: report.generatedAt,
    candidateCount: report.candidates.length,
    artifactsWritten: artifacts !== undefined,
  });
}

export async function collectDomainSnapshotDryRun(
  fetchConnections: () => Promise<MihomoConnection[]>,
  now: () => number = Date.now,
): Promise<DomainCollectionDryRunResult> {
  const connections = await fetchConnections();
  const snapshotAt = now();
  let eligibleObservationCount = 0;
  for (const connection of connections) {
    if (observationFromConnection(connection, snapshotAt)) eligibleObservationCount += 1;
  }
  return {
    action: "collect-snapshot",
    dryRun: true,
    snapshotAt,
    connectionCount: connections.length,
    eligibleObservationCount,
  };
}

interface DomainValidationDryRunDeps {
  readDueCandidates: (input: { now: number; limit: number }) => DueDomainCandidate[];
  execute: (
    candidate: DueDomainCandidate,
    signal: AbortSignal,
  ) => Promise<DomainValidationExecution>;
  now?: () => number;
}

export async function validateDomainCandidateDryRun(
  deps: DomainValidationDryRunDeps,
): Promise<DomainValidationDryRunResult> {
  const now = deps.now?.() ?? Date.now();
  const candidate = deps.readDueCandidates({ now, limit: 1 })[0];
  if (!candidate) {
    return {
      action: "validate",
      dryRun: true,
      observerHealth: "unavailable",
      candidateAvailable: false,
      decisionStatus: null,
      decisionReasons: [],
      directCategory: null,
      proxyCategory: null,
    };
  }
  const execution = await deps.execute(candidate, new AbortController().signal);
  return {
    action: "validate",
    dryRun: true,
    observerHealth: "unavailable",
    candidateAvailable: true,
    decisionStatus: execution.decision.value.status,
    decisionReasons: [...execution.decision.value.reasons],
    directCategory: execution.attempts[0]?.result.category ?? null,
    proxyCategory: execution.attempts[1]?.result.category ?? null,
  };
}

export function createCliValidationExecutor<Database, Executor>(
  db: Database,
  factory: (database: Database, observationHealthy: () => boolean) => Executor,
): Executor {
  return factory(db, () => false);
}

export type DomainIntelligenceReportSnapshotService = Pick<
  typeof import("./modules/domain-intelligence/service.js"),
  | "getDomainIntelligenceSettingsView"
  | "getDomainIntelligenceOverview"
  | "readDomainIntelligenceFilterPolicy"
  | "listDomainCandidateReport"
>;

export function readDomainIntelligenceReportSnapshot(
  db: Db,
  service: DomainIntelligenceReportSnapshotService,
  generatedAt: number = Date.now(),
): DomainIntelligenceReport {
  return db.transaction((transaction) => {
    // These report readers issue only SELECTs. The transaction type intentionally omits
    // nested transaction methods, so expose it through the narrower runtime-compatible DB API.
    const snapshot = transaction as unknown as Db;
    const settingsView = service.getDomainIntelligenceSettingsView(snapshot);
    const overview = service.getDomainIntelligenceOverview(snapshot, {
      now: generatedAt,
      health: {
        status: "inactive",
        reason: "disabled",
        snapshotDomainConnections: 0,
        correlatedConnections: 0,
        updatedAt: generatedAt,
      },
    });
    const filterPolicy = service.readDomainIntelligenceFilterPolicy(snapshot);
    const candidates = paginateDomainCandidateReportSync((input) =>
      service.listDomainCandidateReport(snapshot, input, filterPolicy),
    );
    return buildDomainIntelligenceReport({
      settingsView,
      overview,
      candidates,
      observer: { available: false, reason: "live-health-unavailable" },
    });
  });
}

function createProductionCliDeps(): DomainIntelligenceCliDeps {
  const readState = async () => {
    const [database, production, service] = await Promise.all([
      import("./db/read-only.js"),
      import("./modules/domain-intelligence/production.js"),
      import("./modules/domain-intelligence/service.js"),
    ]);
    const db = database.createReadOnlyDb();
    const executor = createCliValidationExecutor(
      db,
      production.createProductionDomainValidationExecutor,
    );
    return { db, executor, service };
  };
  let state: ReturnType<typeof readState> | undefined;
  const loadState = () => (state ??= readState());
  return {
    collectSnapshotDryRun: async () => {
      const mihomo = await import("./clients/mihomo.js");
      return collectDomainSnapshotDryRun(() => mihomo.getConnections());
    },
    validateDryRun: async () => {
      const { db, executor, service } = await loadState();
      return validateDomainCandidateDryRun({
        readDueCandidates: (input) => service.listDueDomainCandidates(db, input),
        execute: (candidate, signal) => executor.execute(candidate, signal),
      });
    },
    readReport: async () => {
      const { db, service } = await loadState();
      return readDomainIntelligenceReportSnapshot(db, service);
    },
    writeReportArtifacts: writeDomainIntelligenceReportArtifacts,
    writeStdout: (value) => process.stdout.write(value),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  parseDomainIntelligenceCliArgs(argv);
  const deps = createProductionCliDeps();
  await runDomainIntelligenceCli(argv, deps);
}

export function formatDomainIntelligenceCliError(error: unknown): string {
  if (error instanceof DomainIntelligenceCliError) return error.message;
  return "domain intelligence command failed";
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${formatDomainIntelligenceCliError(error)}\n`);
    process.exitCode = 1;
  });
}
