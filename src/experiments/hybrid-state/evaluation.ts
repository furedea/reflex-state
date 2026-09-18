import { readFile } from "node:fs/promises";

import type {
  AuditLabel,
  Candidate,
  CallRecord,
  CheckpointItemResult,
  CheckpointResult,
  ContextRecord,
  EvaluationKind,
  ExperimentManifest,
  ExperimentMode,
  ExperimentSummary,
  LabelKind,
  ModeMetrics,
  ProviderMode,
  SkippedTrial,
  TaskCheckpoint,
  TrialScore,
} from "./types.js";

export interface AuditResult {
  readonly labels: readonly AuditLabel[];
  readonly matched: number;
  readonly total: number;
  readonly agreement: number | null;
  readonly coverage: number;
}

const SELECTED_KINDS = new Set<LabelKind>(["deterministic", "extractive", "generative"]);

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
  selected: Readonly<Record<ExperimentMode, readonly string[]>>,
): AuditResult {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const modes = Object.keys(selected) as ExperimentMode[];
  const reviewed = labels.filter((label) => label.reviewed && byId.has(label.candidateId));
  let matched = 0;
  for (const label of reviewed) {
    const expected = SELECTED_KINDS.has(label.kind);
    const every = modes.every((mode) => {
      const chosen = selected[mode].includes(label.candidateId);
      return chosen === expected;
    });
    if (every) matched++;
  }
  return {
    labels,
    matched,
    total: reviewed.length,
    agreement: reviewed.length ? matched / reviewed.length : null,
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
  const wiringStatus =
    executionStatus === "completed" && !contractFailure
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
    if (checkpoint.appliesWhen === "failure_observed" && !outcome.failureObserved) {
      return {
        checkpointId: checkpoint.id,
        step: checkpoint.at === "final" ? outcome.sentTexts.length - 1 : checkpoint.at,
        items: checkpoint.required.map((item) => ({
          id: item.id,
          retained: null,
          reason: "not_applicable",
        })),
      };
    }
    const step = checkpoint.at === "final" ? outcome.sentTexts.length - 1 : checkpoint.at;
    const text = outcome.sentTexts[step];
    const items: CheckpointItemResult[] = checkpoint.required.map((item) => {
      if (text === undefined) return { id: item.id, retained: null, reason: "step_not_reached" };
      const retained = item.anyOf.some((group) => group.every((phrase) => text.includes(phrase)));
      return { id: item.id, retained };
    });
    return { checkpointId: checkpoint.id, step, items };
  });
}

export function summarize(options: {
  readonly runId: string;
  readonly evaluation: EvaluationKind;
  readonly provider: ProviderMode;
  readonly modes: readonly ExperimentMode[];
  readonly scores: readonly TrialScore[];
  readonly skipped: readonly SkippedTrial[];
  readonly calls: readonly CallRecord[];
  readonly contexts: readonly ContextRecord[];
  readonly uniqueCandidates: ReadonlyMap<ExperimentMode, ReadonlySet<string>>;
  readonly decisionCounts: ReadonlyMap<ExperimentMode, number>;
  readonly appliedCounts: ReadonlyMap<
    ExperimentMode,
    { readonly extractive: number; readonly generated: number }
  >;
  readonly limitations?: readonly string[];
}): ExperimentSummary {
  const metrics = Object.fromEntries(
    options.modes.map((mode) => {
      const modeCalls = options.calls.filter((call) => call.mode === mode && call.sent);
      const usageValues = modeCalls.map((call) => call.usage);
      const measured = usageValues.filter(
        (usage) =>
          usage &&
          (usage.inputTokens !== null ||
            usage.outputTokens !== null ||
            usage.cacheReadTokens !== null ||
            usage.cacheWriteTokens !== null),
      );
      const sum = (
        field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens",
      ) =>
        measured.length && measured.every((usage) => usage![field] !== null)
          ? measured.reduce((total, usage) => total + (usage![field] ?? 0), 0)
          : null;
      const scores = options.scores.filter((score) => score.mode === mode);
      const metric: ModeMetrics = {
        uniqueCandidates: options.uniqueCandidates.get(mode)?.size ?? 0,
        decisionCount: options.decisionCounts.get(mode) ?? 0,
        appliedExtractive: options.appliedCounts.get(mode)?.extractive ?? 0,
        appliedGenerated: options.appliedCounts.get(mode)?.generated ?? 0,
        sentCalls: {
          actor: modeCalls.filter((call) => call.kind === "actor").length,
          jev: modeCalls.filter((call) => call.kind === "jev").length,
          repair: modeCalls.filter((call) => call.kind === "repair").length,
          update: modeCalls.filter((call) => call.kind === "update").length,
        },
        sentBytes: modeCalls.reduce((total, call) => total + call.requestBytes, 0),
        usage: {
          inputTokens: sum("inputTokens"),
          outputTokens: sum("outputTokens"),
          cacheReadTokens: sum("cacheReadTokens"),
          cacheWriteTokens: sum("cacheWriteTokens"),
          coverage: modeCalls.length ? measured.length / modeCalls.length : 0,
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
    skippedTrials: options.skipped,
    metrics,
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
  const lines: string[] = [
    "# Hybrid-state experiment report",
    "",
    `- run: \`${summary.runId}\``,
    `- evaluation: ${summary.evaluation}`,
    `- provider: ${summary.provider}`,
    ...(manifest
      ? [
          `- manifest: started ${manifest.startedAt}, status ${manifest.status}${manifest.finishedAt ? `, finished ${manifest.finishedAt}` : ""}`,
        ]
      : []),
    `- efficacy_status: **${summary.efficacyStatus}**`,
    `- wiring: ${summary.wiring.passed} passed / ${summary.wiring.failed} failed / ${summary.wiring.notEvaluated} not_evaluated`,
    "",
    "## Per-mode metrics",
    "",
    "| mode | actor | jev | repair | update | sent bytes | unique candidates | decisions | applied ex/gen | wall ms | usage coverage |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const mode of summary.modes) {
    const metric = summary.metrics[mode];
    lines.push(
      `| ${mode} | ${metric.sentCalls.actor} | ${metric.sentCalls.jev} | ${metric.sentCalls.repair} | ${metric.sentCalls.update} | ${metric.sentBytes} | ${metric.uniqueCandidates} | ${metric.decisionCount} | ${metric.appliedExtractive}/${metric.appliedGenerated} | ${metric.wallMs} | ${(metric.usage.coverage * 100).toFixed(0)}% |`,
    );
  }
  if (summary.scores.length) {
    lines.push(
      "",
      "## Trials",
      "",
      "| trial | task | mode | status | wiring | completed | tests | checkpoints |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const score of summary.scores) {
      const checkpoints = score.checkpoints
        .flatMap((checkpoint) => checkpoint.items)
        .map((item) => (item.retained === null ? "n/a" : item.retained ? "ok" : "miss"))
        .join(",");
      const tests = Object.entries(score.tests)
        .map(([id, status]) => `${id}:${status}`)
        .join(",");
      lines.push(
        `| ${score.trialId} | ${score.taskId} | ${score.mode} | ${score.executionStatus} | ${score.wiringStatus} | ${score.completed} | ${tests || "-"} | ${checkpoints || "-"} |`,
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
