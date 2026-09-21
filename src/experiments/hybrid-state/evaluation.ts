import { readFile } from "node:fs/promises";

import type {
  ActionForm,
  ActorVerificationEntry,
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
  FinalArtifactEvaluation,
  LabelKind,
  ModeMetrics,
  PatchStats,
  ProviderMode,
  SkippedTrial,
  TaskCheckpoint,
  TerminationReason,
  TrialScore,
  UsageFieldSummary,
} from "./types.js";
import { PROTOCOL_ID, RESULT_SCHEMA_VERSION } from "./types.js";

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
  readonly terminationReason: TerminationReason;
  readonly policyViolations: readonly string[];
  /** Oracle-reported task-constraint verdicts; a false is sticky across the
   * trial and is scored independently of action-policy violations. */
  readonly constraints: Readonly<Record<string, boolean>>;
  readonly testResults: Readonly<Record<string, "passed" | "failed" | "not_run">>;
  readonly finalArtifact: FinalArtifactEvaluation;
  readonly finalConstraintVerdicts: Readonly<Record<string, boolean>> | null;
  readonly actorVerificationAtStop: Readonly<Record<string, ActorVerificationEntry>>;
  readonly actorTests: readonly {
    readonly testId: string;
    readonly step: number;
    readonly passed: boolean;
    readonly generation?: number;
  }[];
  readonly patchStats: PatchStats;
  readonly actionForms: Readonly<Record<ActionForm, number>>;
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
    terminationReason: outcome.terminationReason,
    finishedWithinBudget: outcome.completed,
    testPassed,
    constraintPassed: Object.keys(outcome.constraints).length
      ? Object.values(outcome.constraints).every(Boolean)
      : null,
    constraints: outcome.constraints,
    tests: outcome.testResults,
    finalArtifact: outcome.finalArtifact,
    finalConstraintVerdicts: outcome.finalConstraintVerdicts,
    actorVerificationAtStop: outcome.actorVerificationAtStop,
    actorTests: outcome.actorTests,
    patchStats: outcome.patchStats,
    actionForms: outcome.actionForms,
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
 * Checkpoint evaluation on the input actually sent at the checkpoint step.
 * Typed information (latest verification, values) is compared structurally;
 * prose is retained only inside a provenance-eligible item that carries the
 * canonical text without inverting it. Paraphrases that cannot be verified
 * stay needs_semantic_review. It never judges by substring overlap alone.
 */
function evaluateRequirement(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  if (item.kind === "verification") return evaluateVerification(item, sentText);
  if (item.kind === "exact_value") return evaluateExactValue(item, sentText);
  return evaluateVerbatim(item, sentText);
}

interface SentItem {
  readonly section: string;
  readonly text: string;
  readonly role?: string;
  readonly toolName?: string;
  readonly memoryKind?: string;
  readonly trust?: string;
}

/** Itemize the sent input into provenance-bearing units: memory items,
 * observation items, history lines, the instruction, and the facts blob. */
function extractItems(sentText: string, sections?: readonly string[]): SentItem[] {
  const parsed = parseSentJson(sentText);
  if (!parsed) return [{ section: "raw", text: sentText }];
  const take = (name: string) => !sections?.length || sections.includes(name);
  const items: SentItem[] = [];
  if (take("instruction") && typeof parsed.instruction === "string")
    items.push({ section: "instruction", role: "user", text: parsed.instruction });
  if (take("memory") && parsed.memory && typeof parsed.memory === "object") {
    const memory = parsed.memory as { items?: unknown };
    if (Array.isArray(memory.items))
      for (const entry of memory.items) {
        const record = entry as Record<string, unknown>;
        if (typeof record?.text === "string")
          items.push({
            section: "memory",
            text: record.text,
            ...(typeof record.kind === "string" ? { memoryKind: record.kind } : {}),
            ...(typeof record.trust === "string" ? { trust: record.trust } : {}),
          });
      }
  }
  if (
    take("latest_observation") &&
    parsed.latest_observation &&
    typeof parsed.latest_observation === "object"
  ) {
    const group = parsed.latest_observation as { items?: unknown };
    if (Array.isArray(group.items))
      for (const entry of group.items) {
        const record = entry as Record<string, unknown>;
        if (typeof record?.text === "string")
          items.push({
            section: "latest_observation",
            text: record.text,
            ...(typeof record.role === "string" ? { role: record.role } : {}),
          });
      }
  }
  if (take("history") && typeof parsed.history === "string")
    items.push(...historyItems(parsed.history));
  if (take("facts") && parsed.facts !== undefined)
    items.push({ section: "facts", text: JSON.stringify(parsed.facts) });
  return items;
}

/** Itemize a transcript into messages, not lines: a multi-line tool result
 * keeps the role and tool name of the line that opened it, so provenance
 * survives embedded newlines inside the message text. */
function historyItems(transcript: string): SentItem[] {
  const items: SentItem[] = [];
  let current = -1;
  for (const line of transcript.split("\n")) {
    const match = /^\[([^\]]+)\] (.*)$/s.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const meta = match[1].split(/\s+/);
      items.push({
        section: "history",
        ...(meta[1] !== undefined ? { role: meta[1] } : {}),
        ...(meta[2] !== undefined ? { toolName: meta[2] } : {}),
        text: match[2],
      });
      current = items.length - 1;
    } else if (current >= 0) {
      const item = items[current]!;
      items[current] = { ...item, text: `${item.text}\n${line}` };
    } else if (line.trim()) {
      items.push({ section: "history", text: line });
    }
  }
  return items;
}

function parseSentJson(sentText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(sentText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A canonical phrase does not count when a negation immediately precedes it
 * in the same item ("do not use X" must not satisfy "use X"). Only the short
 * window directly before the phrase is inspected, so a negation earlier in a
 * longer passage does not produce false negatives. */
const NEGATION_PREFIX = /(?:\bnot\b|\bnever\b|n't\b|\bwithout\b|\bno longer\b)\s*$/i;
const NEGATION_WINDOW = 24;

function hasAffirmativeOccurrence(text: string, phrase: string): boolean {
  let index = text.indexOf(phrase);
  while (index >= 0) {
    if (!NEGATION_PREFIX.test(text.slice(Math.max(0, index - NEGATION_WINDOW), index))) return true;
    index = text.indexOf(phrase, index + 1);
  }
  return false;
}

/** Verbatim retention: the canonical text must appear inside one item whose
 * provenance matches the scope and which does not itself invert the meaning. */
function evaluateVerbatim(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  const items = extractItems(sentText, item.sections);
  const inverted = item.inverted ?? [];
  const scope = item.scope;
  const eligible = (entry: SentItem) =>
    !scope ||
    (entry.memoryKind !== undefined && (scope.memoryKinds ?? []).includes(entry.memoryKind)) ||
    (entry.trust !== undefined && (scope.trusts ?? []).includes(entry.trust)) ||
    (entry.role !== undefined && (scope.roles ?? []).includes(entry.role));
  const canonical = (text: string) =>
    (item.anyOf ?? []).some((group) =>
      group.every((phrase) => hasAffirmativeOccurrence(text, phrase)),
    );
  const clean = (entry: SentItem) => !inverted.some((pattern) => entry.text.includes(pattern));
  const hit = items.find((entry) => eligible(entry) && clean(entry) && canonical(entry.text));
  if (hit) {
    if (item.condition !== undefined && !hit.text.includes(item.condition))
      return { id: item.id, retained: false, reason: "condition_dropped" };
    return { id: item.id, retained: true };
  }
  if (items.some((entry) => eligible(entry) && canonical(entry.text)))
    return { id: item.id, retained: false, reason: "inverted" };
  if (items.some((entry) => canonical(entry.text)))
    return { id: item.id, retained: false, reason: "wrong_provenance" };
  if ((item.markers ?? []).some((marker) => items.some((entry) => entry.text.includes(marker))))
    return { id: item.id, retained: null, reason: "needs_semantic_review" };
  return { id: item.id, retained: false, reason: "missing" };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact typed value: the token must appear with identifier/numeric
 * boundaries, so 9377 never matches inside 19377 or 93770. When a `name` is
 * declared, the value must be bound to that name (`NAME=VALUE`), so a swapped
 * assignment such as `PRIMARY_PORT=8080` cannot satisfy `FALLBACK_PORT=8080`. */
function evaluateExactValue(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  const boundary = new RegExp(
    `(?<![0-9A-Za-z_.-])${escapeRegExp(item.value ?? "")}(?![0-9A-Za-z_.-])`,
  );
  const bound =
    item.name !== undefined
      ? new RegExp(
          `(?<![0-9A-Za-z_.-])${escapeRegExp(item.name)}\\s*[=:]\\s*${escapeRegExp(item.value ?? "")}(?![0-9A-Za-z_.-])`,
        )
      : boundary;
  const items = extractItems(sentText, item.sections);
  if (items.some((entry) => bound.test(entry.text))) return { id: item.id, retained: true };
  if ((item.markers ?? []).some((marker) => items.some((entry) => entry.text.includes(marker))))
    return { id: item.id, retained: null, reason: "needs_semantic_review" };
  return { id: item.id, retained: false, reason: "missing" };
}

const EXPERIMENT_TEST_PREFIX = "experiment test ";

/** Structured verification: the latest check for the declared test id must
 * carry the required status and freshness. In state-first inputs the facts
 * section is compared field by field; in history inputs the per-test records
 * are compared by generation and sequence. */
function evaluateVerification(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  const testId = item.testId ?? "";
  const want = item.status ?? "passed";
  const fresh = item.fresh ?? true;
  const parsed = parseSentJson(sentText);
  if (parsed && parsed.facts !== undefined) {
    const facts = parsed.facts as {
      verification?: {
        test?: Record<string, unknown>;
        tests?: Record<string, Record<string, unknown>>;
      };
    };
    const verification = facts?.verification;
    // Per-test facts take precedence; the single test slot only reflects the
    // globally latest check and cannot speak for other test ids.
    const test = verification?.tests ? verification.tests[testId] : verification?.test;
    if (!test || test.status === "not_run")
      return { id: item.id, retained: false, reason: "missing" };
    if (test.command !== `${EXPERIMENT_TEST_PREFIX}${testId}`)
      return { id: item.id, retained: false, reason: "wrong_test" };
    if (test.status !== want) return { id: item.id, retained: false, reason: "wrong_status" };
    if (fresh && test.freshness !== "current")
      return { id: item.id, retained: false, reason: "stale" };
    return { id: item.id, retained: true };
  }
  // History mode: only actual test tool results count as verification events.
  // A matching line inside an assistant explanation, a user message, or a
  // file's contents is not a check record — the evidence must be the first
  // line of a `tool_result test` message. Generation is likewise derived from
  // tool results only.
  const transcript = parsed && typeof parsed.history === "string" ? parsed.history : sentText;
  const items = historyItems(transcript);
  const testLine = new RegExp(
    `^test ${escapeRegExp(testId)}: (passed|failed) check=\\S+ gen=(\\d+) seq=(\\d+)`,
  );
  let latest: { readonly status: string; readonly gen: number; readonly seq: number } | undefined;
  let maxGen = -1;
  for (const entry of items) {
    if (entry.role !== "tool_result") continue;
    for (const match of entry.text.matchAll(/gen=(\d+)/g))
      maxGen = Math.max(maxGen, Number(match[1]));
    if (entry.toolName !== "test") continue;
    const match = testLine.exec(entry.text);
    const gen = Number(match?.[2]);
    const seq = Number(match?.[3]);
    if (match?.[1] && (!latest || gen > latest.gen || (gen === latest.gen && seq > latest.seq)))
      latest = { status: match[1], gen, seq };
  }
  if (!latest) return { id: item.id, retained: false, reason: "missing" };
  if (latest.status !== want) return { id: item.id, retained: false, reason: "wrong_status" };
  if (fresh && latest.gen < maxGen) return { id: item.id, retained: false, reason: "stale" };
  return { id: item.id, retained: true };
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
    schemaVersion: RESULT_SCHEMA_VERSION,
    protocolId: PROTOCOL_ID,
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
  const schemaVersion = (summary as { schemaVersion?: unknown }).schemaVersion;
  if (!summary || (schemaVersion !== 2 && schemaVersion !== RESULT_SCHEMA_VERSION)) {
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
    ...(summary.protocolId ? [`- protocol: \`${summary.protocolId}\``] : []),
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
    const v3 = summary.schemaVersion === RESULT_SCHEMA_VERSION;
    lines.push(
      "",
      "## Trials",
      "",
      v3
        ? "| trial | task | mode | status | wiring | termination | finished | final artifact | actor verify | patch a/u/r | checkpoints |"
        : "| trial | task | mode | status | wiring | completed | tests | actor tests | checkpoints |",
      v3
        ? "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
        : "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
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
      if (v3) {
        const finalTests = score.finalArtifact
          ? Object.entries(score.finalArtifact.tests)
              .map(([id, status]) => `${id}:${status}`)
              .join(",") || score.finalArtifact.status
          : "-";
        const actorVerify = score.actorVerificationAtStop
          ? Object.entries(score.actorVerificationAtStop)
              .map(
                ([id, entry]) =>
                  `${id}:${entry.status}${entry.freshness === "stale" ? "(stale)" : ""}`,
              )
              .join(",")
          : "-";
        const patch = score.patchStats
          ? `${score.patchStats.applied}/${score.patchStats.unchanged}/${score.patchStats.rejected}`
          : "-";
        lines.push(
          `| ${score.trialId} | ${score.taskId} | ${score.mode} | ${score.executionStatus} | ${score.wiringStatus} | ${score.terminationReason ?? "-"} | ${score.finishedWithinBudget ?? "-"} | ${finalTests || "-"} | ${actorVerify || "-"} | ${patch} | ${checkpoints || "-"} |`,
        );
      } else {
        lines.push(
          `| ${score.trialId} | ${score.taskId} | ${score.mode} | ${score.executionStatus} | ${score.wiringStatus} | ${score.completed} | ${tests || "-"} | ${actorTests || "-"} | ${checkpoints || "-"} |`,
        );
      }
    }
    if (!v3)
      lines.push(
        "",
        "> schema v2 result: termination, final-artifact, and update-feedback fields",
        "> did not exist yet; missing values are shown as `-` and never inferred.",
      );
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
