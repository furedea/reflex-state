import type { ReflexStateConfig } from "./config.js";

export type EventId = `E${string}`;
export type AgentPhase =
  | "planning"
  | "exploring"
  | "editing"
  | "testing"
  | "debugging"
  | "done"
  | "unknown";
export type TaskStatus = "in_progress" | "blocked" | "completed" | "unknown";
export type VerificationKind = "build" | "test" | "lint";
export type VerificationStatus = "not_run" | "running" | "passed" | "failed" | "unknown";
export type VerificationFreshness = "current" | "stale" | "unknown";
export type BlockerCategory =
  | "implementation"
  | "environment"
  | "dependency"
  | "test"
  | "permissions"
  | "network"
  | "unknown";

export interface SourceRef {
  readonly kind: "tool_call" | "user_prompt" | "assistant_message";
  readonly toolCallId?: string;
  readonly timestamp: number;
}

export interface Excerpt {
  readonly head: string;
  readonly tail?: string;
  readonly totalChars: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

interface BaseEvent {
  readonly id: EventId;
  readonly timestamp: string;
  readonly turnIndex: number;
  readonly source: SourceRef;
}

export interface UserPromptEvent extends BaseEvent {
  readonly type: "user_prompt";
  readonly text: string;
}

export interface ToolCallEvent extends BaseEvent {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly commandTruncated?: boolean;
  readonly cwd?: string;
}

export interface ToolResultEvent extends BaseEvent {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly excerpt: Excerpt;
}

export interface AgentEndEvent extends BaseEvent {
  readonly type: "agent_end";
  readonly finalText: Excerpt;
  readonly stopReason: "stop" | "length" | "error" | "aborted";
}

export interface FileChangeEvent extends BaseEvent {
  readonly type: "file_change";
  readonly paths: readonly string[];
}

export interface SessionResumeEvent extends BaseEvent {
  readonly type: "session_resume";
  readonly reason: "resume" | "branch_switch";
}

export type AgentEvent =
  | UserPromptEvent
  | ToolCallEvent
  | ToolResultEvent
  | AgentEndEvent
  | FileChangeEvent
  | SessionResumeEvent;

export interface VerificationState {
  readonly status: VerificationStatus;
  readonly freshness?: VerificationFreshness;
  readonly evidence?: EventId;
  readonly command?: string;
  readonly cwd?: string;
  readonly checkKey?: string;
  readonly observedGeneration?: number;
  readonly startedEvent?: EventId;
  readonly attributable?: boolean;
  readonly unknownReason?: string;
}

export type Blocker = {
  readonly eventId: EventId;
  readonly category: BlockerCategory;
} & (
  | { readonly origin: "verification"; readonly kind: VerificationKind; readonly checkKey?: string }
  | { readonly origin: "tool_error"; readonly kind?: never }
);

export interface HotState {
  readonly version: 2;
  readonly goal: EventId | null;
  readonly phase: AgentPhase;
  readonly taskStatus: TaskStatus;
  readonly modifiedFiles: readonly string[];
  readonly relevantFiles: readonly string[];
  readonly verification: Readonly<Record<VerificationKind, VerificationState>>;
  readonly activeBlockers: readonly Blocker[];
  readonly workingSet: readonly EventId[];
  readonly observationGeneration?: number;
  readonly pendingChanges?: readonly EventId[];
  readonly stateHealth?: "valid" | "legacy_state_requires_reset" | "invalid";
  readonly cursor: {
    readonly lastEventId: EventId | null;
    readonly eventCount: number;
    readonly turnIndex: number;
  };
  readonly lastUpdatedAt: string;
}

export interface VerificationFact {
  readonly kind: VerificationKind;
  readonly status: VerificationStatus;
  readonly command: string;
  readonly cwd: string;
  readonly compound: boolean;
  readonly attributable: boolean;
  readonly checkKey?: string;
  readonly unknownReason?: string;
  readonly startedEvent?: EventId;
  readonly observedGeneration?: number;
  readonly freshness?: VerificationFreshness;
}

export interface MutationFact {
  readonly operationId?: EventId;
  readonly possible: boolean;
  readonly completed: boolean;
  readonly paths: readonly string[];
}

export interface DeterministicFacts {
  readonly fileChanges: readonly string[];
  readonly filesRead: readonly string[];
  readonly exitCode?: number;
  readonly verification?: VerificationFact;
  readonly mutation?: MutationFact;
  readonly phaseProposal: AgentPhase | null;
  readonly deterministicallyResolved: readonly EventId[];
  readonly supersededInWorkingSet: readonly EventId[];
}

export type Gate = "applied" | "uncertain" | "skipped" | "error";
export interface GatedDecision<T> {
  readonly value: T | null;
  readonly gate: Gate;
  readonly probability?: number;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly shadow?: boolean;
}

export interface SemanticDecisions {
  readonly blockerIntroduced?: GatedDecision<boolean>;
  readonly failureCategory?: GatedDecision<BlockerCategory>;
  readonly resolvedBlockers: readonly {
    readonly eventId: EventId;
    readonly decision: GatedDecision<boolean>;
  }[];
  readonly relevance: readonly {
    readonly eventId: EventId;
    readonly decision: GatedDecision<boolean>;
  }[];
  readonly taskComplete?: GatedDecision<boolean>;
  readonly phaseShadow?: GatedDecision<AgentPhase>;
  readonly telemetry: {
    readonly latencyMs?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly model?: string;
    readonly error?: string;
    readonly responseShape?: Readonly<Record<string, string>>;
    readonly questionsAsked: number;
    readonly questionIds: readonly string[];
  };
}

export interface ProjectionMeasurement {
  readonly mode?: "disabled" | "append" | "current-run";
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly messagesOmitted?: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
  readonly stateBlockChars?: number;
  readonly fallback?: string;
}

export interface StateTransitionRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly event: AgentEvent;
  readonly after: HotState;
  readonly deterministicPhase?: AgentPhase;
  readonly changes: readonly string[];
  readonly decisions: SemanticDecisions;
  readonly updater: string;
  readonly config: ReflexStateConfig;
  readonly cwd: string;
  readonly projection?: ProjectionMeasurement;
}
