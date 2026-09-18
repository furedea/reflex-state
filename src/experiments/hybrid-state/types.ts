import type { AgentEvent, EventId, HotState } from "../../core/types.js";

export const HYBRID_SCHEMA_VERSION = 1 as const;
export const PROMPT_VERSION = "hybrid-state-prompt-v1" as const;

export type ExperimentMode = "history" | "llm" | "rules" | "jev";
export type EvaluationKind = "trace_audit" | "closed_loop";
export type ProviderMode = "fake" | "recorded" | "live";
export type MemoryKind = "constraints" | "decisions" | "findings" | "attempts" | "open_questions";
export type MemoryOrigin = "extracted" | "generated";
export type MemoryStatus = "active" | "deferred";
export type SourceTrust = "user" | "assistant" | "tool_result" | "unknown";
export type CandidateDisposition = "selected" | "held" | "omitted" | "unclassified";
export type RepairReason =
  | "budget_exceeded"
  | "ambiguous_reference"
  | "missing_evidence"
  | "invalid_update";
export type LabelKind = "deterministic" | "extractive" | "generative" | "insufficient";

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
  readonly maxRequests: number;
  readonly timeoutMs: number;
}

export interface HybridConfig {
  readonly schemaVersion: 1;
  readonly evaluation: EvaluationKind;
  readonly provider: HybridProviderConfig;
  readonly budgets: HybridBudgets;
  readonly modes: readonly ExperimentMode[];
  readonly seed: number;
  readonly recordContextText: boolean;
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

export interface FactsView {
  readonly version: 2;
  readonly phase: HotState["phase"];
  readonly taskStatus: HotState["taskStatus"];
  readonly observationGeneration: number;
  readonly verification: HotState["verification"];
  readonly unresolvedTotal: number;
  readonly blockers: readonly HotState["activeBlockers"][number][];
  readonly blockersOmitted: number;
  readonly modifiedFiles: readonly string[];
  readonly pendingChanges: readonly EventId[];
}

export interface UpdateInput {
  readonly mode: ExperimentMode;
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
  readonly operations: readonly PatchOperation[];
  readonly usage?: Usage;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface ActorAction {
  readonly tool: "read" | "write" | "edit" | "test" | "finish";
  readonly path?: string;
  readonly content?: string;
  readonly replacement?: string;
  readonly command?: string;
}

export interface ActorRequest {
  readonly mode: ExperimentMode;
  readonly taskId: string;
  readonly instruction: string;
  readonly input: InputBundle;
  readonly allowedTools: readonly ActorAction["tool"][];
  readonly model: string;
  readonly promptVersion: string;
}

export interface ActorResponse {
  readonly action?: ActorAction;
  readonly statePatch?: readonly PatchOperation[];
  readonly text?: string;
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
  };
  readonly truncated: readonly string[];
  readonly unavailable?: string;
}

export interface CallRecord {
  readonly kind: "actor" | "jev" | "repair";
  readonly mode: ExperimentMode;
  readonly model: string;
  readonly requestBytes: number;
  readonly startedAt: string;
  readonly latencyMs: number | null;
  readonly usage?: Usage;
  readonly error?: string;
  readonly attempts: number;
}

export interface ContextRecord {
  readonly mode: ExperimentMode;
  readonly step: number;
  readonly bytes: InputBundle["bytes"];
  readonly included: readonly string[];
  readonly truncated: readonly string[];
  readonly text?: string;
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

export interface HybridTask {
  readonly id: string;
  readonly instruction: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expectedFiles?: Readonly<Record<string, string>>;
  readonly steps: readonly TaskStep[];
  readonly tests: readonly string[];
}

export interface RunScore {
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly completed: boolean;
  readonly testPassed: boolean;
  readonly informationRetained: boolean;
  readonly policyViolations: readonly string[];
  readonly rereads: number;
  readonly retries: number;
  readonly unavailable?: string;
}

export interface ExperimentManifest {
  readonly schemaVersion: 1;
  readonly head: string | null;
  readonly inputHash: string;
  readonly config: HybridConfig;
  readonly modes: readonly ExperimentMode[];
  readonly provider: ProviderMode;
  readonly evaluation: EvaluationKind;
  readonly modelIds: Readonly<Record<string, string | null>>;
  readonly sdkVersion: string;
  readonly promptVersion: string;
  readonly startedAt: string;
  readonly privacy: { readonly recordContextText: boolean };
}

export interface ExperimentSummary {
  readonly evaluation: EvaluationKind;
  readonly modes: readonly ExperimentMode[];
  readonly calls: number;
  readonly scores: readonly RunScore[];
  readonly retainedCandidates: number;
  readonly generatedItems: number;
  readonly repairCalls: number;
  readonly totalContextBytes: Readonly<Record<ExperimentMode, number>>;
  readonly judgement: "promising" | "no_benefit_observed" | "insufficient_evidence";
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

export function parseHybridConfig(value: unknown): HybridConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid hybrid-state config");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("Unsupported hybrid-state config version");
  if (raw.evaluation !== "trace_audit" && raw.evaluation !== "closed_loop")
    throw new Error("Invalid hybrid-state evaluation");
  const provider = object(raw.provider, "provider");
  const budgets = object(raw.budgets, "budgets");
  const modes = Array.isArray(raw.modes) ? raw.modes.filter(isExperimentMode) : [];
  if (!modes.length || modes.length !== (Array.isArray(raw.modes) ? raw.modes.length : 0))
    throw new Error("Config modes must contain supported modes");
  const numberField = (obj: Record<string, unknown>, key: string, min: number) => {
    const number = obj[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < min)
      throw new Error(`Invalid config ${key}`);
    return number;
  };
  const providerMode = provider.mode;
  if (providerMode !== "fake" && providerMode !== "recorded" && providerMode !== "live")
    throw new Error("Invalid provider mode");
  if (providerMode === "live" && (!provider.actorModel || !provider.jevModel))
    throw new Error("Live config requires actorModel and jevModel");
  return {
    schemaVersion: 1,
    evaluation: raw.evaluation,
    provider: {
      mode: providerMode,
      ...(typeof provider.jevModel === "string" ? { jevModel: provider.jevModel } : {}),
      ...(typeof provider.actorModel === "string" ? { actorModel: provider.actorModel } : {}),
      ...(typeof provider.repairModel === "string" ? { repairModel: provider.repairModel } : {}),
      maxRequests: numberField(provider, "maxRequests", 1),
      timeoutMs: numberField(provider, "timeoutMs", 1),
    },
    budgets: {
      memoryBytes: numberField(budgets, "memoryBytes", 1),
      factsBytes: numberField(budgets, "factsBytes", 1),
      latestObservationBytes: numberField(budgets, "latestObservationBytes", 1),
      requestBytes: numberField(budgets, "requestBytes", 1),
      maxQuestions: numberField(budgets, "maxQuestions", 1),
      maxRepairCalls: numberField(budgets, "maxRepairCalls", 0),
      maxActions: numberField(budgets, "maxActions", 1),
    },
    modes: [...modes],
    seed: numberField(raw, "seed", 0),
    recordContextText: raw.recordContextText === true,
    candidateMaxBytes: numberField(raw, "candidateMaxBytes", 64),
    ...(typeof raw.taskRoot === "string" ? { taskRoot: raw.taskRoot } : {}),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
