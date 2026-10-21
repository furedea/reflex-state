import { defaultConfig } from "../../core/config.js";
import { StateEngine } from "../../core/engine.js";
import { NoopStateUpdater } from "../../core/updater.js";
import { PiEventNormalizer } from "../../pi/normalization.js";
import { evaluateAudit, summarize, type LabelsFile } from "./evaluation.js";
import { buildProjection, type ProjectedInput } from "./projection.js";
import type { ProviderSet } from "./providers.js";
import { callOptions, fakeProviders, TrialSession, type TrialStep } from "./runner_calls.js";
import {
  BudgetExhausted,
  countApplied,
  countDecisions,
  newRunContext,
  pushUpdate,
  rememberCandidates,
  type ExperimentRun,
  type RunContext,
  type RunRecorder,
} from "./runner_context.js";
import { createManifest, experimentEnvironment, newRunId } from "./runner_manifest.js";
import { idleTrialScore } from "./runner_scoring.js";
import { eventsForMessages, generateCandidates } from "./trace.js";
import type {
  ExperimentMode,
  ExperimentSummary,
  GenerativeUpdateRequest,
  HybridConfig,
  ObservationGroup,
  RepairReason,
  SkippedTrial,
  TerminationReason,
  TraceData,
  TraceMessage,
  TrialScore,
  UpdateInput,
  UpdateResult,
  WorkMemory,
} from "./types.js";
import { emptyMemory, PROMPT_VERSION } from "./types.js";
import { applyContext, applyOperations, factsFromState, memoryItems } from "./update.js";

export async function runAudit(options: {
  readonly config: HybridConfig;
  readonly trace: TraceData;
  readonly labels?: LabelsFile;
  readonly providers?: ProviderSet;
  readonly runId?: string;
  readonly recorder?: RunRecorder;
}): Promise<ExperimentRun> {
  const ctx = newRunContext(options.runId ?? newRunId(), options.config, options.recorder);
  const providers = options.providers ?? fakeProviders([]);
  return new TraceAudit(ctx, options.trace, providers).run(options.labels);
}

class TraceAudit {
  readonly selected: Record<ExperimentMode, string[]> = {
    history: [],
    llm: [],
    rules: [],
    jev: [],
  };

  constructor(
    readonly ctx: RunContext,
    readonly trace: TraceData,
    readonly providers: ProviderSet,
  ) {}

  async run(labels?: LabelsFile): Promise<ExperimentRun> {
    const { ctx, trace } = this;
    if (labels && !this.labelsUsable(labels)) await this.recordRejectedLabels(labels);
    const scores: TrialScore[] = [];
    const skipped: SkippedTrial[] = [];
    for (const mode of ctx.config.modes) {
      if (ctx.budget.sent >= ctx.budget.limit) {
        skipped.push(skippedAuditTrial(mode));
        continue;
      }
      scores.push(await new AuditTrial(this, mode).run());
    }
    await this.recordSummary(labels);
    const summary = this.summarize(scores, skipped, this.labelsUsable(labels));
    const manifest = await createManifest(ctx, trace.sourceHash, "trace_audit");
    return { manifest, updates: ctx.updates, calls: ctx.calls, contexts: ctx.contexts, summary };
  }

  private labelsUsable(labels: LabelsFile | undefined): boolean {
    return labels?.sourceHash === this.trace.sourceHash;
  }

  private async recordRejectedLabels(labels: LabelsFile): Promise<void> {
    await pushAuditSummary(this.ctx, {
      labels_rejected: "source_hash_mismatch",
      expected: this.trace.sourceHash,
      actual: labels.sourceHash,
    });
  }

  private async recordSummary(labels: LabelsFile | undefined): Promise<void> {
    const { ctx, trace, selected } = this;
    const labelsUsable = this.labelsUsable(labels);
    const allLabels = labels?.labels ?? [];
    const allCandidates = generateCandidates(trace.messages, {
      maxBytes: ctx.config.candidateMaxBytes,
    });
    const evaluation = labelsUsable ? evaluateAudit(allCandidates, allLabels) : undefined;
    await pushAuditSummary(ctx, {
      labelsUsable,
      labelCount: allLabels.length,
      selected,
      distribution: evaluation?.distribution ?? {},
      selectionAccuracy: "not_evaluated",
      evaluated: evaluation?.total ?? 0,
      coverage: evaluation?.coverage ?? 0,
    });
  }

  private summarize(
    scores: readonly TrialScore[],
    skipped: readonly SkippedTrial[],
    labelsUsable: boolean,
  ): ExperimentSummary {
    const { ctx } = this;
    const { config } = ctx;
    return summarize({
      runId: ctx.runId,
      evaluation: "trace_audit",
      provider: config.provider.mode,
      modes: config.modes,
      scores,
      plannedTrials: config.modes.length,
      skipped,
      calls: ctx.calls,
      contexts: ctx.contexts,
      uniqueCandidates: ctx.uniqueCandidates,
      decisionCounts: ctx.decisionCounts,
      appliedCounts: ctx.appliedCounts,
      environment: experimentEnvironment(config),
      limitations: auditLimitations(labelsUsable),
    });
  }
}

/** Trial-local state: each mode gets a fresh history, normalizer, engine, and memory. */
class AuditTrial {
  private memory: WorkMemory = emptyMemory();
  private endReason = "completed";
  private readonly history: TraceMessage[] = [];
  private readonly normalizer = new PiEventNormalizer({
    eventCount: 0,
    turnIndex: 0,
    config: defaultConfig(),
    cwd: "/experiment",
  });
  private readonly engine = new StateEngine({
    cwd: "/experiment",
    config: defaultConfig(),
    updater: new NoopStateUpdater(),
  });
  private readonly session: TrialSession;

  constructor(
    private readonly audit: TraceAudit,
    private readonly mode: ExperimentMode,
  ) {
    this.session = new TrialSession(audit.ctx, audit.providers, {
      trialId: `audit-${mode}`,
      taskId: "audit",
      mode,
      iteration: 0,
    });
  }

  async run(): Promise<TrialScore> {
    try {
      await this.runSteps();
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      this.endReason = "not_run_global_budget";
    }
    return this.score();
  }

  private async runSteps(): Promise<void> {
    const groups = auditGroups(this.audit.trace.messages);
    for (let step = 0; step < groups.length; step++) {
      if (!(await this.auditStep(groups[step]!, step))) break;
    }
  }

  /** Returns false when the mode's state-first update became unavailable. */
  private async auditStep(group: ObservationGroup, step: number): Promise<boolean> {
    const { ctx, trace } = this.audit;
    const { mode } = this;
    const at = this.session.step(step);
    for (const event of eventsForMessages(group.messages, this.normalizer))
      await this.engine.process(event);
    this.history.push(...group.messages);
    const facts = factsFromState(this.engine.state, defaultConfig());
    const candidates = generateCandidates(group.messages, {
      maxBytes: ctx.config.candidateMaxBytes,
      observedAt: step,
    });
    rememberCandidates(ctx, mode, candidates);
    await at.recordContext(this.project(group, step, facts), "");
    const input = {
      instruction: auditInstruction(trace),
      mode,
      state: this.engine.state,
      facts,
      memory: this.memory,
      candidates,
      observations: group.messages,
      latest: group.messages,
      step,
      now: step,
    } as const;
    const result = await this.update(input, at);
    this.memory = result.memory;
    await this.recordStep(
      at,
      candidates.map((candidate) => candidate.id),
      result,
    );
    if (result.unavailable) {
      this.endReason = `state_first_unavailable:${result.unavailable}`;
      return false;
    }
    return true;
  }

  private project(
    group: ObservationGroup,
    step: number,
    facts: ReturnType<typeof factsFromState>,
  ): ProjectedInput {
    const { config } = this.audit.ctx;
    const { mode } = this;
    return buildProjection({
      mode,
      instruction: auditInstruction(this.audit.trace),
      facts,
      memory: this.memory,
      latest: group.messages,
      history: this.history,
      actionBudget: {
        limit: config.budgets.maxActions,
        used: step,
        remaining_including_next: Math.max(0, config.budgets.maxActions - step),
        finish_counts_as_action: true,
      },
      ...(mode === "llm" ? { lastUpdateResult: null } : {}),
      allowedTests: [],
      budgets: config.budgets,
    });
  }

  private async recordStep(
    at: TrialStep,
    candidateIds: readonly string[],
    result: UpdateResult,
  ): Promise<void> {
    const { ctx, selected } = this.audit;
    const { mode } = this;
    selected[mode].push(
      ...result.decisions
        .filter((decision) => decision.disposition === "selected")
        .map((decision) => decision.candidateId),
    );
    countDecisions(ctx, mode, result.decisions.length);
    countApplied(ctx, mode, result.applied);
    await at.recordUpdate("audit_step", {
      candidates: candidateIds,
      decisions: result.decisions,
      applied: result.applied,
      held: result.held.map((candidate) => candidate.id),
      repairReasons: result.repairReasons,
      memoryItems: memoryItems(this.memory).length,
      ...(result.unavailable ? { unavailable: result.unavailable } : {}),
    });
  }

  private score(): TrialScore {
    const { ctx } = this.audit;
    const { mode, endReason } = this;
    return idleTrialScore(
      { trialId: `audit-${mode}`, taskId: "audit", mode, iteration: 0 },
      ctx.config.provider.mode,
      {
        completed: endReason === "completed",
        ...(endReason === "completed" ? {} : { error: endReason }),
        terminationReason: auditTermination(endReason),
        finalArtifact: { status: "not_evaluated", reason: "audit_mode", tests: {} },
        appliedExtractive: ctx.appliedCounts.get(mode)?.extractive ?? 0,
        appliedGenerated: ctx.appliedCounts.get(mode)?.generated ?? 0,
        activeMemoryItems: memoryItems(this.memory).length,
      },
    );
  }

  private async update(input: UpdateInput, at: TrialStep): Promise<UpdateResult> {
    if (input.mode === "llm") return this.llmUpdate(input, at);
    if (input.mode === "history") return stalledUpdate(input);
    return at.updateMemory(input);
  }

  private async llmUpdate(input: UpdateInput, at: TrialStep): Promise<UpdateResult> {
    const { config } = at;
    const provider = this.audit.providers.update;
    if (!provider) return stalledUpdate(input, [], "update_provider_missing");
    const request: GenerativeUpdateRequest = {
      mode: "llm",
      instruction: input.instruction,
      facts: JSON.stringify(input.facts),
      memory: JSON.stringify(input.memory),
      latest: JSON.stringify(groupView(input.latest)),
      selfSourceId: `upd-audit-llm-${at.index}`,
      model: config.provider.updateModel ?? config.provider.actorModel ?? "fake",
      promptVersion: PROMPT_VERSION,
    };
    const response = await at.instrumented("update", request, () =>
      provider.update(request, callOptions(config)),
    );
    if (response.error || !response.operations)
      return stalledUpdate(input, ["invalid_update"], response.error ?? "invalid_update");
    const apply = applyOperations(input.memory, response.operations, applyContext(input, true));
    if (!apply.ok) return stalledUpdate(input, ["invalid_update"], apply.reason);
    return {
      memory: apply.memory,
      candidates: input.candidates,
      decisions: response.operations.map((operation, index) => ({
        candidateId: operation.sourceIds[0] ?? `op-${index}`,
        disposition: "selected" as const,
        reason: "llm_update",
      })),
      held: [],
      applied: apply.applied,
      repairReasons: [],
    };
  }
}

/** The run-level summary record has no mode; "-" stands in for it. */
function pushAuditSummary(ctx: RunContext, data: Record<string, unknown>): Promise<void> {
  return pushUpdate(ctx, {
    runId: ctx.runId,
    trialId: "audit--",
    taskId: "audit",
    mode: "-" as ExperimentMode,
    step: -1,
    kind: "audit_summary",
    ...data,
  });
}

function auditLimitations(labelsUsable: boolean): string[] {
  return labelsUsable
    ? ["audit labels are update-method classifications; selection accuracy is not evaluated"]
    : ["audit labels were rejected (source hash mismatch); selection is not evaluated"];
}

function skippedAuditTrial(mode: ExperimentMode): SkippedTrial {
  return {
    trialId: `audit-${mode}`,
    taskId: "audit",
    mode,
    iteration: 0,
    reason: "not_run_global_budget",
  };
}

function auditTermination(endReason: string): TerminationReason {
  if (endReason === "completed") return "finish";
  return endReason === "not_run_global_budget" ? "request_budget" : "state_unavailable";
}

function stalledUpdate(
  input: UpdateInput,
  repairReasons: readonly RepairReason[] = [],
  unavailable?: string,
): UpdateResult {
  return {
    memory: input.memory,
    candidates: input.candidates,
    decisions: [],
    held: [],
    applied: [],
    repairReasons,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

function auditGroups(messages: readonly TraceMessage[]): ObservationGroup[] {
  const groups: ObservationGroup[] = [];
  let current: TraceMessage[] = [];
  for (const message of messages) {
    current.push(message);
    if (message.role === "user" && current.length > 1) {
      groups.push({ messages: current.slice(0, -1) });
      current = [message];
    }
  }
  if (current.length) groups.push({ messages: current });
  return groups.filter((group) => group.messages.length);
}

function auditInstruction(trace: TraceData): string {
  return trace.messages.find((message) => message.role === "user")?.text ?? "Trace audit";
}

function groupView(messages: readonly TraceMessage[]): unknown {
  return {
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      sourceId: message.sourceId,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
    })),
  };
}
