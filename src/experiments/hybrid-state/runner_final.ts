import type { TaskEnvironment } from "./task_environment.js";
import type { FinalArtifactEvaluation, HybridTask } from "./types.js";

type OracleResults = Awaited<ReturnType<TaskEnvironment["evaluateFinal"]>>;

export interface FinalEvaluation {
  readonly testResults: FinalArtifactEvaluation["tests"];
  readonly finalArtifact: FinalArtifactEvaluation;
  readonly finalConstraintVerdicts: Record<string, boolean> | null;
}

/** The final workspace is scored by the evaluator's own oracles — a
 * budget-exhausted trial still gets an independent artifact verdict, and an
 * oracles-never-ran outcome is "not_run", never counted as a failure.
 * `blockReason` is why candidate code must not run at all, or null when the
 * oracles may run; a blocked trial passes no results. */
export function evaluateFinalArtifact(
  task: HybridTask,
  results: OracleResults,
  blockReason: string | null,
): FinalEvaluation {
  const testResults: Record<string, "passed" | "failed" | "not_run"> = {};
  const finalConstraints: Record<string, boolean> = {};
  let sawFinalConstraints = false;
  for (const result of results) {
    testResults[result.testId] = result.status;
    if (result.constraints) {
      sawFinalConstraints = true;
      Object.assign(finalConstraints, result.constraints);
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
  testResults: FinalArtifactEvaluation["tests"],
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
