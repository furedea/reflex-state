import { defaultConfig } from "../../core/config.js";
import { scoreTrial } from "./evaluation.js";
import { buildProjection, type ProjectedInput } from "./projection.js";
import { actorSystemPrompt, buildActorRequest } from "./prompts.js";
import type { ProviderSet } from "./providers.js";
import {
  actorProvider,
  callOptions,
  instrumented,
  updateWithProviders,
  type StepScope,
} from "./runner_calls.js";
import {
  countApplied,
  countDecisions,
  memoryHash,
  operationView,
  pushUpdate,
  recordContext,
  rememberCandidates,
  trialRecord,
  type RunContext,
} from "./runner_context.js";
import { operationKey, recordToolExchange } from "./runner_exchange.js";
import { evaluateFinalArtifact, finalBlockReason } from "./runner_final.js";
import { requiresIsolation } from "./runner_manifest.js";
import { evaluateActorPatch } from "./runner_patch.js";
import { openRig, type EnvironmentFactory, type TrialRig } from "./runner_rig.js";
import { actorVerificationAtStop, terminationFor } from "./runner_scoring.js";
import { TrialTally } from "./runner_tally.js";
import { TaskEnvironment } from "./task_environment.js";
import { generateCandidates, latestGroup } from "./trace.js";
import type {
  ActorAction,
  ActorResponse,
  Candidate,
  ExperimentMode,
  HybridConfig,
  HybridTask,
  ObservationGroup,
  TaskScoring,
  TraceMessage,
  TrialScore,
} from "./types.js";
import { emptyMemory } from "./types.js";
import { factsFromState, memoryItems } from "./update.js";

export interface TrialPlan {
  readonly trialId: string;
  readonly task: HybridTask;
  readonly scoring?: TaskScoring;
  readonly mode: ExperimentMode;
  readonly iteration: number;
}

export interface TrialRun {
  readonly config: HybridConfig;
  readonly isolationVerified: boolean;
  readonly providers: ProviderSet;
  readonly ctx: RunContext;
}

export interface TrialOptions {
  readonly signal?: AbortSignal;
  readonly environmentFor?: EnvironmentFactory;
}

interface TrialContext {
  readonly plan: TrialPlan;
  readonly run: TrialRun;
  readonly signal: AbortSignal | undefined;
}

interface StepView {
  readonly step: number;
  readonly group: ObservationGroup;
  readonly candidates: readonly Candidate[];
}

interface ActorTurn {
  readonly response: ActorResponse;
  readonly action: ActorAction;
}

type Execution = Awaited<ReturnType<TaskEnvironment["execute"]>>;

/** Bounded per-trial set of undecided candidates carried into the next step. */
const HELD_CANDIDATE_LIMIT = 32;

export async function runTrial(
  plan: TrialPlan,
  run: TrialRun,
  options: TrialOptions = {},
): Promise<TrialScore> {
  const trial = await TrialRunner.start({ plan, run, signal: options.signal }, options);
  await trial.runSteps();
  return trial.score();
}

class TrialRunner {
  private readonly ctx: RunContext;
  private readonly config: HybridConfig;
  private readonly task: HybridTask;
  private readonly mode: ExperimentMode;
  private readonly trialId: string;
  private readonly tally = new TrialTally();
  private memory = emptyMemory();
  private completed = false;
  private cancelled = false;
  private error: string | undefined;
  /** Set when the workspace itself can no longer be trusted; no further
   * candidate code may run, including the final oracle pass. */
  private envFailed = false;
  private readonly held: TraceMessage[] = [];
  private readonly heldCandidates = new Map<string, Candidate>();
  private readonly startedAt = new Date().toISOString();
  private groupStart = 0;

  private constructor(
    private readonly context: TrialContext,
    private readonly rig: TrialRig,
  ) {
    this.ctx = context.run.ctx;
    this.config = context.run.config;
    this.task = context.plan.task;
    this.mode = context.plan.mode;
    this.trialId = context.plan.trialId;
  }

  static async start(context: TrialContext, options: TrialOptions): Promise<TrialRunner> {
    const isolated = requiresIsolation(context.run.config);
    const rig = await openRig(context.plan, isolated, options.environmentFor);
    return new TrialRunner(context, rig);
  }

  async runSteps(): Promise<void> {
    for (let step = 0; step < this.config.budgets.maxActions; step++) {
      if (this.stopRequested()) break;
      if (!(await this.runStep(step))) break;
    }
    if (!this.completed && !this.error) this.error = "action_budget_exhausted";
  }

  async score(): Promise<TrialScore> {
    const { plan, run } = this.context;
    const { env } = this.rig;
    const { tally } = this;
    const final = await evaluateFinalArtifact(
      { env, task: this.task, blockReason: this.finalBlockReason() },
      (verdicts) => tally.mergeConstraints(verdicts),
    );
    const finishedAt = new Date().toISOString();
    return scoreTrial({
      trialId: this.trialId,
      taskId: this.task.id,
      mode: this.mode,
      iteration: plan.iteration,
      startedAt: this.startedAt,
      finishedAt,
      completed: this.completed,
      cancelled: this.cancelled,
      ...(this.error ? { error: this.error } : {}),
      terminationReason: terminationFor(this.completed, this.error),
      policyViolations: tally.policyViolations,
      constraints: tally.constraints(),
      testResults: final.testResults,
      finalArtifact: final.finalArtifact,
      finalConstraintVerdicts: final.finalConstraintVerdicts,
      actorVerificationAtStop: actorVerificationAtStop(
        this.task.allowedTests,
        tally.actorTests,
        env.observationGeneration,
      ),
      actorTests: tally.actorTests,
      patchStats: tally.patchStats(),
      actionForms: tally.actionForms,
      sentTexts: tally.sentTexts,
      checkpoints: plan.scoring?.checkpoints ?? [],
      failureObserved: tally.failureObserved,
      rereads: tally.rereads,
      retries: tally.retries,
      appliedExtractive: tally.appliedExtractive,
      appliedGenerated: tally.appliedGenerated,
      activeMemoryItems: memoryItems(this.memory).length,
      providerMode: run.config.provider.mode,
    });
  }

  private stopRequested(): boolean {
    if (!this.context.signal?.aborted) return false;
    // Cancellation is a stop request: no more actions and no final oracle
    // pass over candidate code.
    this.cancelled = true;
    this.error = "cancelled";
    return true;
  }

  /** Returns false when the trial must stop after this step. */
  private async runStep(step: number): Promise<boolean> {
    await this.deliverInjections(step);
    const view = this.observe(step);
    if (!(await this.refreshMemory(view))) return false;
    const turn = await this.requestAction(view);
    if (!turn) return false;
    const responseId = this.recordResponse(step, turn.response);
    if (this.mode === "llm" && !(await this.commitPatch(view, turn.response, responseId)))
      return false;
    return this.performAction(step, turn.action);
  }

  private async deliverInjections(step: number): Promise<void> {
    const { normalizer, engine, history } = this.rig;
    const consumed = this.held.splice(0, this.held.length);
    for (const message of consumed) {
      const prompt = normalizer.prompt(message.text);
      await engine.process(prompt);
      history.push({ ...message, id: prompt.id, sourceId: prompt.id, sequence: history.length });
      await this.pushRecord(step, "injection", { text: message.text, sourceId: prompt.id });
    }
  }

  private observe(step: number): StepView {
    const group = latestGroup(this.rig.history, this.groupStart);
    this.groupStart = this.rig.history.length;
    const candidates = generateCandidates(group.messages, {
      maxBytes: this.config.candidateMaxBytes,
      observedAt: step,
    });
    rememberCandidates(this.ctx, this.mode, candidates);
    return { step, group, candidates };
  }

  /** Update memory from unprocessed observations and held candidates BEFORE
   * building the next actor input; the visible response text is captured as
   * part of the next step's observation group instead. */
  private async refreshMemory(view: StepView): Promise<boolean> {
    const { mode, ctx } = this;
    if (mode !== "rules" && mode !== "jev") return true;
    const { step, group } = view;
    const { env, engine } = this.rig;
    const merged = mergeCandidates(this.heldCandidates, view.candidates);
    const input = {
      instruction: this.task.instruction,
      mode,
      state: engine.state,
      facts: factsFromState(engine.state, defaultConfig(), env.verificationFacts()),
      memory: this.memory,
      candidates: merged,
      observations: group.messages,
      latest: group.messages,
      step,
      now: step,
    } as const;
    const result = await updateWithProviders(ctx, input, {
      ...this.stepScope(step),
      providers: this.context.run.providers,
    });
    this.memory = result.memory;
    this.heldCandidates.clear();
    for (const candidate of result.held) this.heldCandidates.set(candidate.id, candidate);
    countDecisions(ctx, mode, result.decisions.length);
    countApplied(ctx, mode, result.applied);
    this.tally.tallyApplied(result.applied);
    await this.pushRecord(step, "update", {
      candidates: merged.map((candidate) => candidate.id),
      decisions: result.decisions,
      applied: result.applied.map(operationView),
      held: result.held.map((candidate) => candidate.id),
      repairReasons: result.repairReasons,
      memoryHash: memoryHash(this.memory),
      ...(result.unavailable ? { unavailable: result.unavailable } : {}),
    });
    if (result.unavailable) {
      this.error = `state_first_unavailable:${result.unavailable}`;
      return false;
    }
    return this.withinHeldLimit(step);
  }

  private async withinHeldLimit(step: number): Promise<boolean> {
    if (this.heldCandidates.size <= HELD_CANDIDATE_LIMIT) return true;
    this.error = "state_first_unavailable:held_overflow";
    await this.pushRecord(step, "update", { held_overflow: this.heldCandidates.size });
    return false;
  }

  private async requestAction(view: StepView): Promise<ActorTurn | undefined> {
    const { step } = view;
    const projected = await this.project(view);
    if (projected.bundle.unavailable) {
      this.error = `state_first_unavailable:${projected.bundle.unavailable}`;
      return undefined;
    }
    this.tally.sentTexts.push(projected.userText);
    const request = buildActorRequest({
      mode: this.mode,
      taskId: this.task.id,
      trialId: this.trialId,
      step,
      userText: projected.userText,
      allowedTests: this.task.allowedTests,
      model: this.config.provider.actorModel ?? "fake",
    });
    const { providers } = this.context.run;
    const response = await instrumented(
      this.ctx,
      { kind: "actor", mode: this.mode, request, ...this.stepScope(step) },
      () => actorProvider(providers).act(request, callOptions(this.config)),
    );
    if (response.error || !response.action) {
      this.error = response.error ?? "actor_action_missing";
      return undefined;
    }
    return { response, action: response.action };
  }

  private async project(view: StepView): Promise<ProjectedInput> {
    const { step, group } = view;
    const { config, task, mode } = this;
    const facts = factsFromState(
      this.rig.engine.state,
      defaultConfig(),
      this.rig.env.verificationFacts(),
    );
    const projected = buildProjection({
      mode,
      instruction: task.instruction,
      facts,
      memory: this.memory,
      latest: group.messages,
      history: this.rig.history,
      actionBudget: {
        limit: config.budgets.maxActions,
        used: step,
        remaining_including_next: config.budgets.maxActions - step,
        finish_counts_as_action: true,
      },
      ...(mode === "llm" ? { lastUpdateResult: this.tally.lastUpdateResult } : {}),
      allowedTests: task.allowedTests,
      budgets: config.budgets,
    });
    await recordContext(this.ctx, {
      trialId: this.trialId,
      taskId: task.id,
      mode,
      step,
      projected,
      system: actorSystemPrompt(mode),
      config,
    });
    return projected;
  }

  private recordResponse(step: number, response: ActorResponse): string {
    const { history } = this.rig;
    this.tally.actionForms[response.actionForm ?? "canonical"] += 1;
    const responseId = `resp-${this.trialId}-${step}`;
    if (response.text)
      history.push({
        id: responseId,
        role: "assistant",
        text: response.text,
        sequence: history.length,
        sourceId: responseId,
        truncated: false,
      });
    return responseId;
  }

  /** Returns false when the patch ends the trial. */
  private async commitPatch(
    view: StepView,
    response: ActorResponse,
    responseId: string,
  ): Promise<boolean> {
    const { step } = view;
    const outcome = evaluateActorPatch({
      memory: this.memory,
      response,
      responseId,
      candidates: view.candidates,
      observations: view.group.messages,
      step,
      memoryBytes: this.config.budgets.memoryBytes,
    });
    if (outcome.kind === "invalid") {
      this.error = outcome.error;
      return false;
    }
    if (outcome.kind === "over_budget") {
      await this.pushRecord(step, "update", {
        source: "actor_patch",
        patchInput: outcome.patchInput,
        rejected: "memory_exceeds_budget",
        memoryHash: memoryHash(this.memory),
      });
      this.error = outcome.error;
      return false;
    }
    this.memory = outcome.memory;
    this.tally.tallyPatch(outcome);
    countApplied(this.ctx, this.mode, outcome.applied);
    await this.pushRecord(step, "update", {
      source: "actor_patch",
      patchInput: outcome.patchInput,
      operations: outcome.applied.map(operationView),
      ...(outcome.unchanged.length ? { unchanged: outcome.unchanged } : {}),
      ...(outcome.errors.length ? { dropped: outcome.errors } : {}),
      memoryHash: memoryHash(this.memory),
    });
    return true;
  }

  /** Returns false when the trial finished or must stop. */
  private async performAction(step: number, action: ActorAction): Promise<boolean> {
    const { tally } = this;
    const evidenceId = `call-${this.trialId}-${step}`;
    const execution = await this.execute(action, evidenceId);
    if (!execution) return false;
    tally.trackExecution(operationKey(action), execution);
    if (execution.violation) {
      tally.policyViolations.push(execution.violation);
      this.error = execution.violation;
      return false;
    }
    tally.trackRead(action, this.rig.env.observationGeneration);
    await recordToolExchange(this.rig, { action, evidenceId, execution });
    tally.trackVerification(step, execution);
    if (action.tool === "finish") {
      this.completed = true;
      return false;
    }
    this.scheduleInjections(step);
    return true;
  }

  private async execute(action: ActorAction, evidenceId: string): Promise<Execution | undefined> {
    try {
      return await this.rig.env.execute(action, evidenceId);
    } catch (cause) {
      // A corrupt or unusable workspace ends the trial; nothing else may run.
      this.envFailed = true;
      this.error = `environment_error:${cause instanceof Error ? cause.message : "workspace_failed"}`;
      return undefined;
    }
  }

  private scheduleInjections(step: number): void {
    const due = (this.task.injections ?? []).filter((injection) => injection.step === step + 1);
    for (const injection of due)
      this.held.push({
        id: `inj-${this.trialId}-${step}`,
        role: "user",
        text: injection.text,
        sequence: -1,
        sourceId: `inj-${this.trialId}-${step}`,
        truncated: false,
      });
  }

  /** When the workspace is corrupt or required isolation was never confirmed,
   * no additional candidate code may execute at all. */
  private finalBlockReason(): string | null {
    const { config, isolationVerified } = this.context.run;
    return finalBlockReason({
      envFailed: this.envFailed,
      cancelled: this.cancelled,
      isolationUnverified: requiresIsolation(config) && !isolationVerified,
    });
  }

  private stepScope(step: number): StepScope {
    return { trialId: this.trialId, taskId: this.task.id, step, config: this.config };
  }

  private pushRecord(
    step: number,
    kind: "update" | "injection",
    data: Record<string, unknown>,
  ): Promise<void> {
    const address = { trialId: this.trialId, taskId: this.task.id, mode: this.mode, step, kind };
    return pushUpdate(this.ctx, trialRecord(this.ctx, address, data));
  }
}

function mergeCandidates(
  held: ReadonlyMap<string, Candidate>,
  fresh: readonly Candidate[],
): readonly Candidate[] {
  const freshIds = new Set(fresh.map((candidate) => candidate.id));
  return [...fresh, ...[...held.values()].filter((candidate) => !freshIds.has(candidate.id))];
}
