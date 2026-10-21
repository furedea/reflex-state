import { summarize } from "./evaluation.js";
import type { ProviderSet } from "./providers.js";
import { fakeProviders, TrialSession } from "./runner_calls.js";
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
import { TrialRig } from "./runner_rig.js";
import { idleTrialScore } from "./runner_scoring.js";
import { trialIdentity, TrialRunner, type TrialPlan } from "./runner_trial.js";
import { TaskEnvironment } from "./task_environment.js";
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
  return new ClosedLoopRun(options).run();
}

class ClosedLoopRun {
  private readonly ctx: RunContext;
  private readonly providers: ProviderSet;
  private readonly isolationVerified: boolean;

  constructor(private readonly options: Parameters<typeof runClosedLoop>[0]) {
    const { config } = options;
    this.ctx = newRunContext(options.runId ?? newRunId(), config, options.recorder);
    this.providers = options.providers ?? fakeProviders(options.tasks);
    this.isolationVerified = options.isolationVerified ?? !requiresIsolation(config);
  }

  async run(): Promise<ExperimentRun> {
    const { config, tasks, scoring } = this.options;
    const { ctx } = this;
    const scores: TrialScore[] = [];
    const skipped: SkippedTrial[] = [];
    const trials = seededOrder(planTrials(config, tasks, scoring), config.seed);
    for (const plan of trials) {
      const reason = this.skipReason();
      if (reason) skipped.push(skippedTrial(plan, reason));
      else scores.push(await this.runScoredTrial(plan));
    }
    const summary = summarize({
      runId: ctx.runId,
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
    const inputHash = tasks.map((task) => JSON.stringify(task)).join("\n");
    const manifest = await createManifest(ctx, inputHash, "closed_loop");
    return { manifest, updates: ctx.updates, calls: ctx.calls, contexts: ctx.contexts, summary };
  }

  private skipReason(): SkippedTrial["reason"] | undefined {
    if (this.options.signal?.aborted) return "cancelled";
    if (this.ctx.budget.sent >= this.ctx.budget.limit) return "not_run_global_budget";
    return undefined;
  }

  private runScoredTrial(plan: TrialPlan): Promise<TrialScore> {
    return this.runTrial(plan).catch((error): TrialScore => {
      if (error instanceof BudgetExhausted) return unfinishedTrial(plan, this.options.config);
      throw error;
    });
  }

  private async runTrial(plan: TrialPlan): Promise<TrialScore> {
    const rig = await TrialRig.open(this.openEnvironment(plan), plan.task.instruction);
    const session = new TrialSession(this.ctx, this.providers, trialIdentity(plan));
    const trial = new TrialRunner(plan, session, rig);
    await trial.runSteps(this.options.signal);
    return trial.score(this.isolationVerified);
  }

  private openEnvironment(plan: TrialPlan): TaskEnvironment {
    const { task, scoring } = plan;
    const isolated = requiresIsolation(this.options.config);
    const { environmentFor } = this.options;
    return environmentFor
      ? environmentFor(task, scoring, isolated)
      : new TaskEnvironment(task, scoring, { isolated });
  }
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

function unfinishedTrial(plan: TrialPlan, config: HybridConfig): TrialScore {
  return idleTrialScore(trialIdentity(plan), config.provider.mode, { error: "request_limit" });
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
