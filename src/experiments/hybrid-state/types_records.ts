import type { ExperimentMode, InputBundle, LabelKind, Usage } from "./types.js";

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
