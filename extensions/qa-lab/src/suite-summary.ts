import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asSafeIntegerInRange, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteArtifactError } from "./errors.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  QA_EVIDENCE_SUMMARY_KIND,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
  type QaEvidenceTiming,
} from "./evidence-summary.js";
import type { QaProviderMode } from "./model-selection.js";
import type { RuntimeId } from "./runtime-id.js";
import type { RuntimeParityResult } from "./runtime-parity.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";

type QaSuiteSummaryScenario = {
  name: string;
  status: "pass" | "fail" | "skip" | "skipped";
  steps: unknown[];
  details?: string;
  timing?: QaEvidenceTiming;
  runtimeParity?: RuntimeParityResult;
};

export type QaSuiteSummaryJson = {
  scenarios: QaSuiteSummaryScenario[];
  counts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  metrics?: {
    wallMs: number;
    gatewayProcessCpuMs?: number | null;
    gatewayCpuCoreRatio?: number | null;
    gatewayProcessRssStartBytes?: number | null;
    gatewayProcessRssEndBytes?: number | null;
    gatewayProcessRssDeltaBytes?: number | null;
    gatewayProcessRssPeakBytes?: number | null;
    gatewayProcessRssPeakDeltaBytes?: number | null;
    gatewayProcessRssSamples?: Array<{
      label: string;
      at: string;
      gatewayProcessRssBytes: number;
    }>;
    gatewayHeapSnapshots?: Array<{
      label: string;
      at: string;
      path: string;
      bytes: number;
    }>;
  };
  evidence?: QaEvidenceSummaryJson;
  run: {
    status: "running" | "completed";
    startedAt: string;
    finishedAt: string;
    providerMode: QaProviderMode;
    primaryModel: string;
    primaryProvider: string | null;
    primaryModelName: string | null;
    alternateModel: string;
    alternateProvider: string | null;
    alternateModelName: string | null;
    fastMode: boolean;
    concurrency: number;
    channelDriver: QaScorecardChannelDriver | null;
    channel: string | null;
    channelCapabilityMatrixPath: string | null;
    channelDriverSmokePath: string | null;
    scenarioIds: string[] | null;
    runtimePair?: [RuntimeId, RuntimeId] | null;
  };
};

type QaSuiteScenarioStatus = {
  status?: unknown;
};
type QaSuiteReportOnlyScenario = {
  name?: unknown;
  status?: unknown;
  details?: unknown;
};
function readQaSuiteEvidenceFacts(summary: Record<string, unknown>) {
  const candidate = isRecord(summary.evidence) ? summary.evidence : summary;
  const evidence =
    candidate.kind === QA_EVIDENCE_SUMMARY_KIND
      ? validateQaEvidenceSummaryJson(candidate)
      : undefined;
  const entries = evidence
    ? getEffectiveQaEvidenceEntries(evidence)
    : isRecord(summary.evidence) && Array.isArray(summary.evidence.entries)
      ? summary.evidence.entries
      : Array.isArray(summary.entries)
        ? summary.entries
        : undefined;
  return {
    statuses: entries?.map(readQaSuiteEvidenceEntryStatus),
    outcomes:
      evidence?.schemaVersion === 3 ? projectQaEvidenceScenarioOutcomes(evidence) : undefined,
  };
}

function readQaSuiteEvidenceEntryStatus(entry: unknown): unknown {
  return isRecord(entry) && isRecord(entry.result) ? entry.result.status : undefined;
}

function isQaSuiteFailureStatus(status: unknown): boolean {
  return status !== "pass" && status !== "skip" && status !== "skipped";
}

export function findQaSuiteSummaryCompletionError(summary: unknown): string | undefined {
  if (!isRecord(summary)) {
    return "has invalid completion state";
  }
  if (!isRecord(summary.run) || !Object.hasOwn(summary.run, "status")) {
    return "is missing run.status";
  }
  const status = summary.run.status;
  if (status === "completed") {
    return undefined;
  }
  if (status === "running") {
    return "is still running";
  }
  return `has unsupported run.status=${typeof status === "string" ? status : typeof status}`;
}

export async function readCompletedQaSuiteSummaryFile(summaryPath: string): Promise<unknown> {
  let summaryText: string;
  try {
    summaryText = await fs.readFile(summaryPath, "utf8");
  } catch (error) {
    throw new QaSuiteArtifactError(
      "summary_read_failed",
      `Could not read QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  let summary: unknown;
  try {
    summary = JSON.parse(summaryText);
  } catch (error) {
    throw new QaSuiteArtifactError(
      "summary_parse_failed",
      `Could not parse QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  const completionError = findQaSuiteSummaryCompletionError(summary);
  if (completionError) {
    throw new QaSuiteArtifactError(
      "summary_not_completed",
      `QA summary at ${summaryPath} ${completionError}.`,
    );
  }
  return summary;
}

function readNonNegativeCount(value: unknown): number | null {
  return asSafeIntegerInRange(value, { min: 0 }) ?? null;
}

type QaSuiteOutcomeCounts = QaSuiteSummaryJson["counts"];

function countQaSuiteScenarioStatuses(statuses: readonly unknown[]): QaSuiteOutcomeCounts {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const status of statuses) {
    if (status === "pass") {
      passed += 1;
    } else if (status === "skip" || status === "skipped") {
      skipped += 1;
    } else {
      failed += 1;
    }
  }
  return { total: statuses.length, passed, failed, skipped };
}

function isQaSuiteScenarioOutcomeStatus(status: unknown): boolean {
  return status === "pass" || status === "fail" || status === "skip" || status === "skipped";
}

function isQaSuiteEvidenceOutcomeStatus(status: unknown): boolean {
  return status === "blocked" || isQaSuiteScenarioOutcomeStatus(status);
}

function findQaSuiteScenarioCountMismatch(
  counts: QaSuiteOutcomeCounts,
  observed: QaSuiteOutcomeCounts,
): string | undefined {
  for (const key of ["total", "passed", "failed", "skipped"] as const) {
    if (counts[key] !== observed[key]) {
      return `count/scenario mismatch: counts.${key}=${counts[key]}, scenario.${key}=${observed[key]}`;
    }
  }
  return undefined;
}

function inspectQaSuiteSummaryAccounting(summary: unknown) {
  if (!isRecord(summary) || summary.counts === undefined) {
    return undefined;
  }
  if (!isRecord(summary.counts)) {
    return "counts must be a non-array object";
  }
  for (const countName of ["total", "passed", "failed", "skipped"] as const) {
    if (
      Object.hasOwn(summary.counts, countName) &&
      readNonNegativeCount(summary.counts[countName]) === null
    ) {
      return `counts.${countName} must be a non-negative safe integer`;
    }
  }

  const total = readNonNegativeCount(summary.counts.total);
  const passed = readNonNegativeCount(summary.counts.passed);
  const failed = readNonNegativeCount(summary.counts.failed);
  const skipped = readNonNegativeCount(summary.counts.skipped);
  const providedCountSum = (passed ?? 0) + (failed ?? 0) + (skipped ?? 0);
  if (total !== null && total < providedCountSum) {
    return `counts.total=${total} is less than provided count sum=${providedCountSum}`;
  }
  if (total === null || passed === null || failed === null || skipped === null) {
    return undefined;
  }
  if (total !== providedCountSum) {
    return `counts.total=${total} does not match counts.passed+counts.failed+counts.skipped=${providedCountSum}`;
  }

  const counts = { total, passed, failed, skipped };
  const evidence = readQaSuiteEvidenceFacts(summary);
  if (
    evidence.outcomes &&
    failed === 0 &&
    evidence.outcomes.some(
      (outcome) => outcome.status === null || isQaSuiteFailureStatus(outcome.status),
    )
  ) {
    return "counts.failed=0 contradicts an unresolved or failed scheduled evidence instance";
  }
  if (Array.isArray(summary.scenarios)) {
    const statuses = summary.scenarios.map((scenario) =>
      isRecord(scenario) ? scenario.status : undefined,
    );
    if (statuses.every(isQaSuiteScenarioOutcomeStatus)) {
      const mismatch = findQaSuiteScenarioCountMismatch(
        counts,
        countQaSuiteScenarioStatuses(statuses),
      );
      if (mismatch) {
        return mismatch;
      }
    }
  }
  if (evidence.statuses && evidence.statuses.length > 0) {
    // Evidence rows are producer checks, not scenarios: one passing scenario may
    // legitimately contain blocked and passing checks. Validate only facts that
    // can contradict the aggregate without assuming one row per scenario.
    for (const [index, status] of evidence.statuses.entries()) {
      if (!isQaSuiteEvidenceOutcomeStatus(status)) {
        return `evidence.entries[${index}].result.status is not a supported outcome`;
      }
      if (status === "fail" && failed === 0) {
        return `counts.failed=0 contradicts failed evidence entry ${index}`;
      }
    }
  }
  return evidence;
}

export function findQaSuiteSummaryAccountingError(summary: unknown): string | undefined {
  const inspection = inspectQaSuiteSummaryAccounting(summary);
  return typeof inspection === "string" ? inspection : undefined;
}

function prepareQaSuiteSummary(
  summary: unknown,
  summaryPath: string,
  errorCode: "summary_failure_count_missing" | "summary_blocking_count_missing",
  optionalScenarioNames?: ReadonlySet<string>,
  requireExecutedScenario = false,
) {
  if (!isRecord(summary)) {
    return;
  }
  const inspection = inspectQaSuiteSummaryAccounting(summary);
  if (typeof inspection === "string") {
    throw new QaSuiteArtifactError(
      "summary_counts_invalid",
      `QA summary at ${summaryPath} ${inspection}.`,
    );
  }
  const payload = summary as {
    counts?: { total?: unknown; passed?: unknown; failed?: unknown; skipped?: unknown };
    scenarios?: unknown;
  };
  const total = readNonNegativeCount(payload.counts?.total);
  const passed = readNonNegativeCount(payload.counts?.passed);
  const failed = readNonNegativeCount(payload.counts?.failed);
  const skipped = readNonNegativeCount(payload.counts?.skipped);
  const scenarios = Array.isArray(payload.scenarios)
    ? (payload.scenarios as QaSuiteReportOnlyScenario[])
    : undefined;
  const evidence = inspection ?? readQaSuiteEvidenceFacts(summary);
  const canonicalOutcomes = evidence.outcomes;
  const hasObservedOutcomeRows =
    (scenarios?.length ?? 0) > 0 || (evidence.statuses?.length ?? 0) > 0;
  const hasCompletedScenario =
    scenarios?.some((scenario) => scenario.status === "pass" || scenario.status === "fail") ===
      true ||
    evidence.statuses?.some((status) => status === "pass" || status === "fail") === true ||
    (failed ?? 0) > 0 ||
    (!hasObservedOutcomeRows && (passed ?? 0) > 0);
  const hasBlockingNonOptionalSkip =
    errorCode === "summary_blocking_count_missing" &&
    scenarios?.some(
      (scenario) =>
        (scenario.status === "skip" || scenario.status === "skipped") &&
        !isQaSuiteReportOnlyOptionalScenario(scenario, optionalScenarioNames),
    ) === true;
  const hasBlockingUnknownOrFailedScenario =
    scenarios?.some((scenario) => isQaSuiteFailureStatus(scenario.status)) === true;
  const hasBlockingNonPassEvidence =
    evidence.statuses?.some(
      (status) =>
        typeof status === "string" &&
        (errorCode === "summary_blocking_count_missing"
          ? isQaSuiteBlockingStatus(status)
          : isQaSuiteFailureStatus(status)),
    ) === true;

  // Optional skips are not execution: only a real scenario, evidence result,
  // or positive legacy count may clear a zero-work suite. Unverified skips
  // remain blocking, including package runs that expose evidence entries only.
  if (
    (canonicalOutcomes &&
      (canonicalOutcomes.length === 0 ||
        (requireExecutedScenario &&
          !canonicalOutcomes.some(
            (outcome) => outcome.status === "pass" || outcome.status === "fail",
          )))) ||
    total === 0 ||
    scenarios?.length === 0 ||
    // A tolerated blocking result cannot authenticate a campaign that never completed a scenario.
    (requireExecutedScenario && !hasCompletedScenario) ||
    (!hasCompletedScenario &&
      !hasBlockingUnknownOrFailedScenario &&
      !hasBlockingNonOptionalSkip &&
      !hasBlockingNonPassEvidence)
  ) {
    throw new QaSuiteArtifactError(
      errorCode,
      `QA summary at ${summaryPath} did not include any executed scenarios.`,
    );
  }
  return {
    evidence,
    counts: { total, passed, failed, skipped },
    scenarios,
    observed: scenarios
      ? countQaSuiteScenarioStatuses(scenarios.map((scenario) => scenario.status))
      : null,
  };
}

function isQaSuiteBlockingStatus(status: unknown): boolean {
  return status !== "pass";
}

function isQaSuiteReportOnlyOptionalScenario(
  scenario: QaSuiteReportOnlyScenario,
  optionalScenarioNames: ReadonlySet<string> | undefined,
): boolean {
  return (
    (scenario.status === "skip" || scenario.status === "skipped") &&
    typeof scenario.name === "string" &&
    optionalScenarioNames?.has(scenario.name) === true &&
    typeof scenario.details === "string" &&
    scenario.details.includes("report-only")
  );
}

export function resolveQaReportOnlyOptionalScenarioNames(
  scenarios: readonly QaSeedScenarioWithSource[],
): ReadonlySet<string> {
  return new Set(
    scenarios
      .filter((scenario) => {
        const toolCoverage = scenario.execution.config?.toolCoverage;
        return (
          scenario.execution.kind === "flow" &&
          isRecord(toolCoverage) &&
          toolCoverage.required === false
        );
      })
      .map((scenario) => scenario.title),
  );
}

export function countQaSuiteFailedScenarios(
  scenarios: ReadonlyArray<QaSuiteScenarioStatus>,
): number {
  return countQaSuiteScenarioStatuses(Array.from(scenarios, (scenario) => scenario.status)).failed;
}

function readQaSuiteScenarioCountFromSummary(
  facts: ReturnType<typeof prepareQaSuiteSummary>,
  mode: "failed" | "blocking",
): number | null {
  if (!facts) {
    return null;
  }
  const { evidence, counts, observed } = facts;
  const countedFailures = counts.failed;
  const countedSkipped = mode === "blocking" ? counts.skipped : null;
  const counted =
    countedFailures !== null || countedSkipped !== null
      ? (countedFailures ?? 0) + (countedSkipped ?? 0)
      : null;
  const scenarioCount = observed
    ? observed.failed + (mode === "blocking" ? observed.skipped : 0)
    : null;
  const matchesStatus = mode === "blocking" ? isQaSuiteBlockingStatus : isQaSuiteFailureStatus;
  const evidenceCount =
    evidence.outcomes !== undefined
      ? evidence.outcomes.filter((outcome) => matchesStatus(outcome.status)).length
      : evidence.statuses
        ? evidence.statuses.filter(matchesStatus).length
        : null;
  // Canonical v3 outcomes own scheduled instances, including unresolved ones.
  // Optional aggregates cannot hide them; v2 rows remain lower-level checks.
  if (evidence.outcomes !== undefined) {
    return Math.max(evidenceCount ?? 0, counted ?? 0, scenarioCount ?? 0);
  }
  // Legacy raw evidence is a fallback only when neither aggregate is available.
  if (counted !== null || scenarioCount !== null) {
    return Math.max(counted ?? 0, scenarioCount ?? 0);
  }
  return evidenceCount;
}

export async function readQaSuiteFailedScenarioCountFromFile(summaryPath: string): Promise<number> {
  const payload = await readCompletedQaSuiteSummaryFile(summaryPath);
  const facts = prepareQaSuiteSummary(payload, summaryPath, "summary_failure_count_missing");
  const failedScenarioCount = readQaSuiteScenarioCountFromSummary(facts, "failed");
  if (failedScenarioCount !== null) {
    return failedScenarioCount;
  }
  throw new QaSuiteArtifactError(
    "summary_failure_count_missing",
    `QA summary at ${summaryPath} did not include counts.failed, scenarios[].status, or entries[].result.status.`,
  );
}

export async function readQaSuiteFailedOrSkippedScenarioCountFromFile(
  summaryPath: string,
  options?: { optionalScenarioNames?: ReadonlySet<string>; requireExecutedScenario?: boolean },
): Promise<number> {
  const payload = await readCompletedQaSuiteSummaryFile(summaryPath);
  const facts = prepareQaSuiteSummary(
    payload,
    summaryPath,
    "summary_blocking_count_missing",
    options?.optionalScenarioNames,
    options?.requireExecutedScenario,
  );
  const blockingScenarioCount = readQaSuiteScenarioCountFromSummary(facts, "blocking");
  if (blockingScenarioCount !== null) {
    const optionalScenarioNames = options?.optionalScenarioNames;
    if (!optionalScenarioNames?.size) {
      return blockingScenarioCount;
    }
    const reportOnlyOptionalSkips =
      facts?.scenarios?.filter((scenario) =>
        isQaSuiteReportOnlyOptionalScenario(scenario, optionalScenarioNames),
      ).length ?? 0;
    // Optional skips may offset only their independently verified scenario results.
    // Declared failures and count disagreements stay fail-closed.
    return Math.max(
      readQaSuiteScenarioCountFromSummary(facts, "failed") ?? 0,
      blockingScenarioCount - reportOnlyOptionalSkips,
    );
  }
  throw new QaSuiteArtifactError(
    "summary_blocking_count_missing",
    `QA summary at ${summaryPath} did not include counts.failed, counts.skipped, scenarios[].status, or entries[].result.status.`,
  );
}
