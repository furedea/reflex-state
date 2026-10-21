import { defaultConfig } from "../../core/config.js";
import { scoreTrial } from "./evaluation.js";
import { buildProjection, type ProjectedInput } from "./projection.js";
import { actorSystemPrompt, buildActorRequest } from "./prompts.js";
import type { TrialSession, TrialStep } from "./runner_calls.js";
import {
  countApplied,
  countDecisions,
  memoryHash,
  operationView,
  rememberCandidates,
  type RunContext,
} from "./runner_context.js";
import { operationKey } from "./runner_exchange.js";
import { evaluateFinalArtifact } from "./runner_final.js";
import { requiresIsolation } from "./runner_manifest.js";
import { ActorPatch } from "./runner_patch.js";
import type { Execution, TrialRig } from "./runner_rig.js";
import { terminationFor, type TrialIdentity } from "./runner_scoring.js";
import { TrialTally } from "./runner_tally.js";
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

interface ActorTurn {
  readonly response: ActorResponse;
  readonly action: ActorAction;
}

/** Bounded per-trial set of undecided candidates carried into the next step. */
const HELD_CANDIDATE_LIMIT = 32;

export function trialIdentity(plan: TrialPlan): TrialIdentity {
  return {
    trialId: plan.trialId,
    taskId: plan.task.id,
    mode: plan.mode,
    iteration: plan.iteration,
  };
}

export class TrialRunner {
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
  /** The step being run, with what it observed. */
  private at: TrialStep;
  private group: ObservationGroup = { messages: [] };
  private candidates: readonly Candidate[] = [];

  constructor(
    private readonly plan: TrialPlan,
    private readonly session: TrialSession,
    private readonly rig: TrialRig,
  ) {
    this.ctx = session.ctx;
    this.config = session.ctx.config;
    this.task = plan.task;
    this.mode = plan.mode;
    this.trialId = plan.trialId;
    this.at = session.step(0);
  }

  async runSteps(signal?: AbortSignal): Promise<void> {
    for (let step = 0; step < this.config.budgets.maxActions; step++) {
      if (this.stopRequested(signal)) break;
      if (!(await this.runStep(step))) break;
    }
    if (!this.completed && !this.error) this.error = "action_budget_exhausted";
  }

  async score(isolationVerified: boolean): Promise<TrialScore> {
    const { plan, config, tally, rig } = this;
    const blockReason = this.finalBlockReason(isolationVerified);
    const results = blockReason ? [] : await rig.env.evaluateFinal();
    for (const result of results) tally.mergeConstraints(result.constraints);
    const final = evaluateFinalArtifact(this.task, results, blockReason);
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
      actorVerificationAtStop: tally.actorVerificationAtStop(
        this.task.allowedTests,
        rig.env.observationGeneration,
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
      providerMode: config.provider.mode,
    });
  }

  private get step(): number {
    return this.at.index;
  }

  private stopRequested(signal: AbortSignal | undefined): boolean {
    if (!signal?.aborted) return false;
    // Cancellation is a stop request: no more actions and no final oracle
    // pass over candidate code.
    this.cancelled = true;
    this.error = "cancelled";
    return true;
  }

  /** Returns false when the trial must stop after this step. */
  private async runStep(step: number): Promise<boolean> {
    this.at = this.session.step(step);
    await this.deliverInjections();
    this.observe();
    if (!(await this.refreshMemory())) return false;
    const turn = await this.requestAction();
    if (!turn) return false;
    const responseId = this.recordResponse(turn.response);
    if (this.mode === "llm" && !(await this.commitPatch(turn.response, responseId))) return false;
    return this.performAction(turn.action);
  }

  private async deliverInjections(): Promise<void> {
    const { normalizer, engine, history } = this.rig;
    const consumed = this.held.splice(0, this.held.length);
    for (const message of consumed) {
      const prompt = normalizer.prompt(message.text);
      await engine.process(prompt);
      history.push({ ...message, id: prompt.id, sourceId: prompt.id, sequence: history.length });
      await this.at.recordUpdate("injection", { text: message.text, sourceId: prompt.id });
    }
  }

  private observe(): void {
    this.group = latestGroup(this.rig.history, this.groupStart);
    this.groupStart = this.rig.history.length;
    this.candidates = generateCandidates(this.group.messages, {
      maxBytes: this.config.candidateMaxBytes,
      observedAt: this.step,
    });
    rememberCandidates(this.ctx, this.mode, this.candidates);
  }

  /** Update memory from unprocessed observations and held candidates BEFORE
   * building the next actor input; the visible response text is captured as
   * part of the next step's observation group instead. */
  private async refreshMemory(): Promise<boolean> {
    const { mode, ctx, step, group } = this;
    if (mode !== "rules" && mode !== "jev") return true;
    const { env, engine } = this.rig;
    const merged = mergeCandidates(this.heldCandidates, this.candidates);
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
    const result = await this.at.updateMemory(input);
    this.memory = result.memory;
    this.heldCandidates.clear();
    for (const candidate of result.held) this.heldCandidates.set(candidate.id, candidate);
    countDecisions(ctx, mode, result.decisions.length);
    countApplied(ctx, mode, result.applied);
    this.tally.tallyApplied(result.applied);
    await this.at.recordUpdate("update", {
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
    return this.withinHeldLimit();
  }

  private async withinHeldLimit(): Promise<boolean> {
    if (this.heldCandidates.size <= HELD_CANDIDATE_LIMIT) return true;
    this.error = "state_first_unavailable:held_overflow";
    await this.at.recordUpdate("update", { held_overflow: this.heldCandidates.size });
    return false;
  }

  private async requestAction(): Promise<ActorTurn | undefined> {
    const projected = await this.project();
    if (projected.bundle.unavailable) {
      this.error = `state_first_unavailable:${projected.bundle.unavailable}`;
      return undefined;
    }
    this.tally.sentTexts.push(projected.userText);
    const response = await this.at.act(
      buildActorRequest({
        mode: this.mode,
        taskId: this.task.id,
        trialId: this.trialId,
        step: this.step,
        userText: projected.userText,
        allowedTests: this.task.allowedTests,
        model: this.config.provider.actorModel ?? "fake",
      }),
    );
    if (response.error || !response.action) {
      this.error = response.error ?? "actor_action_missing";
      return undefined;
    }
    return { response, action: response.action };
  }

  private async project(): Promise<ProjectedInput> {
    const { config, task, mode, step } = this;
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
      latest: this.group.messages,
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
    await this.at.recordContext(projected, actorSystemPrompt(mode));
    return projected;
  }

  private recordResponse(response: ActorResponse): string {
    const { history } = this.rig;
    this.tally.actionForms[response.actionForm ?? "canonical"] += 1;
    const responseId = `resp-${this.trialId}-${this.step}`;
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
  private async commitPatch(response: ActorResponse, responseId: string): Promise<boolean> {
    const patch = new ActorPatch(response, responseId);
    const outcome = patch.evaluate(
      this.memory,
      patch.applyContext(this.candidates, this.group.messages, this.step),
      this.config.budgets.memoryBytes,
    );
    if (outcome.kind === "invalid") {
      this.error = outcome.error;
      return false;
    }
    if (outcome.kind === "over_budget") {
      await this.at.recordUpdate("update", {
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
    await this.at.recordUpdate("update", {
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
  private async performAction(action: ActorAction): Promise<boolean> {
    const { tally, step } = this;
    const evidenceId = `call-${this.trialId}-${step}`;
    const execution = await this.execute(action, evidenceId);
    if (!execution) return false;
    tally.trackExecution(operationKey(action), execution.passed);
    if (execution.violation) {
      tally.policyViolations.push(execution.violation);
      this.error = execution.violation;
      return false;
    }
    tally.trackRead(action, this.rig.env.observationGeneration);
    await this.rig.recordToolExchange(action, evidenceId, execution);
    this.trackVerification(execution);
    if (action.tool === "finish") {
      this.completed = true;
      return false;
    }
    this.scheduleInjections();
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

  private trackVerification(execution: Execution): void {
    const { verification } = execution;
    if (!verification) return;
    this.tally.trackVerification(
      {
        testId: verification.testId,
        step: this.step,
        passed: execution.passed,
        generation: verification.generation,
      },
      verification.constraints,
    );
  }

  private scheduleInjections(): void {
    const { step } = this;
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
  private finalBlockReason(isolationVerified: boolean): string | null {
    if (this.envFailed) return "environment_error";
    if (this.cancelled) return "cancelled";
    return requiresIsolation(this.config) && !isolationVerified ? "isolation_unverified" : null;
  }
}

function mergeCandidates(
  held: ReadonlyMap<string, Candidate>,
  fresh: readonly Candidate[],
): readonly Candidate[] {
  const freshIds = new Set(fresh.map((candidate) => candidate.id));
  return [...fresh, ...[...held.values()].filter((candidate) => !freshIds.has(candidate.id))];
}
