import type { ActorAction, PatchOperation, SourceTrust, TraceMessage } from "./types.js";

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
