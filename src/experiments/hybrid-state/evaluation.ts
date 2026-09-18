import { readFile } from "node:fs/promises";

import type {
  AuditLabel,
  Candidate,
  CallRecord,
  CheckpointItemResult,
  CheckpointRequirement,
  CheckpointResult,
  ContextRecord,
  EvaluationKind,
  ExperimentEnvironment,
  ExperimentManifest,
  ExperimentMode,
  ExperimentSummary,
  LabelKind,
  ModeMetrics,
  ProviderMode,
  SkippedTrial,
  TaskCheckpoint,
  TrialScore,
  UsageFieldSummary,
} from "./types.js";

export interface AuditResult {
  readonly labels: readonly AuditLabel[];
  /** Count of reviewed labels per update-method kind. These labels classify the
   * update method, not whether a candidate should be adopted; without an
   * independent adoption ground truth there is no selection accuracy. */
  readonly distribution: Readonly<Record<LabelKind, number>>;
  readonly total: number;
  readonly coverage: number;
}

export interface LabelsFile {
  readonly sourceHash: string | null;
  readonly labels: readonly AuditLabel[];
}

export async function loadLabels(path: string): Promise<LabelsFile> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseLabelsFile(value, path);
}

export function parseLabelsFile(value: unknown, name = "labels"): LabelsFile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid labels file: ${name}`);
  const record = value as Record<string, unknown>;
  const raw = Array.isArray(record.labels) ? record.labels : undefined;
  if (!raw) throw new Error(`Invalid labels file: ${name}`);
  const labels = raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Invalid label entry in ${name}`);
    const item = entry as Record<string, unknown>;
    if (typeof item.candidateId !== "string" || !item.candidateId.trim())
      throw new Error(`Invalid label candidateId in ${name}`);
    if (
      item.kind !== "deterministic" &&
      item.kind !== "extractive" &&
      item.kind !== "generative" &&
      item.kind !== "insufficient" &&
      item.kind !== "untrusted"
    )
      throw new Error(`Invalid label kind in ${name}`);
    if (typeof item.reviewed !== "boolean") throw new Error(`Invalid reviewed flag in ${name}`);
    return {
      candidateId: item.candidateId,
      kind: item.kind as LabelKind,
      reviewed: item.reviewed,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    };
  });
  const sourceHash = typeof record.sourceHash === "string" ? record.sourceHash : null;
  return { sourceHash, labels };
}

export function evaluateAudit(
  candidates: readonly Candidate[],
  labels: readonly AuditLabel[],
): AuditResult {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const reviewed = labels.filter((label) => label.reviewed && byId.has(label.candidateId));
  const distribution: Record<LabelKind, number> = {
    deterministic: 0,
    extractive: 0,
    generative: 0,
    insufficient: 0,
  };
  for (const label of reviewed) distribution[label.kind]++;
  return {
    labels,
    distribution,
    total: reviewed.length,
    coverage: candidates.length ? reviewed.length / candidates.length : 0,
  };
}

export interface TrialOutcome {
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly iteration: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly error?: string;
  readonly policyViolations: readonly string[];
  readonly testResults: Readonly<Record<string, "passed" | "failed" | "not_run">>;
  readonly actorTests: readonly {
    readonly testId: string;
    readonly step: number;
    readonly passed: boolean;
  }[];
  readonly sentTexts: readonly string[];
  readonly checkpoints: readonly TaskCheckpoint[];
  readonly failureObserved: boolean;
  readonly rereads: number;
  readonly retries: number;
  readonly appliedExtractive: number;
  readonly appliedGenerated: number;
  readonly activeMemoryItems: number;
  readonly providerMode: ProviderMode;
}

const WIRING_FAILURES = new Set([
  "invalid_update",
  "actor_action_missing",
  "actor_action_invalid",
  "actor_state_patch_missing",
  "response_invalid_json",
  "response_invalid_object",
  "path_escape",
  "test_not_allowed",
  "test_no_oracle",
  "invalid_action",
  "operations_missing",
  "operations_not_array",
]);

export function scoreTrial(outcome: TrialOutcome): TrialScore {
  const persistenceFailed =
    outcome.error === "persistence_failed" || outcome.error?.startsWith("persistence_failed:");
  const executionStatus = outcome.completed
    ? "completed"
    : outcome.cancelled
      ? "cancelled"
      : outcome.error === "action_budget_exhausted" || outcome.error === "request_limit"
        ? "incomplete"
        : "failed";
  const contractFailure = outcome.error
    ? [...WIRING_FAILURES].some(
        (prefix) => outcome.error === prefix || outcome.error!.startsWith(`${prefix}:`),
      ) || outcome.policyViolations.length > 0
    : outcome.policyViolations.length > 0;
  // Persistence failure is distinguished from execution failure: the trial's
  // wiring was neither proven nor disproven.
  const wiringStatus = persistenceFailed
    ? "not_evaluated"
    : executionStatus === "completed" && !contractFailure
      ? "passed"
      : contractFailure || executionStatus === "failed"
        ? "failed"
        : "not_evaluated";
  const testValues = Object.values(outcome.testResults);
  const testPassed =
    outcome.completed && testValues.length > 0 && testValues.every((v) => v === "passed");
  return {
    trialId: outcome.trialId,
    taskId: outcome.taskId,
    mode: outcome.mode,
    iteration: outcome.iteration,
    executionStatus,
    wiringStatus,
    efficacyStatus: outcome.providerMode === "live" ? "descriptive_only" : "not_evaluated",
    ...(outcome.error ? { failureReason: outcome.error } : {}),
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    wallMs: Math.max(0, Date.parse(outcome.finishedAt) - Date.parse(outcome.startedAt)),
    completed: outcome.completed,
    testPassed,
    constraintPassed: outcome.policyViolations.length === 0,
    tests: outcome.testResults,
    actorTests: outcome.actorTests,
    checkpoints: scoreCheckpoints(outcome),
    rereads: outcome.rereads,
    retries: outcome.retries,
    appliedExtractive: outcome.appliedExtractive,
    appliedGenerated: outcome.appliedGenerated,
    activeMemoryItems: outcome.activeMemoryItems,
  };
}

function scoreCheckpoints(outcome: TrialOutcome): readonly CheckpointResult[] {
  return outcome.checkpoints.map((checkpoint) => {
    const step = checkpoint.at === "final" ? outcome.sentTexts.length - 1 : checkpoint.at;
    const items: CheckpointItemResult[] = checkpoint.required.map((item) => {
      if (checkpoint.appliesWhen === "failure_observed" && !outcome.failureObserved)
        return { id: item.id, retained: null, reason: "not_applicable" };
      const text = outcome.sentTexts[step];
      if (text === undefined) return { id: item.id, retained: null, reason: "step_not_reached" };
      return evaluateRequirement(item, text);
    });
    return { checkpointId: checkpoint.id, step, items };
  });
}

/**
 * Verbatim retention check on the input actually sent at the checkpoint step.
 * It distinguishes: retained / missing / inverted / condition_dropped /
 * needs_semantic_review. It never judges paraphrases by word overlap alone.
 */
function evaluateRequirement(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  const text = sectionsText(sentText, item.sections);
  const residue = (item.inverted ?? []).reduce(
    (current, pattern) => current.split(pattern).join(""),
    text,
  );
  const canonicalPresent = (source: string) =>
    item.anyOf.some((group) => group.every((phrase) => source.includes(phrase)));
  if (canonicalPresent(residue)) {
    if (item.condition !== undefined && !text.includes(item.condition))
      return { id: item.id, retained: false, reason: "condition_dropped" };
    return { id: item.id, retained: true };
  }
  if (canonicalPresent(text)) return { id: item.id, retained: false, reason: "inverted" };
  if ((item.markers ?? []).some((marker) => text.includes(marker)))
    return { id: item.id, retained: null, reason: "needs_semantic_review" };
  return { id: item.id, retained: false, reason: "missing" };
}

/** Extract the named JSON sections from a sent userText; falls back to the raw
 * text when it is not JSON. */
function sectionsText(sentText: string, sections: readonly string[] | undefined): string {
  if (!sections?.length) return sentText;
  try {
    const parsed: unknown = JSON.parse(sentText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return sentText;
    const record = parsed as Record<string, unknown>;
    return sections
      .map((section) => (section in record ? JSON.stringify(record[section]) : ""))
      .join("\n");
  } catch {
    return sentText;
  }
}

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

export function summarize(options: {
  readonly runId: string;
  readonly evaluation: EvaluationKind;
  readonly provider: ProviderMode;
  readonly modes: readonly ExperimentMode[];
  readonly scores: readonly TrialScore[];
  readonly plannedTrials: number;
  readonly skipped: readonly SkippedTrial[];
  readonly calls: readonly CallRecord[];
  readonly contexts: readonly ContextRecord[];
  readonly uniqueCandidates: ReadonlyMap<ExperimentMode, ReadonlySet<string>>;
  readonly decisionCounts: ReadonlyMap<ExperimentMode, number>;
  readonly appliedCounts: ReadonlyMap<
    ExperimentMode,
    { readonly extractive: number; readonly generated: number }
  >;
  readonly environment?: ExperimentEnvironment;
  readonly limitations?: readonly string[];
}): ExperimentSummary {
  const metrics = Object.fromEntries(
    options.modes.map((mode) => {
      const modeCalls = options.calls.filter((call) => call.mode === mode && call.providerInvoked);
      const fieldSummary = (field: (typeof USAGE_FIELDS)[number]): UsageFieldSummary => {
        const observed = modeCalls
          .map((call) => call.usage?.[field])
          .filter((value): value is number => typeof value === "number");
        return {
          observedSubtotal: observed.length
            ? observed.reduce((total, value) => total + value, 0)
            : null,
          completeTotal:
            modeCalls.length > 0 && observed.length === modeCalls.length
              ? observed.reduce((total, value) => total + value, 0)
              : null,
          coverage: modeCalls.length ? observed.length / modeCalls.length : 0,
        };
      };
      const scores = options.scores.filter((score) => score.mode === mode);
      const metric: ModeMetrics = {
        uniqueCandidates: options.uniqueCandidates.get(mode)?.size ?? 0,
        decisionCount: options.decisionCounts.get(mode) ?? 0,
        appliedExtractive: options.appliedCounts.get(mode)?.extractive ?? 0,
        appliedGenerated: options.appliedCounts.get(mode)?.generated ?? 0,
        invocations: {
          actor: modeCalls.filter((call) => call.kind === "actor").length,
          jev: modeCalls.filter((call) => call.kind === "jev").length,
          repair: modeCalls.filter((call) => call.kind === "repair").length,
          update: modeCalls.filter((call) => call.kind === "update").length,
        },
        sentBytes: modeCalls.reduce((total, call) => total + call.requestBytes, 0),
        usage: {
          inputTokens: fieldSummary("inputTokens"),
          outputTokens: fieldSummary("outputTokens"),
          cacheReadTokens: fieldSummary("cacheReadTokens"),
          cacheWriteTokens: fieldSummary("cacheWriteTokens"),
        },
        wallMs: scores.reduce((total, score) => total + score.wallMs, 0),
        contextBytes: options.contexts
          .filter((context) => context.mode === mode)
          .reduce((total, context) => total + context.sentBytes, 0),
      };
      return [mode, metric];
    }),
  ) as Record<ExperimentMode, ModeMetrics>;
  const scores = options.scores;
  return {
    schemaVersion: 2,
    runId: options.runId,
    evaluation: options.evaluation,
    provider: options.provider,
    modes: [...options.modes],
    efficacyStatus: options.provider === "live" ? "descriptive_only" : "not_evaluated",
    wiring: {
      passed: scores.filter((score) => score.wiringStatus === "passed").length,
      failed: scores.filter((score) => score.wiringStatus === "failed").length,
      notEvaluated: scores.filter((score) => score.wiringStatus === "not_evaluated").length,
    },
    scores,
    plannedTrials: options.plannedTrials,
    skippedTrials: options.skipped,
    metrics,
    ...(options.environment ? { environment: options.environment } : {}),
    limitations: [...(options.limitations ?? defaultLimitations(options))],
  };
}

function defaultLimitations(options: {
  readonly provider: ProviderMode;
  readonly evaluation: EvaluationKind;
}): readonly string[] {
  const limitations: string[] = [];
  if (options.provider === "fake")
    limitations.push(
      "fake providers establish wiring only; efficacy is not evaluated",
      "task completion by scripted actors is not task performance",
    );
  if (options.provider === "recorded")
    limitations.push("recorded providers replay captured responses; efficacy is not evaluated");
  if (options.provider === "live")
    limitations.push(
      "descriptive measurements only; no automatic winner is declared",
      "usage coverage depends on provider-reported fields",
    );
  if (options.evaluation === "trace_audit")
    limitations.push("audit replays a fixed trace; update calls are diagnostic, not closed-loop");
  return limitations;
}

export function reportMarkdown(value: unknown, manifest?: ExperimentManifest | null): string {
  const summary = value as ExperimentSummary;
  if (!summary || summary.schemaVersion !== 2) {
    return [
      "# Hybrid-state experiment report",
      "",
      "> legacy_metrics_untrusted: this result predates schema version 2.",
      "> Its measurements and judgements are not reliable; do not compare it",
      "> with corrected runs.",
      "",
      "```json",
      JSON.stringify(value, null, 2),
      "```",
      "",
    ].join("\n");
  }
  const env = summary.environment;
  const lines: string[] = [
    "# Hybrid-state experiment report",
    "",
    `- run: \`${summary.runId}\``,
    `- evaluation: ${summary.evaluation}`,
    `- provider: ${summary.provider}`,
    ...(manifest
      ? [
          `- manifest: started ${manifest.startedAt}, status ${manifest.status}${manifest.finishedAt ? `, finished ${manifest.finishedAt}` : ""}${manifest.failedStage ? ` (failed stage: ${manifest.failedStage})` : ""}`,
        ]
      : []),
    `- efficacy_status: **${summary.efficacyStatus}**`,
    `- wiring: ${summary.wiring.passed} passed / ${summary.wiring.failed} failed / ${summary.wiring.notEvaluated} not_evaluated`,
    `- trials: ${summary.scores.length}/${summary.plannedTrials} executed, ${summary.skippedTrials.length} skipped`,
    ...(env
      ? [`- environment: node ${env.node}, ${env.platform}, isolation: ${env.isolation}`]
      : []),
    "- sent bytes are application-side request bodies (system + user), not HTTP bytes or token counts",
    "",
    "## Per-mode metrics",
    "",
    "| mode | actor | jev | repair | update | sent bytes | unique candidates | decisions | applied ex/gen | wall ms | usage fields reported |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const mode of summary.modes) {
    const metric = summary.metrics[mode];
    const usageCoverage = USAGE_FIELDS.map(
      (field) =>
        `${field.replace("Tokens", "")}:${(metric.usage[field].coverage * 100).toFixed(0)}%`,
    ).join(" ");
    lines.push(
      `| ${mode} | ${metric.invocations.actor} | ${metric.invocations.jev} | ${metric.invocations.repair} | ${metric.invocations.update} | ${metric.sentBytes} | ${metric.uniqueCandidates} | ${metric.decisionCount} | ${metric.appliedExtractive}/${metric.appliedGenerated} | ${metric.wallMs} | ${usageCoverage} |`,
    );
  }
  if (summary.scores.length) {
    lines.push(
      "",
      "## Trials",
      "",
      "| trial | task | mode | status | wiring | completed | tests | actor tests | checkpoints |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const score of summary.scores) {
      const checkpoints = score.checkpoints
        .flatMap((checkpoint) => checkpoint.items)
        .map((item) =>
          item.retained === null
            ? `n/a${item.reason ? `(${item.reason})` : ""}`
            : item.retained
              ? "ok"
              : `miss${item.reason ? `(${item.reason})` : ""}`,
        )
        .join(",");
      const tests = Object.entries(score.tests)
        .map(([id, status]) => `${id}:${status}`)
        .join(",");
      const actorTests = score.actorTests
        .map((test) => `${test.testId}@${test.step}:${test.passed ? "pass" : "fail"}`)
        .join(",");
      lines.push(
        `| ${score.trialId} | ${score.taskId} | ${score.mode} | ${score.executionStatus} | ${score.wiringStatus} | ${score.completed} | ${tests || "-"} | ${actorTests || "-"} | ${checkpoints || "-"} |`,
      );
    }
  }
  if (summary.skippedTrials.length) {
    lines.push("", "## Skipped trials", "");
    for (const skipped of summary.skippedTrials)
      lines.push(`- ${skipped.trialId} (${skipped.taskId}/${skipped.mode}): ${skipped.reason}`);
  }
  if (summary.limitations.length) {
    lines.push("", "## Limitations", "");
    for (const limitation of summary.limitations) lines.push(`- ${limitation}`);
  }
  lines.push("");
  return lines.join("\n");
}
