import { defaultConfig } from "../../core/config.js";
import { StateEngine } from "../../core/engine.js";
import { NoopStateUpdater } from "../../core/updater.js";
import { PiEventNormalizer } from "../../pi/normalization.js";
import { evaluateAudit, summarize, type LabelsFile } from "./evaluation.js";
import { buildProjection, type ProjectedInput } from "./projection.js";
import type { ProviderSet } from "./providers.js";
import {
  callOptions,
  fakeProviders,
  instrumented,
  updateWithProviders,
  type UpdateScope,
} from "./runner_calls.js";
import {
  auditRecord,
  BudgetExhausted,
  countApplied,
  countDecisions,
  newRunContext,
  pushUpdate,
  recordContext,
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
  GenerativeUpdateRequest,
  HybridConfig,
  ObservationGroup,
  RepairReason,
  SkippedTrial,
  TerminationReason,
  TraceData,
  TraceMessage,
  TrialScore,
  UpdateResult,
  WorkMemory,
} from "./types.js";
import { emptyMemory, PROMPT_VERSION } from "./types.js";
import {
  applyContext,
  applyOperations,
  factsFromState,
  memoryItems,
  type updateMemory,
} from "./update.js";

export interface AuditOptions {
  readonly config: HybridConfig;
  readonly trace: TraceData;
  readonly labels?: LabelsFile;
  readonly providers?: ProviderSet;
  readonly runId?: string;
  readonly recorder?: RunRecorder;
}

interface AuditRun {
  readonly ctx: RunContext;
  readonly options: AuditOptions;
  readonly providers: ProviderSet;
  readonly selected: Record<ExperimentMode, string[]>;
}

/** Trial-local state: each mode gets a fresh history, normalizer, engine, and memory. */
interface AuditTrial {
  memory: WorkMemory;
  endReason: string;
  readonly history: TraceMessage[];
  readonly normalizer: PiEventNormalizer;
  readonly engine: StateEngine;
}

interface AuditStepContext {
  readonly audit: AuditRun;
  readonly trial: AuditTrial;
  readonly mode: ExperimentMode;
  readonly group: ObservationGroup;
  readonly step: number;
}

type UpdateInput = Parameters<typeof updateMemory>[0];

export async function runAudit(options: AuditOptions): Promise<ExperimentRun> {
  const runId = options.runId ?? newRunId();
  const providers = options.providers ?? fakeProviders([]);
  const ctx = newRunContext(runId, options.config, options.recorder);
  const labelsUsable = options.labels?.sourceHash === options.trace.sourceHash;
  await recordRejectedLabels(ctx, options, labelsUsable);
  const audit: AuditRun = {
    ctx,
    options,
    providers,
    selected: { history: [], llm: [], rules: [], jev: [] },
  };
  const scores: TrialScore[] = [];
  const skipped: SkippedTrial[] = [];
  for (const mode of options.config.modes) {
    if (ctx.budget.sent >= ctx.budget.limit) {
      skipped.push(skippedAuditTrial(mode));
      continue;
    }
    scores.push(await runAuditMode(audit, mode));
  }
  await recordAuditSummary(audit, labelsUsable);
  const summary = summarize({
    runId,
    evaluation: "trace_audit",
    provider: options.config.provider.mode,
    modes: options.config.modes,
    scores,
    plannedTrials: options.config.modes.length,
    skipped,
    calls: ctx.calls,
    contexts: ctx.contexts,
    uniqueCandidates: ctx.uniqueCandidates,
    decisionCounts: ctx.decisionCounts,
    appliedCounts: ctx.appliedCounts,
    environment: experimentEnvironment(options.config),
    limitations: auditLimitations(labelsUsable),
  });
  const manifest = await createManifest(options.config, {
    input: options.trace.sourceHash,
    evaluation: "trace_audit",
    runId,
  });
  return { manifest, updates: ctx.updates, calls: ctx.calls, contexts: ctx.contexts, summary };
}

async function recordRejectedLabels(
  ctx: RunContext,
  options: AuditOptions,
  labelsUsable: boolean,
): Promise<void> {
  if (!options.labels || labelsUsable) return;
  await pushUpdate(
    ctx,
    auditRecord(
      ctx,
      { kind: "audit_summary", step: -1, mode: "-" },
      {
        labels_rejected: "source_hash_mismatch",
        expected: options.trace.sourceHash,
        actual: options.labels.sourceHash,
      },
    ),
  );
}

async function recordAuditSummary(audit: AuditRun, labelsUsable: boolean): Promise<void> {
  const { ctx, options, selected } = audit;
  const labels = options.labels?.labels ?? [];
  const allCandidates = generateCandidates(options.trace.messages, {
    maxBytes: options.config.candidateMaxBytes,
  });
  const evaluation = labelsUsable ? evaluateAudit(allCandidates, labels) : undefined;
  await pushUpdate(
    ctx,
    auditRecord(
      ctx,
      { kind: "audit_summary", step: -1, mode: "-" },
      {
        labelsUsable,
        labelCount: labels.length,
        selected,
        distribution: evaluation?.distribution ?? {},
        selectionAccuracy: "not_evaluated",
        evaluated: evaluation?.total ?? 0,
        coverage: evaluation?.coverage ?? 0,
      },
    ),
  );
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

async function runAuditMode(audit: AuditRun, mode: ExperimentMode): Promise<TrialScore> {
  const trial = newAuditTrial();
  try {
    await runAuditSteps(audit, trial, mode);
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    trial.endReason = "not_run_global_budget";
  }
  return auditScore(audit, trial, mode);
}

function newAuditTrial(): AuditTrial {
  return {
    memory: emptyMemory(),
    endReason: "completed",
    history: [],
    normalizer: new PiEventNormalizer({
      eventCount: 0,
      turnIndex: 0,
      config: defaultConfig(),
      cwd: "/experiment",
    }),
    engine: new StateEngine({
      cwd: "/experiment",
      config: defaultConfig(),
      updater: new NoopStateUpdater(),
    }),
  };
}

async function runAuditSteps(
  audit: AuditRun,
  trial: AuditTrial,
  mode: ExperimentMode,
): Promise<void> {
  const groups = auditGroups(audit.options.trace.messages);
  for (let step = 0; step < groups.length; step++) {
    const group = groups[step]!;
    if (!(await auditOneStep({ audit, trial, mode, group, step }))) break;
  }
}

/** Returns false when the mode's state-first update became unavailable. */
async function auditOneStep(stepContext: AuditStepContext): Promise<boolean> {
  const { audit, trial, mode, group, step } = stepContext;
  const { ctx, options } = audit;
  for (const event of eventsForMessages(group.messages, trial.normalizer))
    await trial.engine.process(event);
  trial.history.push(...group.messages);
  const facts = factsFromState(trial.engine.state, defaultConfig());
  const candidates = generateCandidates(group.messages, {
    maxBytes: options.config.candidateMaxBytes,
    observedAt: step,
  });
  rememberCandidates(ctx, mode, candidates);
  const projected = projectAuditStep(stepContext, facts);
  await recordContext(ctx, {
    trialId: `audit-${mode}`,
    taskId: "audit",
    mode,
    step,
    projected,
    system: "",
    config: options.config,
  });
  const input = {
    instruction: auditInstruction(options.trace),
    mode,
    state: trial.engine.state,
    facts,
    memory: trial.memory,
    candidates,
    observations: group.messages,
    latest: group.messages,
    step,
    now: step,
  } as const;
  const result = await auditStep(ctx, input, {
    providers: audit.providers,
    config: options.config,
    trialId: `audit-${mode}`,
    taskId: "audit",
    step,
  });
  trial.memory = result.memory;
  await recordAuditStep(
    stepContext,
    candidates.map((candidate) => candidate.id),
    result,
  );
  if (result.unavailable) {
    trial.endReason = `state_first_unavailable:${result.unavailable}`;
    return false;
  }
  return true;
}

function projectAuditStep(
  stepContext: AuditStepContext,
  facts: ReturnType<typeof factsFromState>,
): ProjectedInput {
  const { audit, trial, mode, group, step } = stepContext;
  const { config, trace } = audit.options;
  return buildProjection({
    mode,
    instruction: auditInstruction(trace),
    facts,
    memory: trial.memory,
    latest: group.messages,
    history: trial.history,
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

async function recordAuditStep(
  stepContext: AuditStepContext,
  candidateIds: readonly string[],
  result: UpdateResult,
): Promise<void> {
  const { audit, trial, mode, step } = stepContext;
  const { ctx } = audit;
  audit.selected[mode].push(
    ...result.decisions
      .filter((decision) => decision.disposition === "selected")
      .map((decision) => decision.candidateId),
  );
  countDecisions(ctx, mode, result.decisions.length);
  countApplied(ctx, mode, result.applied);
  await pushUpdate(
    ctx,
    auditRecord(
      ctx,
      { kind: "audit_step", step, mode },
      {
        candidates: candidateIds,
        decisions: result.decisions,
        applied: result.applied,
        held: result.held.map((candidate) => candidate.id),
        repairReasons: result.repairReasons,
        memoryItems: memoryItems(trial.memory).length,
        ...(result.unavailable ? { unavailable: result.unavailable } : {}),
      },
    ),
  );
}

function auditScore(audit: AuditRun, trial: AuditTrial, mode: ExperimentMode): TrialScore {
  const { ctx, options } = audit;
  const { endReason } = trial;
  return idleTrialScore(
    { trialId: `audit-${mode}`, taskId: "audit", mode, iteration: 0 },
    options.config.provider.mode,
    {
      completed: endReason === "completed",
      ...(endReason === "completed" ? {} : { error: endReason }),
      terminationReason: auditTermination(endReason),
      finalArtifact: { status: "not_evaluated", reason: "audit_mode", tests: {} },
      appliedExtractive: ctx.appliedCounts.get(mode)?.extractive ?? 0,
      appliedGenerated: ctx.appliedCounts.get(mode)?.generated ?? 0,
      activeMemoryItems: memoryItems(trial.memory).length,
    },
  );
}

function auditTermination(endReason: string): TerminationReason {
  if (endReason === "completed") return "finish";
  return endReason === "not_run_global_budget" ? "request_budget" : "state_unavailable";
}

async function auditStep(
  ctx: RunContext,
  input: UpdateInput,
  scope: UpdateScope,
): Promise<UpdateResult> {
  if (input.mode === "llm") return auditLlmUpdate(ctx, input, scope);
  if (input.mode === "history") return stalledUpdate(input);
  return updateWithProviders(ctx, input, scope);
}

async function auditLlmUpdate(
  ctx: RunContext,
  input: UpdateInput,
  scope: UpdateScope,
): Promise<UpdateResult> {
  const { config, step } = scope;
  const provider = scope.providers.update;
  if (!provider) return stalledUpdate(input, [], "update_provider_missing");
  const request: GenerativeUpdateRequest = {
    mode: "llm",
    instruction: input.instruction,
    facts: JSON.stringify(input.facts),
    memory: JSON.stringify(input.memory),
    latest: JSON.stringify(groupView(input.latest)),
    selfSourceId: `upd-audit-llm-${step}`,
    model: config.provider.updateModel ?? config.provider.actorModel ?? "fake",
    promptVersion: PROMPT_VERSION,
  };
  const response = await instrumented(ctx, { kind: "update", mode: "llm", request, ...scope }, () =>
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
