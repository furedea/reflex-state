import type { TaskEnvironment } from "./task_environment.js";
import type { FinalArtifactEvaluation, HybridTask } from "./types.js";

export interface FinalSubject {
  readonly env: TaskEnvironment;
  readonly task: HybridTask;
  /** Why candidate code must not run at all, or null when the oracles may run. */
  readonly blockReason: string | null;
}

export interface FinalEvaluation {
  readonly testResults: Record<string, "passed" | "failed" | "not_run">;
  readonly finalArtifact: FinalArtifactEvaluation;
  readonly finalConstraintVerdicts: Record<string, boolean> | null;
}

export function finalBlockReason(state: {
  readonly envFailed: boolean;
  readonly cancelled: boolean;
  readonly isolationUnverified: boolean;
}): string | null {
  if (state.envFailed) return "environment_error";
  if (state.cancelled) return "cancelled";
  return state.isolationUnverified ? "isolation_unverified" : null;
}

/** The final workspace is scored by the evaluator's own oracles — a
 * budget-exhausted trial still gets an independent artifact verdict, and an
 * oracles-never-ran outcome is "not_run", never counted as a failure. */
export async function evaluateFinalArtifact(
  subject: FinalSubject,
  onConstraints: (verdicts: Readonly<Record<string, boolean>>) => void,
): Promise<FinalEvaluation> {
  const { env, task, blockReason } = subject;
  const testResults: Record<string, "passed" | "failed" | "not_run"> = {};
  const finalConstraints: Record<string, boolean> = {};
  let sawFinalConstraints = false;
  const results = blockReason ? [] : await env.evaluateFinal();
  for (const result of results) {
    testResults[result.testId] = result.status;
    if (result.constraints) {
      sawFinalConstraints = true;
      Object.assign(finalConstraints, result.constraints);
      onConstraints(result.constraints);
    }
  }
  for (const testId of task.allowedTests)
    if (!(testId in testResults)) testResults[testId] = "not_run";
  return {
    testResults,
    finalArtifact: finalArtifact(task, testResults, blockReason),
    finalConstraintVerdicts: sawFinalConstraints ? finalConstraints : null,
  };
}

function finalArtifact(
  task: HybridTask,
  testResults: FinalEvaluation["testResults"],
  blockReason: string | null,
): FinalArtifactEvaluation {
  const evaluated = Object.values(testResults).some((status) => status !== "not_run");
  return {
    status: evaluated ? "evaluated" : "not_evaluated",
    ...(evaluated
      ? {}
      : {
          reason:
            blockReason ?? (task.allowedTests.length ? "no_oracle_verdict" : "no_tests_declared"),
        }),
    tests: testResults,
  };
}
