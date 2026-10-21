import type {
  ActionForm,
  ActorVerificationEntry,
  EfficacyStatus,
  EvaluationKind,
  ExecutionStatus,
  ExperimentMode,
  FinalArtifactEvaluation,
  HybridConfig,
  ManifestStatus,
  PatchStats,
  PROTOCOL_ID,
  ProviderMode,
  RESULT_SCHEMA_VERSION,
  TerminationReason,
  WiringStatus,
} from "./types.js";

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
