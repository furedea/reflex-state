import { readFile } from "node:fs/promises";

import { scoreCheckpoints } from "./evaluation_checkpoints.js";
import type {
  ActionForm,
  ActorVerificationEntry,
  AuditLabel,
  Candidate,
  ExecutionStatus,
  ExperimentMode,
  FinalArtifactEvaluation,
  LabelKind,
  PatchStats,
  ProviderMode,
  TaskCheckpoint,
  TerminationReason,
  TrialScore,
  WiringStatus,
} from "./types.js";

export { reportMarkdown } from "./evaluation_report.js";
export { summarize } from "./evaluation_summary.js";

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
  const labels = raw.map((entry) => parseLabelEntry(entry, name));
  const sourceHash = typeof record.sourceHash === "string" ? record.sourceHash : null;
  return { sourceHash, labels };
}

const LABEL_KINDS: ReadonlySet<unknown> = new Set([
  "deterministic",
  "extractive",
  "generative",
  "insufficient",
  "untrusted",
]);

function parseLabelEntry(entry: unknown, name: string): AuditLabel {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error(`Invalid label entry in ${name}`);
  const item = entry as Record<string, unknown>;
  if (typeof item.candidateId !== "string" || !item.candidateId.trim())
    throw new Error(`Invalid label candidateId in ${name}`);
  if (!LABEL_KINDS.has(item.kind)) throw new Error(`Invalid label kind in ${name}`);
  if (typeof item.reviewed !== "boolean") throw new Error(`Invalid reviewed flag in ${name}`);
  return {
    candidateId: item.candidateId,
    kind: item.kind as LabelKind,
    reviewed: item.reviewed,
    ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
  };
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

function executionStatusOf(outcome: TrialOutcome): ExecutionStatus {
  if (outcome.completed) return "completed";
  if (outcome.cancelled) return "cancelled";
  if (outcome.error === "action_budget_exhausted" || outcome.error === "request_limit")
    return "incomplete";
  return "failed";
}

function isWiringFailure(error: string): boolean {
  return [...WIRING_FAILURES].some((prefix) => error === prefix || error.startsWith(`${prefix}:`));
}

function hasContractFailure(outcome: TrialOutcome): boolean {
  if (outcome.policyViolations.length > 0) return true;
  return outcome.error ? isWiringFailure(outcome.error) : false;
}

// Persistence failure is distinguished from execution failure: the trial's
// wiring was neither proven nor disproven.
function wiringStatusOf(outcome: TrialOutcome, executionStatus: ExecutionStatus): WiringStatus {
  const persistenceFailed =
    outcome.error === "persistence_failed" || outcome.error?.startsWith("persistence_failed:");
  if (persistenceFailed) return "not_evaluated";
  const contractFailure = hasContractFailure(outcome);
  if (executionStatus === "completed" && !contractFailure) return "passed";
  return contractFailure || executionStatus === "failed" ? "failed" : "not_evaluated";
}

export function scoreTrial(outcome: TrialOutcome): TrialScore {
  const executionStatus = executionStatusOf(outcome);
  const wiringStatus = wiringStatusOf(outcome, executionStatus);
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
