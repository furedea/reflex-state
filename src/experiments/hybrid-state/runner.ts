import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { defaultConfig } from "../../core/config.js";
import { StateEngine } from "../../core/engine.js";
import { NoopStateUpdater } from "../../core/updater.js";
import { PiEventNormalizer } from "../../pi/normalization.js";
import { evaluateAudit, scoreTrial, summarize, type LabelsFile } from "./evaluation.js";
import { buildProjection, renderMemoryProjection, type ProjectedInput } from "./projection.js";
import { buildActorRequest } from "./prompts.js";
import {
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  FakeUpdateProvider,
  requestHash,
  sentRequestBody,
  type ActorProvider,
  type CallOptions,
  type JevProvider,
  type ProviderSet,
  type RepairProvider,
} from "./providers.js";
import { TaskEnvironment } from "./task_environment.js";
import { eventsForMessages, generateCandidates, latestGroup } from "./trace.js";
import type {
  ActorAction,
  CallRecord,
  CallStartRecord,
  Candidate,
  ContextRecord,
  ExperimentEnvironment,
  ExperimentManifest,
  ExperimentMode,
  ExperimentSummary,
  GenerativeUpdateRequest,
  HybridConfig,
  HybridTask,
  JevRequest,
  ObservationGroup,
  PatchOperation,
  RepairRequest,
  SkippedTrial,
  TaskScoring,
  TraceData,
  TraceMessage,
  TrialScore,
  UpdateRecord,
  UpdateResult,
  WorkMemory,
} from "./types.js";
import { emptyMemory, HYBRID_SCHEMA_VERSION, PROMPT_VERSION } from "./types.js";
import {
  applyContext,
  applyOperations,
  factsFromState,
  memoryItems,
  updateMemory,
  validateOperations,
  type ApplyContext,
} from "./update.js";

const execFile = promisify(execFileCallback);

export interface ExperimentRun {
  readonly manifest: ExperimentManifest;
  readonly updates: readonly UpdateRecord[];
  readonly calls: readonly CallRecord[];
  readonly contexts: readonly ContextRecord[];
  readonly summary: ExperimentSummary;
}

export interface RunRecorder {
  callStart(record: CallStartRecord): Promise<void>;
  call(record: CallRecord): Promise<void>;
  context(record: ContextRecord): Promise<void>;
  update(record: UpdateRecord): Promise<void>;
}

export class PersistenceError extends Error {
  constructor(message: string) {
    super(`persistence_failed:${message}`);
    this.name = "PersistenceError";
  }
}

export interface RunContext {
  readonly runId: string;
  readonly calls: CallRecord[];
  readonly contexts: ContextRecord[];
  readonly updates: UpdateRecord[];
  readonly uniqueCandidates: Map<ExperimentMode, Set<string>>;
  readonly decisionCounts: Map<ExperimentMode, number>;
  readonly appliedCounts: Map<ExperimentMode, { extractive: number; generated: number }>;
  readonly budget: RequestBudget;
  readonly trialSent: Map<string, number>;
  callSeq: number;
  readonly recorder?: RunRecorder;
}

export interface RequestBudget {
  sent: number;
  readonly limit: number;
}

class BudgetExhausted extends Error {
  constructor() {
    super("not_run_global_budget");
  }
}

function newRunContext(runId: string, config: HybridConfig, recorder?: RunRecorder): RunContext {
  return {
    runId,
    calls: [],
    contexts: [],
    updates: [],
    uniqueCandidates: new Map(),
    decisionCounts: new Map(),
    appliedCounts: new Map(),
    budget: { sent: 0, limit: config.provider.maxRequests },
    trialSent: new Map(),
    callSeq: 0,
    ...(recorder ? { recorder } : {}),
  };
}

async function writeRecord(
  ctx: RunContext,
  file: string,
  write: (recorder: RunRecorder) => Promise<void>,
): Promise<void> {
  if (!ctx.recorder) return;
  try {
    await write(ctx.recorder);
  } catch (error) {
    throw new PersistenceError(
      `${file}: ${error instanceof Error ? error.message : "write_failed"}`,
    );
  }
}

async function pushCall(ctx: RunContext, record: CallRecord): Promise<void> {
  ctx.calls.push(record);
  await writeRecord(ctx, "calls.jsonl", (recorder) => recorder.call(record));
}

async function pushCallStart(ctx: RunContext, record: CallStartRecord): Promise<void> {
  await writeRecord(ctx, "calls.jsonl", (recorder) => recorder.callStart(record));
}

async function pushContext(ctx: RunContext, record: ContextRecord): Promise<void> {
  ctx.contexts.push(record);
  await writeRecord(ctx, "contexts.jsonl", (recorder) => recorder.context(record));
}

async function pushUpdate(ctx: RunContext, record: UpdateRecord): Promise<void> {
  ctx.updates.push(record);
  await writeRecord(ctx, "updates.jsonl", (recorder) => recorder.update(record));
}

export async function runAudit(options: {
  readonly config: HybridConfig;
  readonly trace: TraceData;
  readonly labels?: LabelsFile;
  readonly providers?: ProviderSet;
  readonly runId?: string;
  readonly recorder?: RunRecorder;
}): Promise<ExperimentRun> {
  const runId = options.runId ?? newRunId();
  const providers = options.providers ?? fakeProviders([]);
  const ctx = newRunContext(runId, options.config, options.recorder);
  const labels = options.labels?.labels ?? [];
  const labelsUsable = options.labels?.sourceHash === options.trace.sourceHash;
  if (options.labels && !labelsUsable)
    await pushUpdate(
      ctx,
      auditRecord(ctx, "audit_summary", -1, "-", {
        labels_rejected: "source_hash_mismatch",
        expected: options.trace.sourceHash,
        actual: options.labels.sourceHash,
      }),
    );
  const selected: Record<ExperimentMode, string[]> = {
    history: [],
    llm: [],
    rules: [],
    jev: [],
  };
  const scores: TrialScore[] = [];
  const skipped: SkippedTrial[] = [];
  for (const mode of options.config.modes) {
    if (ctx.budget.sent >= ctx.budget.limit) {
      skipped.push({
        trialId: `audit-${mode}`,
        taskId: "audit",
        mode,
        iteration: 0,
        reason: "not_run_global_budget",
      });
      continue;
    }
    let memory = emptyMemory();
    let endReason = "completed";
    // Trial-local state: each mode gets a fresh history, normalizer, engine, and memory.
    const history: TraceMessage[] = [];
    const normalizer = new PiEventNormalizer({
      eventCount: 0,
      turnIndex: 0,
      config: defaultConfig(),
      cwd: "/experiment",
    });
    const groups = auditGroups(options.trace.messages);
    const engine = new StateEngine({
      cwd: "/experiment",
      config: defaultConfig(),
      updater: new NoopStateUpdater(),
    });
    try {
      for (let step = 0; step < groups.length; step++) {
        const group = groups[step]!;
        for (const event of eventsForMessages(group.messages, normalizer))
          await engine.process(event);
        history.push(...group.messages);
        const facts = factsFromState(engine.state, defaultConfig());
        const candidates = generateCandidates(group.messages, {
          maxBytes: options.config.candidateMaxBytes,
          observedAt: step,
        });
        rememberCandidates(ctx, mode, candidates);
        const projected = buildProjection({
          mode,
          instruction: auditInstruction(options.trace),
          facts,
          memory,
          latest: group.messages,
          history,
          allowedTests: [],
          budgets: options.config.budgets,
        });
        await recordContext(ctx, {
          trialId: `audit-${mode}`,
          taskId: "audit",
          mode,
          step,
          projected,
          config: options.config,
        });
        const input = {
          instruction: auditInstruction(options.trace),
          mode,
          state: engine.state,
          facts,
          memory,
          candidates,
          observations: group.messages,
          latest: group.messages,
          step,
          now: step,
        } as const;
        const result = await auditStep(ctx, input, providers, options.config, mode, step);
        memory = result.memory;
        selected[mode].push(
          ...result.decisions
            .filter((decision) => decision.disposition === "selected")
            .map((decision) => decision.candidateId),
        );
        countDecisions(ctx, mode, result.decisions.length);
        countApplied(ctx, mode, result.applied);
        await pushUpdate(
          ctx,
          auditRecord(ctx, "audit_step", step, mode, {
            candidates: candidates.map((candidate) => candidate.id),
            decisions: result.decisions,
            applied: result.applied,
            held: result.held.map((candidate) => candidate.id),
            repairReasons: result.repairReasons,
            memoryItems: memoryItems(memory).length,
            ...(result.unavailable ? { unavailable: result.unavailable } : {}),
          }),
        );
        if (result.unavailable) {
          endReason = `state_first_unavailable:${result.unavailable}`;
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      endReason = "not_run_global_budget";
    }
    scores.push(
      scoreTrial({
        trialId: `audit-${mode}`,
        taskId: "audit",
        mode,
        iteration: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        completed: endReason === "completed",
        cancelled: false,
        ...(endReason === "completed" ? {} : { error: endReason }),
        policyViolations: [],
        constraints: {},
        testResults: {},
        actorTests: [],
        sentTexts: [],
        checkpoints: [],
        failureObserved: false,
        rereads: 0,
        retries: 0,
        appliedExtractive: ctx.appliedCounts.get(mode)?.extractive ?? 0,
        appliedGenerated: ctx.appliedCounts.get(mode)?.generated ?? 0,
        activeMemoryItems: memoryItems(memory).length,
        providerMode: options.config.provider.mode,
      }),
    );
  }
  const allCandidates = generateCandidates(options.trace.messages, {
    maxBytes: options.config.candidateMaxBytes,
  });
  const audit = labelsUsable ? evaluateAudit(allCandidates, labels) : undefined;
  await pushUpdate(
    ctx,
    auditRecord(ctx, "audit_summary", -1, "-", {
      labelsUsable,
      labelCount: labels.length,
      selected,
      distribution: audit?.distribution ?? {},
      selectionAccuracy: "not_evaluated",
      evaluated: audit?.total ?? 0,
      coverage: audit?.coverage ?? 0,
    }),
  );
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
    limitations: labelsUsable
      ? ["audit labels are update-method classifications; selection accuracy is not evaluated"]
      : ["audit labels were rejected (source hash mismatch); selection is not evaluated"],
  });
  const manifest = await createManifest(
    options.config,
    options.trace.sourceHash,
    "trace_audit",
    runId,
  );
  return { manifest, updates: ctx.updates, calls: ctx.calls, contexts: ctx.contexts, summary };
}

export async function runClosedLoop(options: {
  readonly config: HybridConfig;
  readonly tasks: readonly HybridTask[];
  readonly scoring?: ReadonlyMap<string, TaskScoring>;
  readonly providers?: ProviderSet;
  readonly runId?: string;
  readonly recorder?: RunRecorder;
}): Promise<ExperimentRun> {
  const runId = options.runId ?? newRunId();
  const providers = options.providers ?? fakeProviders(options.tasks);
  const ctx = newRunContext(runId, options.config, options.recorder);
  const scores: TrialScore[] = [];
  const skipped: SkippedTrial[] = [];
  const trials = seededOrder(
    planTrials(options.config, options.tasks, options.scoring),
    options.config.seed,
  );
  for (const plan of trials) {
    if (ctx.budget.sent >= ctx.budget.limit) {
      skipped.push({
        trialId: plan.trialId,
        taskId: plan.task.id,
        mode: plan.mode,
        iteration: plan.iteration,
        reason: "not_run_global_budget",
      });
      continue;
    }
    const score = await runTrial(plan, options.config, providers, ctx).catch(
      (error): TrialScore => {
        if (error instanceof BudgetExhausted)
          return unfinishedTrial(plan, "request_limit", options.config.provider.mode);
        throw error;
      },
    );
    scores.push(score);
  }
  const summary = summarize({
    runId,
    evaluation: "closed_loop",
    provider: options.config.provider.mode,
    modes: options.config.modes,
    scores,
    plannedTrials: trials.length,
    skipped,
    calls: ctx.calls,
    contexts: ctx.contexts,
    uniqueCandidates: ctx.uniqueCandidates,
    decisionCounts: ctx.decisionCounts,
    appliedCounts: ctx.appliedCounts,
    environment: experimentEnvironment(options.config),
  });
  const inputHash = options.tasks.map((task) => JSON.stringify(task)).join("\n");
  const manifest = await createManifest(options.config, inputHash, "closed_loop", runId);
  return { manifest, updates: ctx.updates, calls: ctx.calls, contexts: ctx.contexts, summary };
}

interface TrialPlan {
  readonly trialId: string;
  readonly task: HybridTask;
  readonly scoring?: TaskScoring;
  readonly mode: ExperimentMode;
  readonly iteration: number;
}

/** Oracle scripts execute workspace code, so isolation is required whenever a
 * config asks for it or when a closed_loop run uses a non-fake provider
 * (recorded responses still replay generated code into the environment). */
export function requiresIsolation(config: HybridConfig): boolean {
  return (
    config.provider.executionIsolation === "required" ||
    (config.evaluation === "closed_loop" && config.provider.mode !== "fake")
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
      for (const mode of config.modes)
        trials.push({
          trialId: `iter${iteration}-${task.id}-${mode}`,
          task,
          ...(taskScoring ? { scoring: taskScoring } : {}),
          mode,
          iteration,
        });
    }
  return trials;
}

/** Bounded per-trial set of undecided candidates carried into the next step. */
const HELD_CANDIDATE_LIMIT = 32;

function mergeCandidates(
  held: ReadonlyMap<string, Candidate>,
  fresh: readonly Candidate[],
): readonly Candidate[] {
  const freshIds = new Set(fresh.map((candidate) => candidate.id));
  return [...fresh, ...[...held.values()].filter((candidate) => !freshIds.has(candidate.id))];
}

function unfinishedTrial(
  plan: TrialPlan,
  reason: string,
  providerMode: HybridConfig["provider"]["mode"],
): TrialScore {
  return scoreTrial({
    trialId: plan.trialId,
    taskId: plan.task.id,
    mode: plan.mode,
    iteration: plan.iteration,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    completed: false,
    cancelled: false,
    error: reason,
    policyViolations: [],
    constraints: {},
    testResults: {},
    actorTests: [],
    sentTexts: [],
    checkpoints: [],
    failureObserved: false,
    rereads: 0,
    retries: 0,
    appliedExtractive: 0,
    appliedGenerated: 0,
    activeMemoryItems: 0,
    providerMode,
  });
}

async function runTrial(
  plan: TrialPlan,
  config: HybridConfig,
  providers: ProviderSet,
  ctx: RunContext,
): Promise<TrialScore> {
  const { task, mode, trialId, iteration, scoring } = plan;
  const env = new TaskEnvironment(task, scoring, {
    isolated: requiresIsolation(config),
  });
  const normalizer = new PiEventNormalizer({
    eventCount: 0,
    turnIndex: 0,
    config: defaultConfig(),
    cwd: "/experiment",
  });
  const engine = new StateEngine({
    cwd: "/experiment",
    config: defaultConfig(),
    updater: new NoopStateUpdater(),
  });
  const initialPrompt = normalizer.prompt(task.instruction);
  await engine.process(initialPrompt);
  const history: TraceMessage[] = [
    {
      id: initialPrompt.id,
      role: "user",
      text: task.instruction,
      sequence: 0,
      sourceId: initialPrompt.id,
      truncated: false,
    },
  ];
  let memory = emptyMemory();
  let completed = false;
  let error: string | undefined;
  const policyViolations: string[] = [];
  const constraintVerdicts = new Map<string, boolean>();
  const mergeConstraints = (verdicts?: Readonly<Record<string, boolean>>) => {
    for (const [key, verdict] of Object.entries(verdicts ?? {}))
      constraintVerdicts.set(key, (constraintVerdicts.get(key) ?? true) && verdict);
  };
  const actorTests: { testId: string; step: number; passed: boolean }[] = [];
  const sentTexts: string[] = [];
  const readKeys = new Set<string>();
  let rereads = 0;
  let retries = 0;
  let lastFailedKey: string | undefined;
  let failureObserved = false;
  let appliedExtractive = 0;
  let appliedGenerated = 0;
  const held: TraceMessage[] = [];
  const heldCandidates = new Map<string, Candidate>();
  const startedAt = new Date().toISOString();
  let groupStart = 0;

  for (let step = 0; step < config.budgets.maxActions; step++) {
    const consumed = held.splice(0, held.length);
    for (const message of consumed) {
      const prompt = normalizer.prompt(message.text);
      await engine.process(prompt);
      history.push({ ...message, id: prompt.id, sourceId: prompt.id, sequence: history.length });
      await pushUpdate(
        ctx,
        trialRecord(ctx, trialId, task.id, mode, step, "injection", {
          text: message.text,
          sourceId: prompt.id,
        }),
      );
    }
    const group = latestGroup(history, groupStart);
    groupStart = history.length;
    const candidates = generateCandidates(group.messages, {
      maxBytes: config.candidateMaxBytes,
      observedAt: step,
    });
    rememberCandidates(ctx, mode, candidates);
    if (mode === "rules" || mode === "jev") {
      // Update memory from unprocessed observations and held candidates BEFORE
      // building the next actor input; the visible response text is captured as
      // part of the next step's observation group instead.
      const merged = mergeCandidates(heldCandidates, candidates);
      const input = {
        instruction: task.instruction,
        mode,
        state: engine.state,
        facts: factsFromState(engine.state, defaultConfig(), env.verificationFacts()),
        memory,
        candidates: merged,
        observations: group.messages,
        latest: group.messages,
        step,
        now: step,
      } as const;
      const result = await updateWithProviders(
        ctx,
        input,
        providers,
        config,
        trialId,
        task.id,
        step,
      );
      memory = result.memory;
      heldCandidates.clear();
      for (const candidate of result.held) heldCandidates.set(candidate.id, candidate);
      countDecisions(ctx, mode, result.decisions.length);
      countApplied(ctx, mode, result.applied);
      appliedExtractive += result.applied.filter((op) => op.origin === "extracted").length;
      appliedGenerated += result.applied.filter((op) => op.origin === "generated").length;
      await pushUpdate(
        ctx,
        trialRecord(ctx, trialId, task.id, mode, step, "update", {
          candidates: merged.map((candidate) => candidate.id),
          decisions: result.decisions,
          applied: result.applied.map(operationView),
          held: result.held.map((candidate) => candidate.id),
          repairReasons: result.repairReasons,
          memoryHash: memoryHash(memory),
          ...(result.unavailable ? { unavailable: result.unavailable } : {}),
        }),
      );
      if (result.unavailable) {
        error = `state_first_unavailable:${result.unavailable}`;
        break;
      }
      if (heldCandidates.size > HELD_CANDIDATE_LIMIT) {
        error = "state_first_unavailable:held_overflow";
        await pushUpdate(
          ctx,
          trialRecord(ctx, trialId, task.id, mode, step, "update", {
            held_overflow: heldCandidates.size,
          }),
        );
        break;
      }
    }
    const facts = factsFromState(engine.state, defaultConfig(), env.verificationFacts());
    const projected = buildProjection({
      mode,
      instruction: task.instruction,
      facts,
      memory,
      latest: group.messages,
      history,
      allowedTests: task.allowedTests,
      budgets: config.budgets,
    });
    await recordContext(ctx, { trialId, taskId: task.id, mode, step, projected, config });
    if (projected.bundle.unavailable) {
      error = `state_first_unavailable:${projected.bundle.unavailable}`;
      break;
    }
    sentTexts.push(projected.userText);
    const request = buildActorRequest({
      mode,
      taskId: task.id,
      trialId,
      step,
      userText: projected.userText,
      allowedTests: task.allowedTests,
      model: config.provider.actorModel ?? "fake",
    });
    const response = await instrumented(
      ctx,
      "actor",
      mode,
      request,
      () => actorProvider(providers).act(request, callOptions(config)),
      trialId,
      task.id,
      step,
      config,
    );
    if (response.error || !response.action) {
      error = response.error ?? "actor_action_missing";
      break;
    }
    const responseId = `resp-${trialId}-${step}`;
    if (response.text)
      history.push({
        id: responseId,
        role: "assistant",
        text: response.text,
        sequence: history.length,
        sourceId: responseId,
        truncated: false,
      });
    if (mode === "llm") {
      // The state patch is optional: an absent or empty patch leaves memory
      // unchanged; the actor still commits through the same validation path.
      const patch = (response.statePatch ?? []).map((operation) =>
        substituteSelf(operation, responseId),
      );
      // Invalid operations are dropped and recorded rather than killing the
      // trial: a miscited extraction never reaches memory, and the missing
      // retention shows up in the checkpoint scores instead.
      const patchContext = actorPatchContext(
        candidates,
        group.messages,
        memory,
        responseId,
        response.text,
        step,
      );
      const validation = validateOperations(memory, patch, patchContext);
      const apply = applyOperations(memory, validation.valid, patchContext);
      if (!apply.ok) {
        error = `invalid_update:${apply.reason}`;
        break;
      }
      // The patch is tentative until the final memory render fits the shared
      // projection budget; an over-budget patch is never committed and the
      // action is never executed.
      if (Buffer.byteLength(renderMemoryProjection(apply.memory)) > config.budgets.memoryBytes) {
        await pushUpdate(
          ctx,
          trialRecord(ctx, trialId, task.id, mode, step, "update", {
            source: "actor_patch",
            rejected: "memory_exceeds_budget",
            memoryHash: memoryHash(memory),
          }),
        );
        error = "invalid_update:memory_exceeds_budget";
        break;
      }
      memory = apply.memory;
      appliedExtractive += apply.applied.filter((op) => op.origin === "extracted").length;
      appliedGenerated += apply.applied.filter((op) => op.origin === "generated").length;
      countApplied(ctx, mode, apply.applied);
      await pushUpdate(
        ctx,
        trialRecord(ctx, trialId, task.id, mode, step, "update", {
          source: "actor_patch",
          operations: apply.applied.map(operationView),
          ...(validation.errors.length ? { dropped: validation.errors } : {}),
          memoryHash: memoryHash(memory),
        }),
      );
    }
    const evidenceId = `call-${trialId}-${step}`;
    const execution = await env.execute(response.action, evidenceId);
    const actionKey = operationKey(response.action);
    if (lastFailedKey !== undefined && lastFailedKey === actionKey) retries++;
    lastFailedKey = execution.passed ? undefined : actionKey;
    if (!execution.passed) failureObserved = true;
    if (execution.violation) {
      policyViolations.push(execution.violation);
      error = execution.violation;
      break;
    }
    if (response.action.tool === "read") {
      const key = `${response.action.path}|${env.observationGeneration}`;
      if (readKeys.has(key)) rereads++;
      readKeys.add(key);
    }
    const callEvent = normalizer.call({
      type: "tool_call",
      toolCallId: evidenceId,
      toolName: response.action.tool,
      input: actionInput(response.action),
    });
    const resultEvent = normalizer.result({
      type: "tool_result",
      toolCallId: callEvent.toolCallId,
      toolName: response.action.tool,
      input: actionInput(response.action),
      content: [{ type: "text", text: execution.text }],
      isError: !execution.passed,
      details: undefined,
    });
    await engine.process(callEvent);
    await engine.process(resultEvent);
    history.push({
      id: callEvent.id,
      role: "tool_call",
      text: JSON.stringify(actionInput(response.action)),
      sequence: history.length,
      sourceId: callEvent.id,
      toolName: response.action.tool,
      toolCallId: callEvent.toolCallId,
      truncated: false,
    });
    history.push({
      id: resultEvent.id,
      role: "tool_result",
      text: execution.text,
      sequence: history.length,
      sourceId: resultEvent.id,
      toolName: response.action.tool,
      toolCallId: callEvent.toolCallId,
      isError: !execution.passed,
      truncated: false,
    });
    if (execution.verification) {
      actorTests.push({
        testId: execution.verification.testId,
        step,
        passed: execution.passed,
      });
      mergeConstraints(execution.verification.constraints);
    }
    if (response.action.tool === "finish") {
      completed = true;
      break;
    }
    for (const injection of task.injections ?? [])
      if (injection.step === step + 1)
        held.push({
          id: `inj-${trialId}-${step}`,
          role: "user",
          text: injection.text,
          sequence: -1,
          sourceId: `inj-${trialId}-${step}`,
          truncated: false,
        });
  }
  if (!completed && !error) error = "action_budget_exhausted";
  const testResults: Record<string, "passed" | "failed" | "not_run"> = {};
  if (completed)
    for (const result of await env.evaluateFinal()) {
      testResults[result.testId] = result.status;
      mergeConstraints(result.constraints);
    }
  else for (const testId of task.allowedTests) testResults[testId] = "not_run";
  const finishedAt = new Date().toISOString();
  return scoreTrial({
    trialId,
    taskId: task.id,
    mode,
    iteration,
    startedAt,
    finishedAt,
    completed,
    cancelled: false,
    ...(error ? { error } : {}),
    policyViolations,
    constraints: Object.fromEntries(constraintVerdicts),
    testResults,
    actorTests,
    sentTexts,
    checkpoints: scoring?.checkpoints ?? [],
    failureObserved,
    rereads,
    retries,
    appliedExtractive,
    appliedGenerated,
    activeMemoryItems: memoryItems(memory).length,
    providerMode: config.provider.mode,
  });
}

function actorPatchContext(
  candidates: readonly Candidate[],
  observations: readonly TraceMessage[],
  memory: WorkMemory,
  responseId: string,
  responseText: string | undefined,
  step: number,
): ApplyContext {
  return {
    candidates,
    observations,
    extraSourceIds: [responseId],
    allowGenerated: true,
    now: step,
    extraSources: responseText
      ? [{ id: responseId, role: "assistant", text: responseText, trust: "assistant" }]
      : [],
  };
}

function substituteSelf(operation: PatchOperation, responseId: string): PatchOperation {
  if (!operation.sourceIds.includes("self")) return operation;
  return {
    ...operation,
    sourceIds: operation.sourceIds.map((id) => (id === "self" ? responseId : id)),
  };
}

async function auditStep(
  ctx: RunContext,
  input: Parameters<typeof updateMemory>[0],
  providers: ProviderSet,
  config: HybridConfig,
  mode: ExperimentMode,
  step: number,
): Promise<UpdateResult> {
  if (mode === "llm") {
    const provider = providers.update;
    if (!provider)
      return {
        memory: input.memory,
        candidates: input.candidates,
        decisions: [],
        held: [],
        applied: [],
        repairReasons: [],
        unavailable: "update_provider_missing",
      };
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
    const response = await instrumented(
      ctx,
      "update",
      mode,
      request,
      () => provider.update(request, callOptions(config)),
      `audit-${mode}`,
      "audit",
      step,
      config,
    );
    if (response.error || !response.operations)
      return {
        memory: input.memory,
        candidates: input.candidates,
        decisions: [],
        held: [],
        applied: [],
        repairReasons: ["invalid_update"],
        unavailable: response.error ?? "invalid_update",
      };
    const apply = applyOperations(input.memory, response.operations, applyContext(input, true));
    if (!apply.ok)
      return {
        memory: input.memory,
        candidates: input.candidates,
        decisions: [],
        held: [],
        applied: [],
        repairReasons: ["invalid_update"],
        unavailable: apply.reason,
      };
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
  if (mode === "history")
    return {
      memory: input.memory,
      candidates: input.candidates,
      decisions: [],
      held: [],
      applied: [],
      repairReasons: [],
    };
  return updateWithProviders(ctx, input, providers, config, `audit-${mode}`, "audit", step);
}

async function updateWithProviders(
  ctx: RunContext,
  input: Parameters<typeof updateMemory>[0],
  providers: ProviderSet,
  config: HybridConfig,
  trialId: string,
  taskId: string,
  step: number,
): Promise<UpdateResult> {
  const jevProvider = providers.jev;
  const repairProvider = providers.repair;
  const jev: JevProvider | undefined = jevProvider && {
    name: jevProvider.name,
    choose: (request: JevRequest, options?: CallOptions) =>
      instrumented(
        ctx,
        "jev",
        input.mode,
        request,
        () => jevProvider.choose(request, options ?? callOptions(config)),
        trialId,
        taskId,
        step,
        config,
      ),
  };
  const repair: RepairProvider | undefined = repairProvider && {
    name: repairProvider.name,
    repair: (request: RepairRequest, options?: CallOptions) =>
      instrumented(
        ctx,
        "repair",
        input.mode,
        request,
        () => repairProvider.repair(request, options ?? callOptions(config)),
        trialId,
        taskId,
        step,
        config,
      ),
  };
  return updateMemory(input, {
    ...(jev ? { jev } : {}),
    ...(repair ? { repair } : {}),
    ...(config.provider.jevModel ? { jevModel: config.provider.jevModel } : {}),
    ...((config.provider.repairModel ?? config.provider.actorModel)
      ? { repairModel: config.provider.repairModel ?? config.provider.actorModel }
      : {}),
    maxQuestions: config.budgets.maxQuestions,
    maxRepairCalls: config.budgets.maxRepairCalls,
    memoryBytes: config.budgets.memoryBytes,
    requestBytes: config.budgets.requestBytes,
    signal: AbortSignal.timeout(config.provider.timeoutMs),
  });
}

async function instrumented<
  T extends {
    latencyMs?: number;
    usage?: CallRecord["usage"];
    error?: string;
    rawText?: string;
  },
>(
  ctx: RunContext,
  kind: CallRecord["kind"],
  mode: ExperimentMode,
  request: unknown,
  call: () => Promise<T>,
  trialId: string,
  taskId: string,
  step: number,
  config: HybridConfig,
): Promise<T> {
  const bytes = Buffer.byteLength(JSON.stringify(sentRequestBody(kind, request)));
  const hash = requestHash(kind, request);
  const callId = `${kind}-${trialId}-${step}-${ctx.callSeq++}`;
  const notSent = async (error: string): Promise<never> => {
    await pushCall(ctx, {
      callId,
      runId: ctx.runId,
      trialId,
      taskId,
      mode,
      step,
      kind,
      model: modelFor(kind, config),
      providerInvoked: false,
      requestBytes: bytes,
      requestHash: hash,
      startedAt: new Date().toISOString(),
      latencyMs: null,
      error,
      attempts: 0,
    });
    throw new BudgetExhausted();
  };
  if (ctx.budget.sent >= ctx.budget.limit) await notSent("not_sent");
  const sentForTrial = ctx.trialSent.get(trialId) ?? 0;
  if (sentForTrial >= config.provider.trialMaxRequests) await notSent("not_sent_trial_budget");
  ctx.budget.sent++;
  ctx.trialSent.set(trialId, sentForTrial + 1);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  // A start record precedes the invocation so a crash before the end record is
  // distinguishable from "no request was made".
  await pushCallStart(ctx, {
    record: "call_start",
    callId,
    runId: ctx.runId,
    trialId,
    taskId,
    mode,
    step,
    kind,
    model: modelFor(kind, config),
    startedAt,
    requestBytes: bytes,
    requestHash: hash,
  });
  try {
    const response = await call();
    await pushCall(ctx, {
      callId,
      runId: ctx.runId,
      trialId,
      taskId,
      mode,
      step,
      kind,
      model: modelFor(kind, config),
      providerInvoked: true,
      requestBytes: bytes,
      requestHash: hash,
      startedAt,
      latencyMs: response.latencyMs ?? performance.now() - started,
      ...(response.usage ? { usage: response.usage } : {}),
      ...(response.error ? { error: response.error } : {}),
      ...(config.recordResponseText && typeof response.rawText === "string"
        ? { responseText: response.rawText }
        : {}),
      attempts: 1,
    });
    return response;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    await pushCall(ctx, {
      callId,
      runId: ctx.runId,
      trialId,
      taskId,
      mode,
      step,
      kind,
      model: modelFor(kind, config),
      providerInvoked: true,
      requestBytes: bytes,
      requestHash: hash,
      startedAt,
      latencyMs: performance.now() - started,
      error: error instanceof Error ? error.message : "provider_error",
      attempts: 1,
    });
    throw error;
  }
}

function modelFor(kind: CallRecord["kind"], config: HybridConfig): string {
  if (kind === "jev") return config.provider.jevModel ?? "fake-jev";
  if (kind === "repair") return config.provider.repairModel ?? "fake-repair";
  if (kind === "update")
    return config.provider.updateModel ?? config.provider.actorModel ?? "fake-update";
  return config.provider.actorModel ?? "fake-actor";
}

function callOptions(config: HybridConfig): CallOptions {
  return { signal: AbortSignal.timeout(config.provider.timeoutMs) };
}

function actorProvider(providers: ProviderSet): ActorProvider {
  if (!providers.actor) throw new Error("actor provider is required for closed_loop");
  return providers.actor;
}

function fakeProviders(tasks: readonly HybridTask[]): ProviderSet {
  return {
    jev: new FakeJevProvider(),
    repair: new FakeRepairProvider(),
    actor: new FakeActorProvider(tasks),
    update: new FakeUpdateProvider(),
  };
}

function auditGroups(messages: readonly TraceMessage[]): ObservationGroup[] {
  const groups: ObservationGroup[] = [];
  let current: TraceMessage[] = [];
  for (const message of messages) {
    current.push(message);
    if (message.role === "user") {
      if (current.length > 1) {
        groups.push({ messages: current.slice(0, -1) });
        current = [message];
      }
    }
  }
  if (current.length) groups.push({ messages: current });
  return groups.filter((group) => group.messages.length);
}

function auditInstruction(trace: TraceData): string {
  return trace.messages.find((message) => message.role === "user")?.text ?? "Trace audit";
}

async function recordContext(
  ctx: RunContext,
  args: {
    trialId: string;
    taskId: string;
    mode: ExperimentMode;
    step: number;
    projected: ProjectedInput;
    config: HybridConfig;
  },
): Promise<void> {
  const { projected } = args;
  await pushContext(ctx, {
    runId: ctx.runId,
    trialId: args.trialId,
    taskId: args.taskId,
    mode: args.mode,
    step: args.step,
    bytes: projected.bundle.bytes,
    sentBytes: Buffer.byteLength(projected.userText),
    included: [
      "instruction",
      "fixedTools",
      "facts",
      "memory",
      "latest",
      ...(projected.bundle.history === undefined ? [] : ["history"]),
    ],
    truncated: projected.bundle.truncated,
    ...(args.config.recordContextText ? { text: projected.userText } : {}),
  });
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

function trialRecord(
  ctx: RunContext,
  trialId: string,
  taskId: string,
  mode: ExperimentMode,
  step: number,
  kind: UpdateRecord["kind"],
  data: Record<string, unknown>,
): UpdateRecord {
  return { runId: ctx.runId, trialId, taskId, mode, step, kind, ...data };
}

function auditRecord(
  ctx: RunContext,
  kind: UpdateRecord["kind"],
  step: number,
  mode: string,
  data: Record<string, unknown>,
): UpdateRecord {
  return {
    runId: ctx.runId,
    trialId: `audit-${mode}`,
    taskId: "audit",
    mode: mode as ExperimentMode,
    step,
    kind,
    ...data,
  };
}

function rememberCandidates(
  ctx: RunContext,
  mode: ExperimentMode,
  candidates: readonly Candidate[],
): void {
  const set = ctx.uniqueCandidates.get(mode) ?? new Set<string>();
  for (const candidate of candidates) set.add(candidate.id);
  ctx.uniqueCandidates.set(mode, set);
}

function countDecisions(ctx: RunContext, mode: ExperimentMode, count: number): void {
  ctx.decisionCounts.set(mode, (ctx.decisionCounts.get(mode) ?? 0) + count);
}

function countApplied(
  ctx: RunContext,
  mode: ExperimentMode,
  applied: readonly PatchOperation[],
): void {
  const current = ctx.appliedCounts.get(mode) ?? { extractive: 0, generated: 0 };
  for (const operation of applied) {
    if (operation.origin === "extracted") current.extractive++;
    else current.generated++;
  }
  ctx.appliedCounts.set(mode, current);
}

function operationView(operation: PatchOperation): Record<string, unknown> {
  return {
    operation: operation.operation,
    kind: operation.kind,
    sourceIds: operation.sourceIds,
    origin: operation.origin,
    trust: operation.trust,
    ...(operation.itemId ? { itemId: operation.itemId } : {}),
    ...(operation.replaces ? { replaces: operation.replaces } : {}),
  };
}

function memoryHash(memory: WorkMemory): string {
  return createHash("sha256").update(JSON.stringify(memory)).digest("hex").slice(0, 16);
}

function actionInput(action: ActorAction): Record<string, unknown> {
  return { ...action };
}

function operationKey(action: ActorAction): string {
  return JSON.stringify(actionInput(action));
}

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createManifest(
  config: HybridConfig,
  input: string,
  evaluation: "trace_audit" | "closed_loop",
  runId: string,
): Promise<ExperimentManifest> {
  let head: string | null = null;
  try {
    head = (await execFile("git", ["rev-parse", "HEAD"])).stdout.trim() || null;
  } catch {
    head = null;
  }
  return {
    schemaVersion: HYBRID_SCHEMA_VERSION,
    runId,
    status: "completed",
    head,
    inputHash: createHash("sha256").update(input).digest("hex"),
    config,
    modes: config.modes,
    provider: config.provider.mode,
    evaluation,
    modelIds: {
      jev: config.provider.jevModel ?? null,
      actor: config.provider.actorModel ?? null,
      repair: config.provider.repairModel ?? null,
      update: config.provider.updateModel ?? null,
    },
    sdkVersion: "@earendil-works/pi-coding-agent@0.83.0",
    promptVersion: PROMPT_VERSION,
    startedAt: new Date().toISOString(),
    environment: experimentEnvironment(config),
    privacy: {
      recordContextText: config.recordContextText,
      recordResponseText: config.recordResponseText,
    },
  };
}

function experimentEnvironment(config: HybridConfig): ExperimentEnvironment {
  return {
    node: process.version,
    platform: process.platform,
    isolation: config.provider.executionIsolation === "required" ? "sandbox-exec" : "none",
  };
}
