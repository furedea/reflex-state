import type { AgentEvent, EventId, HotState } from "../../core/types.js";

export const HYBRID_SCHEMA_VERSION = 2 as const;
/** Result artifacts (manifest/summary) move independently of the config
 * schema: v3 adds termination, final-artifact, and update-feedback fields. */
export const RESULT_SCHEMA_VERSION = 3 as const;
export const PROMPT_VERSION = "hybrid-state-prompt-v3" as const;
/** Identifies the comparison protocol (prompts + input fields) a run used, so
 * results are never mixed across protocol revisions. */
export const PROTOCOL_ID = "stage-a-followup-1" as const;

export type ExperimentMode = "history" | "llm" | "rules" | "jev";
export type EvaluationKind = "trace_audit" | "closed_loop";
export type ProviderMode = "fake" | "recorded" | "live";
export type MemoryKind = "constraints" | "decisions" | "findings" | "attempts" | "open_questions";
export type MemoryOrigin = "extracted" | "generated";
export type MemoryStatus = "active" | "deferred";
export type SourceTrust = "user" | "assistant" | "tool_result" | "unknown";
export type CandidateDisposition = "selected" | "held" | "omitted" | "rejected" | "unclassified";
export type RepairReason =
  | "budget_exceeded"
  | "ambiguous_reference"
  | "missing_evidence"
  | "invalid_update";
export type LabelKind = "deterministic" | "extractive" | "generative" | "insufficient";
export type ExecutionStatus = "completed" | "failed" | "cancelled" | "incomplete";
export type WiringStatus = "passed" | "failed" | "not_evaluated";
export type EfficacyStatus = "not_evaluated" | "descriptive_only";
export type ManifestStatus = "running" | "completed" | "failed" | "cancelled" | "incomplete";

export interface HybridBudgets {
  readonly memoryBytes: number;
  readonly factsBytes: number;
  readonly latestObservationBytes: number;
  readonly requestBytes: number;
  readonly maxQuestions: number;
  readonly maxRepairCalls: number;
  readonly maxActions: number;
}

export interface HybridProviderConfig {
  readonly mode: ProviderMode;
  readonly jevModel?: string;
  readonly actorModel?: string;
  readonly repairModel?: string;
  readonly updateModel?: string;
  readonly maxRequests: number;
  readonly trialMaxRequests: number;
  readonly timeoutMs: number;
  /** When "required", actor-produced code runs only inside the detected sandbox. */
  readonly executionIsolation?: "required";
}

export interface HybridConfig {
  readonly schemaVersion: 2;
  readonly evaluation: EvaluationKind;
  readonly provider: HybridProviderConfig;
  readonly budgets: HybridBudgets;
  readonly modes: readonly ExperimentMode[];
  readonly seed: number;
  readonly iterations: number;
  readonly recordContextText: boolean;
  /** Record raw provider text on decode failures in calls.jsonl (debug aid
   * for live runs; defaults off). */
  readonly recordResponseText: boolean;
  readonly candidateMaxBytes: number;
  readonly taskRoot?: string;
}

export interface TraceMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool_call" | "tool_result";
  readonly text: string;
  readonly sequence: number;
  readonly sourceId: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly truncated: boolean;
}

export interface TraceData {
  readonly format: "pi" | "event-only" | "synthetic";
  readonly sessionPath?: string;
  readonly leaf: string | null;
  readonly messages: readonly TraceMessage[];
  readonly events: readonly AgentEvent[];
  readonly missingText: readonly string[];
  readonly sourceHash: string;
}

export interface Candidate {
  readonly id: string;
  readonly category: MemoryKind;
  readonly sourceId: string;
  readonly sourceIds: readonly string[];
  readonly role: TraceMessage["role"];
  readonly trust: SourceTrust;
  readonly text: string;
  readonly context: string;
  readonly start: number;
  readonly end: number;
  readonly sourceHash: string;
  readonly observedAt: number;
  readonly truncated: boolean;
  readonly contextComplete: boolean;
}

export interface CandidateDecision {
  readonly candidateId: string;
  readonly disposition: CandidateDisposition;
  readonly reason: string;
  readonly probability?: number;
  readonly confidence?: number;
}

export interface MemoryItem {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly origin: MemoryOrigin;
  readonly trust: SourceTrust;
  readonly status: MemoryStatus;
  readonly updatedAt: number;
  readonly replaces?: string;
}

export type WorkMemory = Readonly<Record<MemoryKind, readonly MemoryItem[]>>;

/** Experiment-only verification fact for one declared test id, derived from
 * the task environment's per-check ledger. Multiple tests can each be
 * evaluated without one evicting the other. */
export interface ExperimentCheckFact {
  readonly testId: string;
  readonly status: "passed" | "failed";
  readonly freshness: "current" | "stale" | "unknown";
  readonly command: string;
  readonly checkKey: string;
  readonly observedGeneration: number;
}

export interface FactsView {
  readonly version: 2;
  readonly phase: HotState["phase"];
  readonly taskStatus: HotState["taskStatus"];
  readonly observationGeneration: number;
  readonly verification: HotState["verification"] & {
    readonly tests?: Readonly<Record<string, ExperimentCheckFact>>;
  };
  readonly unresolvedTotal: number;
  readonly blockers: readonly HotState["activeBlockers"][number][];
  readonly blockersOmitted: number;
  readonly modifiedFiles: readonly string[];
  readonly pendingChanges: readonly EventId[];
}

export interface UpdateInput {
  readonly mode: ExperimentMode;
  readonly instruction: string;
  readonly state: HotState;
  readonly facts: FactsView;
  readonly memory: WorkMemory;
  readonly candidates: readonly Candidate[];
  readonly observations: readonly TraceMessage[];
  readonly latest: readonly TraceMessage[];
  readonly step: number;
  readonly now: number;
}

export interface JevQuestion {
  readonly id: string;
  readonly kind: "choice";
  readonly prompt: string;
  readonly options: Readonly<Record<string, string>>;
  readonly candidateIds: readonly string[];
  readonly evidence: readonly string[];
}

export interface JevRequest {
  readonly questions: readonly JevQuestion[];
  readonly state: string;
  readonly model: string;
  readonly promptVersion: string;
}

export interface JevAnswer {
  readonly questionId: string;
  readonly choice: string;
  readonly probability?: number;
  readonly confidence?: number;
  readonly invalid?: string;
}

export interface JevResponse {
  readonly answers: readonly JevAnswer[];
  readonly usage?: Usage;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface PatchOperation {
  readonly operation: "add" | "replace";
  readonly itemId?: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly trust: SourceTrust;
  readonly origin: MemoryOrigin;
  readonly replaces?: string;
}

export interface UpdateProposal {
  readonly operations: readonly PatchOperation[];
  readonly source: "rules" | "jev" | "llm" | "repair";
  readonly repairReasons: readonly RepairReason[];
}

export interface UpdateResult {
  readonly memory: WorkMemory;
  readonly candidates: readonly Candidate[];
  readonly decisions: readonly CandidateDecision[];
  readonly held: readonly Candidate[];
  readonly applied: readonly PatchOperation[];
  readonly proposal?: UpdateProposal;
  readonly repairReasons: readonly RepairReason[];
  readonly unavailable?: string;
}

export interface RepairRequest {
  readonly state: string;
  readonly observations: readonly Candidate[];
  readonly reasons: readonly RepairReason[];
  readonly model: string;
  readonly promptVersion: string;
}

export interface RepairResponse {
  readonly operations?: readonly PatchOperation[];
  readonly rawText?: string;
  readonly usage?: Usage;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface GenerativeUpdateRequest {
  readonly mode: "llm";
  readonly instruction: string;
  readonly facts: string;
  readonly memory: string;
  readonly latest: string;
  readonly selfSourceId: string;
  readonly model: string;
  readonly promptVersion: string;
}

export interface GenerativeUpdateResponse {
  readonly operations?: readonly PatchOperation[];
  readonly rawText?: string;
  readonly usage?: Usage;
  readonly latencyMs?: number;
  readonly error?: string;
}

export type ActorTool = "read" | "write" | "edit" | "test" | "finish";

export interface ActorAction {
  readonly tool: ActorTool;
  readonly path?: string;
  readonly content?: string;
  readonly old?: string;
  readonly new?: string;
  readonly command?: string;
}

export interface ActorRequest {
  readonly mode: ExperimentMode;
  readonly taskId: string;
  /** Local metadata: identifies the trial for fake/recorded providers; never part of the sent text. */
  readonly trialId: string;
  /** Local metadata: the step index inside the trial. */
  readonly step: number;
  readonly system: string;
  readonly user: string;
  readonly allowedTools: readonly ActorTool[];
  readonly allowedTests: readonly string[];
  readonly model: string;
}

/** Whether the actor emitted a patch key at all: "missing" (absent),
 * "empty" (present and empty), or "present" (one or more operations). A
 * structurally invalid patch never reaches this tri-state; it is a decode
 * error instead. */
export type PatchInputKind = "missing" | "empty" | "present";

/** Which surface form the action arrived in; all normalize to the same
 * validated action but are counted so contract friction stays visible. */
export type ActionForm = "canonical" | "shorthand" | "bare";

/** Per-step feedback about the previous state patch, returned to the actor on
 * the next input only (never accumulated across steps). Reasons are short
 * enumerable codes; full detail stays in the local update records. */
export interface UpdateFeedback {
  readonly patchInput: PatchInputKind;
  readonly applied: readonly { readonly index: number; readonly memoryId: string }[];
  readonly unchanged: readonly number[];
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
  readonly appliedCount: number;
  readonly unchangedCount: number;
  readonly rejectedCount: number;
  readonly omittedDetailCount: number;
}

/** The shared action-budget view sent to the actor in both modes. */
export interface ActionBudgetView {
  readonly limit: number;
  readonly used: number;
  readonly remaining_including_next: number;
  readonly finish_counts_as_action: boolean;
}

export type TerminationReason =
  | "finish"
  | "action_budget"
  | "request_budget"
  | "policy_violation"
  | "contract_error"
  | "provider_error"
  | "state_unavailable"
  | "persistence_error"
  | "environment_error"
  | "cancelled";

/** Independent evaluation of the final workspace by the evaluator's oracles,
 * run regardless of whether the actor finished within budget. */
export interface FinalArtifactEvaluation {
  readonly status: "evaluated" | "not_evaluated";
  readonly reason?: string;
  readonly tests: Readonly<Record<string, "passed" | "failed" | "not_run">>;
}

/** The actor's own latest test run per declared test id at trial stop;
 * "stale" means the workspace changed after that run. */
export interface ActorVerificationEntry {
  readonly status: "passed" | "failed" | "not_run";
  readonly step?: number;
  readonly freshness?: "current" | "stale";
}

/** Per-trial patch accounting: how many steps emitted which patch shape and
 * how the proposed operations resolved. */
export interface PatchStats {
  readonly input: { readonly missing: number; readonly empty: number; readonly present: number };
  readonly proposed: number;
  readonly applied: number;
  readonly unchanged: number;
  readonly rejected: number;
}

export interface ActorResponse {
  readonly action?: ActorAction;
  readonly statePatch?: readonly PatchOperation[];
  readonly patchInput?: PatchInputKind;
  readonly actionForm?: ActionForm;
  readonly text?: string;
  /** Raw provider text when decoding failed; recorded only when the run opts
   * into response logging so contract failures stay inspectable. */
  readonly rawText?: string;
  /** The model id the provider reports having answered with, when available. */
  readonly responseModel?: string;
  readonly usage?: Usage;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface Usage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

export interface InputBundle {
  readonly mode: ExperimentMode;
  readonly instruction: string;
  readonly fixedTools: readonly string[];
  readonly facts: string;
  readonly memory: string;
  readonly latest: string;
  readonly history?: string;
  readonly bytes: {
    readonly total: number;
    readonly facts: number;
    readonly memory: number;
    readonly latest: number;
    readonly history: number;
    /** Protocol fields shared by both modes: action_budget plus the llm
     * last_update_result notification. */
    readonly feedback: number;
  };
  readonly truncated: readonly string[];
  readonly unavailable?: string;
}

/** Start-of-call record: lets a crash between invocation and response recording
 * be distinguished from "no request was made". */
export interface CallStartRecord {
  readonly record: "call_start";
  readonly callId: string;
  readonly runId: string;
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly step: number;
  readonly kind: CallRecord["kind"];
  readonly model: string;
  readonly startedAt: string;
  readonly requestBytes: number;
  readonly requestHash: string;
}

export interface CallRecord {
  readonly callId: string;
  readonly runId: string;
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly step: number;
  readonly kind: "actor" | "jev" | "repair" | "update";
  readonly model: string;
  /** The provider was invoked; this is not a direct observation of network I/O. */
  readonly providerInvoked: boolean;
  readonly requestBytes: number;
  readonly requestHash: string;
  readonly startedAt: string;
  readonly latencyMs: number | null;
  readonly usage?: Usage;
  readonly error?: string;
  /** Raw provider text for a failed decode, present only when the run opted
   * into response logging (`recordResponseText`). */
  readonly responseText?: string;
  /** The model id the provider actually answered with, when reported; never
   * assumed equal to the requested model. */
  readonly responseModel?: string;
  readonly attempts: number;
}

export interface ContextRecord {
  readonly runId: string;
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly step: number;
  readonly bytes: InputBundle["bytes"];
  readonly sentBytes: number;
  readonly included: readonly string[];
  readonly truncated: readonly string[];
  /** Hash of the system prompt sent with this step; the body is stored once
   * per run in system_prompts.jsonl when recordContextText is on. */
  readonly systemHash: string;
  readonly text?: string;
}

/** The system prompt body, stored once per distinct hash inside a run so the
 * full sent input stays reconstructible without duplicating static text. */
export interface SystemPromptRecord {
  readonly record: "system_prompt";
  readonly runId: string;
  readonly hash: string;
  readonly text: string;
}

export interface UpdateRecord {
  readonly runId: string;
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly step: number;
  readonly kind: "update" | "action" | "injection" | "audit_step" | "audit_summary";
  readonly [key: string]: unknown;
}

export interface AuditLabel {
  readonly candidateId: string;
  readonly kind: LabelKind;
  readonly reviewed: boolean;
  readonly reason?: string;
}

export interface TaskStep {
  readonly observation?: string;
  readonly action: ActorAction;
  readonly result: string;
  readonly statePatch?: readonly PatchOperation[];
}

export interface TaskInjection {
  /** Deliver this user message to the actor input built for this step index. */
  readonly step: number;
  readonly text: string;
}

export interface ObservationGroup {
  readonly messages: readonly TraceMessage[];
}

export interface SourceRef {
  readonly id: string;
  readonly role: TraceMessage["role"];
  readonly text: string;
  readonly trust: SourceTrust;
}

export interface HybridTask {
  readonly id: string;
  readonly instruction: string;
  readonly files: Readonly<Record<string, string>>;
  readonly allowedTests: readonly string[];
  readonly injections?: readonly TaskInjection[];
  readonly expectedFiles?: Readonly<Record<string, string>>;
  readonly steps?: readonly TaskStep[];
}

/** Requirement families: verbatim matches original text only inside items with
 * accepted provenance; exact_value compares a typed token with boundaries;
 * verification compares the structured latest check for a specific test id. */
export type RequirementKind = "verbatim" | "exact_value" | "verification";

export interface RequirementScope {
  /** Memory item kinds allowed to carry the requirement (state-first inputs). */
  readonly memoryKinds?: readonly string[];
  /** Memory trusts allowed to carry the requirement. */
  readonly trusts?: readonly string[];
  /** Message roles allowed to carry the requirement (history lines, observation
   * items, the instruction). */
  readonly roles?: readonly string[];
}

export interface CheckpointRequirement {
  readonly id: string;
  readonly description?: string;
  /** Requirement family; defaults to verbatim. */
  readonly kind: RequirementKind;
  /** verbatim: acceptable verbatim forms; any group whose strings all appear in
   * one clean provenance-eligible item retains the requirement. */
  readonly anyOf?: readonly (readonly string[])[];
  /** verbatim: forms that invert the required meaning; an item containing any of
   * them is disqualified even when it also carries the canonical text. */
  readonly inverted?: readonly string[];
  /** verbatim: required accompanying phrase inside the same item. */
  readonly condition?: string;
  /** verbatim: provenance filter; an item must match at least one clause. */
  readonly scope?: RequirementScope;
  /** exact_value: the token compared with numeric/name boundaries, never as a
   * substring (9377 does not match inside 19377). */
  readonly value?: string;
  /** exact_value: when set, the value must be bound to this name
   * (`NAME=VALUE`), so the same number under a different name does not count. */
  readonly name?: string;
  /** verification: the test id whose latest check is compared. */
  readonly testId?: string;
  /** verification: required status (default "passed"). */
  readonly status?: "passed" | "failed";
  /** verification: require the check to be current (default true). */
  readonly fresh?: boolean;
  /** Distinctive substrings: present without canonical text marks an unverifiable paraphrase. */
  readonly markers?: readonly string[];
  /** userText JSON sections to search; defaults to all sections. */
  readonly sections?: readonly string[];
}

export interface TaskCheckpoint {
  readonly id: string;
  readonly at: number | "final";
  /** Optional applicability condition; when unmet the checkpoint is not_applicable. */
  readonly appliesWhen?: "always" | "failure_observed";
  readonly required: readonly CheckpointRequirement[];
}

export interface TaskOracle {
  readonly testId: string;
  readonly kind: "script" | "expected_files";
  readonly script?: string;
}

export interface TaskScoring {
  readonly taskId: string;
  readonly oracles?: readonly TaskOracle[];
  readonly checkpoints?: readonly TaskCheckpoint[];
  readonly expectedFiles?: Readonly<Record<string, string>>;
}

export interface CheckpointItemResult {
  readonly id: string;
  readonly retained: boolean | null;
  readonly reason?: string;
}

export interface CheckpointResult {
  readonly checkpointId: string;
  readonly step: number;
  readonly items: readonly CheckpointItemResult[];
}

export interface TrialScore {
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly iteration: number;
  readonly executionStatus: ExecutionStatus;
  readonly wiringStatus: WiringStatus;
  readonly efficacyStatus: EfficacyStatus;
  readonly failureReason?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallMs: number;
  readonly completed: boolean;
  /** Why the trial stopped: finish, a budget, or an error class. */
  readonly terminationReason: TerminationReason;
  /** The actor chose finish within the action budget; a correct final
   * artifact alone never sets this. */
  readonly finishedWithinBudget: boolean;
  readonly testPassed: boolean;
  /** Independent task-constraint score from oracle-reported verdicts; null when
   * the task declared no constraints. Never derived from policy violations. */
  readonly constraintPassed: boolean | null;
  /** Per-constraint verdicts reported by oracles across the trial. */
  readonly constraints: Readonly<Record<string, boolean>>;
  readonly tests: Readonly<Record<string, "passed" | "failed" | "not_run">>;
  /** Evaluator-side oracle results on the final workspace, separate from the
   * actor's own test runs; "not_evaluated" keeps an explicit reason. */
  readonly finalArtifact: FinalArtifactEvaluation;
  /** Constraint verdicts from the final artifact evaluation only; null when no
   * constraint verdicts were produced at all. Mid-run violations recorded in
   * `constraints` stay sticky and are never cleared by this field. */
  readonly finalConstraintVerdicts: Readonly<Record<string, boolean>> | null;
  readonly actorVerificationAtStop: Readonly<Record<string, ActorVerificationEntry>>;
  readonly actorTests: readonly {
    readonly testId: string;
    readonly step: number;
    readonly passed: boolean;
    readonly generation?: number;
  }[];
  /** llm-mode patch accounting; zero in history mode. */
  readonly patchStats: PatchStats;
  readonly actionForms: Readonly<Record<ActionForm, number>>;
  readonly checkpoints: readonly CheckpointResult[];
  readonly rereads: number;
  readonly retries: number;
  readonly appliedExtractive: number;
  readonly appliedGenerated: number;
  readonly activeMemoryItems: number;
}

export interface SkippedTrial {
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly iteration: number;
  readonly reason: "not_run_global_budget" | "persistence_failed" | "cancelled";
}

/** Per-usage-field totals that distinguish "not measured" from "measured zero". */
export interface UsageFieldSummary {
  /** Sum over calls where the field was reported; null when no call reported it. */
  readonly observedSubtotal: number | null;
  /** Sum over all invoked calls; null unless every invoked call reported the field. */
  readonly completeTotal: number | null;
  /** calls reporting the field / invoked calls. */
  readonly coverage: number;
}

export interface ModeMetrics {
  readonly uniqueCandidates: number;
  readonly decisionCount: number;
  readonly appliedExtractive: number;
  readonly appliedGenerated: number;
  readonly invocations: Readonly<Record<"actor" | "jev" | "repair" | "update", number>>;
  /** Application-side request bytes (serialized system+user bodies), not HTTP or token counts. */
  readonly sentBytes: number;
  readonly usage: {
    readonly inputTokens: UsageFieldSummary;
    readonly outputTokens: UsageFieldSummary;
    readonly cacheReadTokens: UsageFieldSummary;
    readonly cacheWriteTokens: UsageFieldSummary;
  };
  readonly wallMs: number;
  readonly contextBytes: number;
}

export interface ExperimentEnvironment {
  readonly node: string;
  readonly platform: string;
  /** Isolation actually verified on this host for this run, if any. */
  readonly isolation: "none" | "sandbox-exec" | "unverified";
}

export interface ExperimentManifest {
  readonly schemaVersion: typeof RESULT_SCHEMA_VERSION;
  /** Comparison protocol (prompt + input contract) the run was produced
   * under; results are only comparable within the same protocolId. */
  readonly protocolId: typeof PROTOCOL_ID;
  readonly runId: string;
  readonly status: ManifestStatus;
  readonly head: string | null;
  /** True when the working tree had uncommitted changes at run start; a dirty
   * tree means `head` alone does not identify the executed code. */
  readonly dirty?: boolean;
  readonly inputHash: string;
  /** Content hash of the task root's task + scoring files (closed_loop only). */
  readonly taskSetHash?: string;
  /** sha256 of each mode's system prompt text. */
  readonly promptHashes?: Readonly<Record<string, string>>;
  /** Runtime evidence for reproduction: interpreter, lockfile, and whether
   * generation options were sent explicitly or left to provider defaults. */
  readonly runtime?: {
    readonly node: string;
    readonly platform: string;
    readonly lockfileHash?: string;
    readonly generationOptions: string;
  };
  readonly config: HybridConfig;
  readonly modes: readonly ExperimentMode[];
  readonly provider: ProviderMode;
  readonly evaluation: EvaluationKind;
  readonly modelIds: Readonly<Record<string, string | null>>;
  readonly sdkVersion: string;
  readonly promptVersion: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
  /** Pipeline stage that failed, when status is "failed" (e.g. "recording", "execution"). */
  readonly failedStage?: string;
  readonly environment?: ExperimentEnvironment;
  readonly privacy: {
    readonly recordContextText: boolean;
    readonly recordResponseText: boolean;
  };
}

export interface ExperimentSummary {
  readonly schemaVersion: typeof RESULT_SCHEMA_VERSION;
  readonly protocolId: typeof PROTOCOL_ID;
  readonly runId: string;
  readonly evaluation: EvaluationKind;
  readonly provider: ProviderMode;
  readonly modes: readonly ExperimentMode[];
  readonly efficacyStatus: EfficacyStatus;
  readonly wiring: {
    readonly passed: number;
    readonly failed: number;
    readonly notEvaluated: number;
  };
  readonly scores: readonly TrialScore[];
  readonly plannedTrials: number;
  readonly skippedTrials: readonly SkippedTrial[];
  readonly metrics: Readonly<Record<ExperimentMode, ModeMetrics>>;
  readonly environment?: ExperimentEnvironment;
  readonly limitations: readonly string[];
}

export function emptyMemory(): WorkMemory {
  return {
    constraints: [],
    decisions: [],
    findings: [],
    attempts: [],
    open_questions: [],
  };
}

export function emptyUsage(): Usage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  };
}

export function isExperimentMode(value: unknown): value is ExperimentMode {
  return value === "history" || value === "llm" || value === "rules" || value === "jev";
}
