import type { AgentEvent, EventId, HotState } from "../../core/types.js";

export type * from "./types_records.js";
export type * from "./types_results.js";
export type * from "./types_task.js";
// config_parsing imports only types from this module, so this adds no runtime cycle.
export {
  isExperimentMode,
  parseHybridConfig,
  parseHybridTask,
  parseTaskScoring,
} from "./config_parsing.js";

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
