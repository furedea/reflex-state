import { scoreTrial } from "./evaluation.js";
import type {
  ExperimentMode,
  HybridConfig,
  PatchStats,
  TerminationReason,
  TrialScore,
} from "./types.js";

export interface ActorTestRun {
  readonly testId: string;
  readonly step: number;
  readonly passed: boolean;
  readonly generation: number;
}

export interface TrialIdentity {
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly iteration: number;
}

type TrialOutcome = Parameters<typeof scoreTrial>[0];

/** Error strings produced by the environment's policy gate; a violation ends
 * the trial but is classified separately from provider/contract failures. */
const POLICY_ERRORS = ["path_escape", "invalid_action", "test_not_allowed", "test_no_oracle"];

const EXACT_TERMINATIONS = new Map<string, TerminationReason>([
  ["cancelled", "cancelled"],
  ["action_budget_exhausted", "action_budget"],
  ["request_limit", "request_budget"],
  ["not_run_global_budget", "request_budget"],
  ...POLICY_ERRORS.map((error): [string, TerminationReason] => [error, "policy_violation"]),
]);

const PREFIX_TERMINATIONS: readonly (readonly [string, TerminationReason])[] = [
  ["persistence_failed", "persistence_error"],
  ["environment_error", "environment_error"],
  ["state_first_unavailable", "state_unavailable"],
  ["invalid_update", "contract_error"],
  ["actor_", "contract_error"],
  ["operations_", "contract_error"],
  ["response_", "contract_error"],
];

export function terminationFor(completed: boolean, error: string | undefined): TerminationReason {
  if (completed) return "finish";
  if (!error) return "action_budget";
  const exact = EXACT_TERMINATIONS.get(error);
  if (exact) return exact;
  const prefixed = PREFIX_TERMINATIONS.find(([prefix]) => error.startsWith(prefix));
  return prefixed ? prefixed[1] : "provider_error";
}

function emptyPatchStats(): PatchStats {
  return {
    input: { missing: 0, empty: 0, present: 0 },
    proposed: 0,
    applied: 0,
    unchanged: 0,
    rejected: 0,
  };
}

/** Score for a trial that produced no actor activity; `overrides` carries the
 * fields that differ (reason, termination, counts). */
export function idleTrialScore(
  identity: TrialIdentity,
  providerMode: HybridConfig["provider"]["mode"],
  overrides: Partial<TrialOutcome>,
): TrialScore {
  return scoreTrial({
    ...identity,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    completed: false,
    cancelled: false,
    terminationReason: "request_budget",
    policyViolations: [],
    constraints: {},
    testResults: {},
    finalArtifact: { status: "not_evaluated", reason: "trial_interrupted", tests: {} },
    finalConstraintVerdicts: null,
    actorVerificationAtStop: {},
    actorTests: [],
    patchStats: emptyPatchStats(),
    actionForms: { canonical: 0, shorthand: 0, bare: 0 },
    sentTexts: [],
    checkpoints: [],
    failureObserved: false,
    rereads: 0,
    retries: 0,
    appliedExtractive: 0,
    appliedGenerated: 0,
    activeMemoryItems: 0,
    providerMode,
    ...overrides,
  });
}
