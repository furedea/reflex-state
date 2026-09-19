import type { AgentEvent, EventId, HotState } from "../../core/types.js";

export const HYBRID_SCHEMA_VERSION = 2 as const;
export const PROMPT_VERSION = "hybrid-state-prompt-v2" as const;

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
  readonly text?: string;
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
  readonly testPassed: boolean;
  /** Independent task-constraint score from oracle-reported verdicts; null when
   * the task declared no constraints. Never derived from policy violations. */
  readonly constraintPassed: boolean | null;
  /** Per-constraint verdicts reported by oracles across the trial. */
  readonly constraints: Readonly<Record<string, boolean>>;
  readonly tests: Readonly<Record<string, "passed" | "failed" | "not_run">>;
  readonly actorTests: readonly {
    readonly testId: string;
    readonly step: number;
    readonly passed: boolean;
  }[];
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
  readonly reason: "not_run_global_budget" | "persistence_failed";
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
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly status: ManifestStatus;
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
  readonly finishedAt?: string;
  readonly error?: string;
  /** Pipeline stage that failed, when status is "failed" (e.g. "recording", "execution"). */
  readonly failedStage?: string;
  readonly environment?: ExperimentEnvironment;
  readonly privacy: { readonly recordContextText: boolean };
}

export interface ExperimentSummary {
  readonly schemaVersion: 2;
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

const PROVIDER_MODES = new Set(["fake", "recorded", "live"]);
const EVALUATIONS = new Set(["trace_audit", "closed_loop"]);
const PROVIDER_KEYS = new Set([
  "mode",
  "jevModel",
  "actorModel",
  "repairModel",
  "updateModel",
  "maxRequests",
  "trialMaxRequests",
  "timeoutMs",
  "executionIsolation",
]);
const BUDGET_KEYS = new Set([
  "memoryBytes",
  "factsBytes",
  "latestObservationBytes",
  "requestBytes",
  "maxQuestions",
  "maxRepairCalls",
  "maxActions",
]);
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "evaluation",
  "provider",
  "budgets",
  "modes",
  "seed",
  "iterations",
  "recordContextText",
  "candidateMaxBytes",
  "taskRoot",
]);

export function parseHybridConfig(value: unknown): HybridConfig {
  const raw = object(value, "config");
  unknownKeys(raw, CONFIG_KEYS, "config");
  if (raw.schemaVersion !== 2)
    throw new Error("Unsupported hybrid-state config version (expected 2)");
  if (typeof raw.evaluation !== "string" || !EVALUATIONS.has(raw.evaluation))
    throw new Error("Invalid hybrid-state evaluation");
  const provider = object(raw.provider, "provider");
  unknownKeys(provider, PROVIDER_KEYS, "provider");
  const budgets = object(raw.budgets, "budgets");
  unknownKeys(budgets, BUDGET_KEYS, "budgets");
  if (!Array.isArray(raw.modes) || !raw.modes.length || !raw.modes.every(isExperimentMode))
    throw new Error("Config modes must be a non-empty list of supported modes");
  if (new Set(raw.modes).size !== raw.modes.length)
    throw new Error("Config modes must not contain duplicates");
  const providerMode = provider.mode;
  if (typeof providerMode !== "string" || !PROVIDER_MODES.has(providerMode))
    throw new Error("Invalid provider mode");
  const model = (key: "jevModel" | "actorModel" | "repairModel" | "updateModel") => {
    const value = provider[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim())
      throw new Error(`Invalid provider.${key}: model IDs must be non-empty`);
    return value;
  };
  const models = {
    jevModel: model("jevModel"),
    actorModel: model("actorModel"),
    repairModel: model("repairModel"),
    updateModel: model("updateModel"),
  };
  if (providerMode === "live") {
    const needsActor = raw.evaluation === "closed_loop";
    const needsJev = (raw.modes as ExperimentMode[]).includes("jev");
    const needsUpdate = raw.evaluation === "trace_audit" && raw.modes.includes("llm");
    if (needsActor && !models.actorModel)
      throw new Error("Live closed_loop config requires provider.actorModel");
    if (needsJev && !models.jevModel)
      throw new Error("Live config with the jev mode requires provider.jevModel");
    if (needsUpdate && !models.updateModel && !models.actorModel)
      throw new Error("Live audit with the llm mode requires provider.updateModel or actorModel");
    if (
      !needsJev &&
      models.jevModel &&
      !(raw.modes as ExperimentMode[]).includes("jev") &&
      providerMode === "live"
    ) {
      // An unused Jev model is permitted but must never be instantiated silently.
    }
  }
  const integer = (obj: Record<string, unknown>, key: string, min: number) => {
    const number = obj[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < min)
      throw new Error(`Invalid config ${key}: expected an integer >= ${min}`);
    return number;
  };
  const maxRequests = integer(provider, "maxRequests", 1);
  const trialMaxRequests =
    provider.trialMaxRequests === undefined
      ? maxRequests
      : integer(provider, "trialMaxRequests", 1);
  if (trialMaxRequests > maxRequests)
    throw new Error("provider.trialMaxRequests must not exceed provider.maxRequests");
  return {
    schemaVersion: 2,
    evaluation: raw.evaluation as EvaluationKind,
    provider: {
      mode: providerMode as ProviderMode,
      ...(models.jevModel ? { jevModel: models.jevModel } : {}),
      ...(models.actorModel ? { actorModel: models.actorModel } : {}),
      ...(models.repairModel ? { repairModel: models.repairModel } : {}),
      ...(models.updateModel ? { updateModel: models.updateModel } : {}),
      maxRequests,
      trialMaxRequests,
      timeoutMs: integer(provider, "timeoutMs", 1),
      ...(provider.executionIsolation === "required"
        ? { executionIsolation: "required" as const }
        : provider.executionIsolation === undefined
          ? {}
          : (() => {
              throw new Error("Invalid provider.executionIsolation");
            })()),
    },
    budgets: {
      memoryBytes: integer(budgets, "memoryBytes", 1),
      factsBytes: integer(budgets, "factsBytes", 1),
      latestObservationBytes: integer(budgets, "latestObservationBytes", 1),
      requestBytes: integer(budgets, "requestBytes", 1),
      maxQuestions: integer(budgets, "maxQuestions", 1),
      maxRepairCalls: integer(budgets, "maxRepairCalls", 0),
      maxActions: integer(budgets, "maxActions", 1),
    },
    modes: [...(raw.modes as ExperimentMode[])],
    seed: integer(raw, "seed", 0),
    iterations: raw.iterations === undefined ? 1 : integer(raw, "iterations", 1),
    recordContextText: raw.recordContextText === true,
    candidateMaxBytes: integer(raw, "candidateMaxBytes", 64),
    ...(typeof raw.taskRoot === "string" ? { taskRoot: raw.taskRoot } : {}),
  };
}

export function parseHybridTask(value: unknown, file: string): HybridTask {
  const raw = object(value, `task ${file}`);
  if (typeof raw.id !== "string" || !raw.id.trim()) throw new Error(`Invalid task id in ${file}`);
  if (typeof raw.instruction !== "string" || !raw.instruction.trim())
    throw new Error(`Invalid task instruction in ${file}`);
  const files = object(raw.files, `task ${file} files`);
  for (const [path, content] of Object.entries(files))
    if (typeof content !== "string") throw new Error(`Invalid file ${path} in ${file}`);
  const allowedTests = raw.allowedTests ?? raw.tests;
  if (!Array.isArray(allowedTests) || allowedTests.some((test) => typeof test !== "string"))
    throw new Error(`Invalid allowedTests in ${file}`);
  const injections = raw.injections ?? [];
  if (!Array.isArray(injections)) throw new Error(`Invalid injections in ${file}`);
  for (const injection of injections) {
    const record = object(injection, `injection in ${file}`);
    if (
      !Number.isInteger(record.step) ||
      (record.step as number) < 0 ||
      typeof record.text !== "string" ||
      !record.text.trim()
    )
      throw new Error(`Invalid injection in ${file}`);
  }
  const steps = raw.steps === undefined ? undefined : raw.steps;
  if (steps !== undefined && !Array.isArray(steps)) throw new Error(`Invalid steps in ${file}`);
  const expectedFiles =
    raw.expectedFiles === undefined ? undefined : object(raw.expectedFiles, "expectedFiles");
  if (expectedFiles)
    for (const content of Object.values(expectedFiles))
      if (typeof content !== "string") throw new Error(`Invalid expectedFiles in ${file}`);
  return {
    id: raw.id,
    instruction: raw.instruction,
    files: files as Record<string, string>,
    allowedTests: [...(allowedTests as string[])],
    injections: injections.map((injection) => ({
      step: (injection as Record<string, unknown>).step as number,
      text: (injection as Record<string, unknown>).text as string,
    })),
    ...(expectedFiles ? { expectedFiles: expectedFiles as Record<string, string> } : {}),
    ...(steps ? { steps: steps as TaskStep[] } : {}),
  };
}

export function parseTaskScoring(value: unknown, file: string): TaskScoring {
  const raw = object(value, `scoring ${file}`);
  if (typeof raw.taskId !== "string" || !raw.taskId.trim())
    throw new Error(`Invalid taskId in ${file}`);
  const oracles = raw.oracles === undefined ? [] : raw.oracles;
  if (!Array.isArray(oracles)) throw new Error(`Invalid oracles in ${file}`);
  const parsedOracles = oracles.map((oracle) => {
    const record = object(oracle, `oracle in ${file}`);
    if (typeof record.testId !== "string" || !record.testId.trim())
      throw new Error(`Invalid oracle testId in ${file}`);
    if (record.kind === "script") {
      if (typeof record.script !== "string" || !record.script.trim())
        throw new Error(`Script oracle ${record.testId} in ${file} needs a script`);
      return { testId: record.testId, kind: "script" as const, script: record.script };
    }
    if (record.kind === "expected_files")
      return { testId: record.testId, kind: "expected_files" as const };
    throw new Error(`Invalid oracle kind in ${file}`);
  });
  const checkpoints = raw.checkpoints === undefined ? [] : raw.checkpoints;
  if (!Array.isArray(checkpoints)) throw new Error(`Invalid checkpoints in ${file}`);
  const parsedCheckpoints = checkpoints.map((checkpoint) => {
    const record = object(checkpoint, `checkpoint in ${file}`);
    if (typeof record.id !== "string" || !record.id.trim())
      throw new Error(`Invalid checkpoint id in ${file}`);
    if (!(record.at === "final" || (Number.isInteger(record.at) && (record.at as number) >= 0)))
      throw new Error(`Invalid checkpoint position in ${file}`);
    const required = record.required;
    if (!Array.isArray(required)) throw new Error(`Invalid required in ${file}`);
    const items = required.map((item) => {
      const entry = object(item, `required item in ${file}`);
      if (typeof entry.id !== "string" || !entry.id.trim())
        throw new Error(`Invalid required item id in ${file}`);
      const id = entry.id;
      const kind = entry.kind === undefined ? "verbatim" : entry.kind;
      if (kind !== "verbatim" && kind !== "exact_value" && kind !== "verification")
        throw new Error(`Invalid kind for required item ${id} in ${file}`);
      const strings = (key: string) => {
        const value = entry[key];
        if (value === undefined) return undefined;
        if (
          !Array.isArray(value) ||
          !value.every((item) => typeof item === "string" && item.trim())
        )
          throw new Error(`Invalid ${key} for required item ${id} in ${file}`);
        return [...(value as string[])];
      };
      const anyOf =
        entry.anyOf === undefined
          ? undefined
          : (() => {
              if (
                !Array.isArray(entry.anyOf) ||
                !entry.anyOf.length ||
                !entry.anyOf.every(
                  (group) =>
                    Array.isArray(group) &&
                    group.length > 0 &&
                    group.every((phrase) => typeof phrase === "string" && phrase.trim()),
                )
              )
                throw new Error(`Invalid anyOf for required item ${id} in ${file}`);
              return (entry.anyOf as string[][]).map((group) => [...group]);
            })();
      if (kind === "verbatim" && !anyOf)
        throw new Error(`verbatim required item ${id} in ${file} needs anyOf`);
      if (kind === "exact_value" && (typeof entry.value !== "string" || !entry.value.trim()))
        throw new Error(`exact_value required item ${id} in ${file} needs a value`);
      if (kind === "verification" && (typeof entry.testId !== "string" || !entry.testId.trim()))
        throw new Error(`verification required item ${id} in ${file} needs a testId`);
      if (entry.condition !== undefined && typeof entry.condition !== "string")
        throw new Error(`Invalid condition for required item ${id} in ${file}`);
      if (entry.status !== undefined && entry.status !== "passed" && entry.status !== "failed")
        throw new Error(`Invalid status for required item ${id} in ${file}`);
      if (entry.fresh !== undefined && typeof entry.fresh !== "boolean")
        throw new Error(`Invalid fresh for required item ${id} in ${file}`);
      const scope = (() => {
        if (entry.scope === undefined) return undefined;
        const record = object(entry.scope, `scope of ${id} in ${file}`);
        const clause = (key: string) => {
          const value = record[key];
          if (value === undefined) return undefined;
          if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim()))
            throw new Error(`Invalid scope.${key} for required item ${id} in ${file}`);
          return [...(value as string[])];
        };
        return {
          ...(clause("memoryKinds") ? { memoryKinds: clause("memoryKinds")! } : {}),
          ...(clause("trusts") ? { trusts: clause("trusts")! } : {}),
          ...(clause("roles") ? { roles: clause("roles")! } : {}),
        };
      })();
      return {
        id,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        kind: kind as RequirementKind,
        ...(anyOf ? { anyOf } : {}),
        ...(strings("inverted") ? { inverted: strings("inverted")! } : {}),
        ...(typeof entry.condition === "string" ? { condition: entry.condition } : {}),
        ...(scope ? { scope } : {}),
        ...(typeof entry.value === "string" ? { value: entry.value } : {}),
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        ...(typeof entry.testId === "string" ? { testId: entry.testId } : {}),
        ...(entry.status !== undefined ? { status: entry.status as "passed" | "failed" } : {}),
        ...(entry.fresh !== undefined ? { fresh: entry.fresh as boolean } : {}),
        ...(strings("markers") ? { markers: strings("markers")! } : {}),
        ...(strings("sections") ? { sections: strings("sections")! } : {}),
      };
    });
    if (
      record.appliesWhen !== undefined &&
      record.appliesWhen !== "always" &&
      record.appliesWhen !== "failure_observed"
    )
      throw new Error(`Invalid appliesWhen in ${file}`);
    return {
      id: record.id,
      at: record.at as number | "final",
      ...(typeof record.appliesWhen === "string"
        ? { appliesWhen: record.appliesWhen as "always" | "failure_observed" }
        : {}),
      required: items,
    };
  });
  const expectedFiles =
    raw.expectedFiles === undefined ? undefined : object(raw.expectedFiles, "expectedFiles");
  if (expectedFiles)
    for (const content of Object.values(expectedFiles))
      if (typeof content !== "string") throw new Error(`Invalid expectedFiles in ${file}`);
  return {
    taskId: raw.taskId,
    oracles: parsedOracles,
    checkpoints: parsedCheckpoints,
    ...(expectedFiles ? { expectedFiles: expectedFiles as Record<string, string> } : {}),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function unknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, name: string) {
  for (const key of Object.keys(raw))
    if (!allowed.has(key)) throw new Error(`Unknown ${name} key: ${key}`);
}
