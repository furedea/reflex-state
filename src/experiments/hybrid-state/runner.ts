import { summarize } from "./evaluation.js";
import type { ProviderSet } from "./providers.js";
import { fakeProviders } from "./runner_calls.js";
import {
  BudgetExhausted,
  newRunContext,
  type ExperimentRun,
  type RunContext,
  type RunRecorder,
} from "./runner_context.js";
import {
  createManifest,
  experimentEnvironment,
  newRunId,
  requiresIsolation,
} from "./runner_manifest.js";
import { idleTrialScore } from "./runner_scoring.js";
import { runTrial, type TrialOptions, type TrialPlan } from "./runner_trial.js";
import type { TaskEnvironment } from "./task_environment.js";
import type { HybridConfig, HybridTask, SkippedTrial, TaskScoring, TrialScore } from "./types.js";

export { runAudit } from "./runner_audit.js";
export {
  PersistenceError,
  type ExperimentRun,
  type RequestBudget,
  type RunContext,
  type RunRecorder,
} from "./runner_context.js";
export { requiresIsolation } from "./runner_manifest.js";

export async function runClosedLoop(options: {
  readonly config: HybridConfig;
  readonly tasks: readonly HybridTask[];
  readonly scoring?: ReadonlyMap<string, TaskScoring>;
  readonly providers?: ProviderSet;
  readonly runId?: string;
  readonly recorder?: RunRecorder;
  /** True only after the host's isolation mechanism was actually verified;
   * when isolation is required and unverified, final candidate execution is
   * skipped rather than run unsandboxed. */
  readonly isolationVerified?: boolean;
  /** Aborting skips every not-yet-started trial and stops the in-flight one;
   * a cancelled trial never runs its final oracle pass. */
  readonly signal?: AbortSignal;
  /** Environment construction seam for safety tests; production callers use
   * the default TaskEnvironment. */
  readonly environmentFor?: (
    task: HybridTask,
    scoring: TaskScoring | undefined,
    isolated: boolean,
  ) => TaskEnvironment;
}): Promise<ExperimentRun> {
  const { config } = options;
  const runId = options.runId ?? newRunId();
  const providers = options.providers ?? fakeProviders(options.tasks);
  const ctx = newRunContext(runId, config, options.recorder);
  const scores: TrialScore[] = [];
  const skipped: SkippedTrial[] = [];
  const trials = seededOrder(planTrials(config, options.tasks, options.scoring), config.seed);
  const run = {
    config,
    isolationVerified: options.isolationVerified ?? !requiresIsolation(config),
    providers,
    ctx,
  };
  for (const plan of trials) {
    const reason = skipReason(ctx, options.signal);
    if (reason) skipped.push(skippedTrial(plan, reason));
    else scores.push(await runScoredTrial(plan, run, options));
  }
  const summary = summarize({
    runId,
    evaluation: "closed_loop",
    provider: config.provider.mode,
    modes: config.modes,
    scores,
    plannedTrials: trials.length,
    skipped,
    calls: ctx.calls,
    contexts: ctx.contexts,
    uniqueCandidates: ctx.uniqueCandidates,
    decisionCounts: ctx.decisionCounts,
    appliedCounts: ctx.appliedCounts,
    environment: experimentEnvironment(config),
  });
  const inputHash = options.tasks.map((task) => JSON.stringify(task)).join("\n");
  const manifest = await createManifest(config, {
    input: inputHash,
    evaluation: "closed_loop",
    runId,
  });
  return { manifest, updates: ctx.updates, calls: ctx.calls, contexts: ctx.contexts, summary };
}

function skipReason(
  ctx: RunContext,
  signal: AbortSignal | undefined,
): SkippedTrial["reason"] | undefined {
  if (signal?.aborted) return "cancelled";
  if (ctx.budget.sent >= ctx.budget.limit) return "not_run_global_budget";
  return undefined;
}

function skippedTrial(plan: TrialPlan, reason: SkippedTrial["reason"]): SkippedTrial {
  return {
    trialId: plan.trialId,
    taskId: plan.task.id,
    mode: plan.mode,
    iteration: plan.iteration,
    reason,
  };
}

function runScoredTrial(
  plan: TrialPlan,
  run: Parameters<typeof runTrial>[1],
  options: TrialOptions,
): Promise<TrialScore> {
  return runTrial(plan, run, options).catch((error): TrialScore => {
    if (error instanceof BudgetExhausted) return unfinishedTrial(plan, run.config);
    throw error;
  });
}

function unfinishedTrial(plan: TrialPlan, config: HybridConfig): TrialScore {
  return idleTrialScore(
    { trialId: plan.trialId, taskId: plan.task.id, mode: plan.mode, iteration: plan.iteration },
    config.provider.mode,
    { error: "request_limit" },
  );
}

/** Deterministic trial order derived from config.seed. */
function seededOrder<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    const temp = result[index]!;
    result[index] = result[swap]!;
    result[swap] = temp;
  }
  return result;
}

function planTrials(
  config: HybridConfig,
  tasks: readonly HybridTask[],
  scoring?: ReadonlyMap<string, TaskScoring>,
): TrialPlan[] {
  const trials: TrialPlan[] = [];
  for (let iteration = 0; iteration < config.iterations; iteration++)
    for (const task of tasks) {
      const taskScoring = scoring?.get(task.id);
      trials.push(
        ...config.modes.map((mode) => ({
          trialId: `iter${iteration}-${task.id}-${mode}`,
          task,
          ...(taskScoring ? { scoring: taskScoring } : {}),
          mode,
          iteration,
        })),
      );
    }
  return trials;
}
