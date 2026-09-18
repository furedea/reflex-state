import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { defaultConfig } from "../../core/config.js";
import { StateEngine } from "../../core/engine.js";
import { NoopStateUpdater } from "../../core/updater.js";
import { PiEventNormalizer } from "../../pi/normalization.js";
import { evaluateAudit, summarize } from "./evaluation.js";
import { buildProjection } from "./projection.js";
import { buildActorRequest } from "./prompts.js";
import {
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  type ActorProvider,
  type JevProvider,
  type ProviderSet,
  type RepairProvider,
} from "./providers.js";
import { generateCandidates } from "./trace.js";
import type {
  ActorAction,
  CallRecord,
  Candidate,
  ContextRecord,
  ExperimentManifest,
  ExperimentMode,
  ExperimentSummary,
  HybridConfig,
  HybridTask,
  InputBundle,
  RunScore,
  TraceData,
  TraceMessage,
  UpdateResult,
  WorkMemory,
} from "./types.js";
import { emptyMemory, HYBRID_SCHEMA_VERSION, PROMPT_VERSION } from "./types.js";
import { applyOperations, factsFromState, initialFacts, updateMemory } from "./update.js";

const execFile = promisify(execFileCallback);

export interface ExperimentRun {
  readonly manifest: ExperimentManifest;
  readonly updates: readonly Record<string, unknown>[];
  readonly calls: readonly CallRecord[];
  readonly contexts: readonly ContextRecord[];
  readonly summary: ExperimentSummary;
}

export async function runAudit(options: {
  readonly config: HybridConfig;
  readonly trace: TraceData;
  readonly labels?: readonly import("./types.js").AuditLabel[];
  readonly providers?: ProviderSet;
}): Promise<ExperimentRun> {
  const providers = options.providers ?? fakeProviders([]);
  const calls: CallRecord[] = [];
  const contexts: ContextRecord[] = [];
  const updates: Record<string, unknown>[] = [];
  const allCandidates = generateCandidates(options.trace.messages, {
    maxBytes: options.config.candidateMaxBytes,
  });
  const selected: Record<ExperimentMode, string[]> = {
    history: [],
    llm: [],
    rules: [],
    jev: [],
  };
  for (const mode of options.config.modes) {
    let memory = emptyMemory();
    for (let index = 0; index < options.trace.messages.length; index++) {
      const observations = options.trace.messages.slice(0, index + 1);
      const latest = options.trace.messages.slice(Math.max(0, index - 1), index + 1);
      const candidates = allCandidates.filter((candidate) => candidate.observedAt <= index);
      const input = {
        instruction: "Trace audit input",
        mode,
        state: new StateEngine({
          cwd: "/experiment",
          config: defaultConfig(),
          updater: new NoopStateUpdater(),
        }).state,
        facts: initialFacts(),
        memory,
        candidates,
        observations,
        latest,
        step: index,
        now: index,
      } as const;
      const projection = buildProjection({
        ...input,
        history: observations,
        budgets: options.config.budgets,
      });
      contexts.push(contextRecord(options.config, projection, mode, index));
      const result = await updateWithProviders(input, providers, options.config, calls);
      memory = result.memory;
      selected[mode].push(
        ...result.decisions
          .filter((decision) => decision.disposition === "selected")
          .map((decision) => decision.candidateId),
      );
      updates.push({
        mode,
        step: index,
        candidates,
        decisions: result.decisions,
        memory,
        repairReasons: result.repairReasons,
        unavailable: result.unavailable,
      });
    }
  }
  const summary = summarize(
    "trace_audit",
    options.config.modes,
    [],
    calls,
    contexts,
    generatedCount(updates),
    selectedCount(updates),
  );
  const manifest = await createManifest(options.config, options.trace.sourceHash, "trace_audit");
  const audit = evaluateAudit(allCandidates, options.labels ?? [], selected);
  updates.push({
    labels: options.labels ?? [],
    selected,
    agreement: audit.agreement,
    evaluation_kind: "trace_audit",
  });
  return { manifest, updates, calls, contexts, summary };
}

export async function runClosedLoop(options: {
  readonly config: HybridConfig;
  readonly tasks: readonly HybridTask[];
  readonly providers?: ProviderSet;
}): Promise<ExperimentRun> {
  const providers = options.providers ?? fakeProviders(options.tasks);
  const calls: CallRecord[] = [];
  const contexts: ContextRecord[] = [];
  const updates: Record<string, unknown>[] = [];
  const scores: RunScore[] = [];
  for (const mode of options.config.modes) {
    for (const task of options.tasks) {
      const score = await runTask(mode, task, options.config, providers, calls, contexts, updates);
      scores.push(score);
    }
  }
  const summary = summarize(
    "closed_loop",
    options.config.modes,
    scores,
    calls,
    contexts,
    generatedCount(updates),
    selectedCount(updates),
  );
  const inputHash = options.tasks.map((task) => JSON.stringify(task)).join("\n");
  const manifest = await createManifest(options.config, inputHash, "closed_loop");
  return { manifest, updates, calls, contexts, summary };
}

function fakeProviders(tasks: readonly HybridTask[]): ProviderSet {
  return {
    jev: new FakeJevProvider(),
    repair: new FakeRepairProvider(),
    actor: new FakeActorProvider(tasks),
  };
}

async function updateWithProviders(
  input: Parameters<typeof updateMemory>[0],
  providers: ProviderSet,
  config: HybridConfig,
  calls: CallRecord[],
): Promise<UpdateResult> {
  const jev = instrumentJev(providers.jev, input.mode, config, calls);
  const repair = instrumentRepair(providers.repair, input.mode, config, calls);
  return updateMemory(input, {
    jev,
    repair,
    ...(config.provider.jevModel ? { jevModel: config.provider.jevModel } : {}),
    ...((config.provider.repairModel ?? config.provider.actorModel)
      ? { repairModel: config.provider.repairModel ?? config.provider.actorModel }
      : {}),
    maxQuestions: config.budgets.maxQuestions,
    maxRepairCalls: config.budgets.maxRepairCalls,
    memoryBytes: config.budgets.memoryBytes,
    requestBytes: config.budgets.requestBytes,
  });
}

async function runTask(
  mode: ExperimentMode,
  task: HybridTask,
  config: HybridConfig,
  providers: ProviderSet,
  calls: CallRecord[],
  contexts: ContextRecord[],
  updates: Record<string, unknown>[],
): Promise<RunScore> {
  let memory = emptyMemory();
  let facts = initialFacts();
  const history: TraceMessage[] = [];
  const workspace = new Map(Object.entries(task.files));
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
  history.push({
    id: initialPrompt.id,
    role: "user",
    text: task.instruction,
    sequence: 0,
    sourceId: initialPrompt.id,
    truncated: false,
  });
  let completed = false;
  let testPassed = false;
  let rereads = 0;
  let retries = 0;
  const policyViolations: string[] = [];
  let unavailable: string | undefined;
  for (let step = 0; step < config.budgets.maxActions; step++) {
    const latest = history.slice(-2);
    const inputState = {
      mode,
      instruction: task.instruction,
      state: engine.state,
      facts,
      memory,
      candidates: generateCandidates(latest, { maxBytes: config.candidateMaxBytes }),
      observations: history,
      latest,
      step,
      now: step,
    } as const;
    const projection = buildProjection({ ...inputState, history, budgets: config.budgets });
    contexts.push(contextRecord(config, projection, mode, step));
    if (projection.unavailable) {
      unavailable = projection.unavailable;
      break;
    }
    const actor = instrumentActor(providers.actor, mode, config, calls);
    const response = await actor.act(
      buildActorRequest(
        mode,
        task.id,
        task.instruction,
        projection,
        config.provider.actorModel ?? "fake",
      ),
    );
    if (response.error || !response.action) {
      unavailable = response.error ?? "actor_action_missing";
      break;
    }
    if (mode === "llm") {
      if (response.statePatch === undefined) {
        unavailable = "invalid_update";
        updates.push({ mode, taskId: task.id, step, action: response.action, unavailable });
        break;
      }
      const patchResult = applyActorPatch(memory, response.statePatch, inputState.candidates, step);
      if (!patchResult.ok) {
        unavailable = "invalid_update";
        updates.push({ mode, taskId: task.id, step, action: response.action, unavailable });
        break;
      }
      memory = patchResult.memory;
    } else if (mode === "rules" || mode === "jev") {
      const result = await updateWithProviders(inputState, providers, config, calls);
      memory = result.memory;
      updates.push({
        mode,
        taskId: task.id,
        step,
        decisions: result.decisions,
        repairReasons: result.repairReasons,
        unavailable: result.unavailable,
      });
      if (result.unavailable) {
        unavailable = result.unavailable;
        break;
      }
    }
    const execution = executeAction(response.action, workspace, task);
    if (execution.violation) {
      policyViolations.push(execution.violation);
      unavailable = execution.violation;
      break;
    }
    if (response.action.tool === "read") rereads++;
    if (response.action.tool === "finish") {
      completed = true;
      testPassed = testsPass(workspace, task);
      break;
    }
    if (response.action.tool === "test") testPassed = execution.passed;
    const call = normalizer.call({
      type: "tool_call",
      toolCallId: `task-${mode}-${task.id}-${step}`,
      toolName: response.action.tool,
      input: actionInput(response.action),
    });
    const result = normalizer.result({
      type: "tool_result",
      toolCallId: call.toolCallId,
      toolName: response.action.tool,
      input: actionInput(response.action),
      content: [{ type: "text", text: execution.text }],
      isError: !execution.passed,
      details: undefined,
    });
    await engine.process(call);
    await engine.process(result);
    facts = factsFromState(engine.state, defaultConfig());
    history.push({
      id: call.id,
      role: "tool_call",
      text: JSON.stringify(actionInput(response.action)),
      sequence: history.length,
      sourceId: call.id,
      toolName: response.action.tool,
      toolCallId: call.toolCallId,
      truncated: false,
    });
    history.push({
      id: result.id,
      role: "tool_result",
      text: execution.text,
      sequence: history.length,
      sourceId: result.id,
      toolName: response.action.tool,
      toolCallId: call.toolCallId,
      isError: !execution.passed,
      truncated: false,
    });
  }
  if (!completed && !unavailable) unavailable = "action_budget_exhausted";
  return {
    taskId: task.id,
    mode,
    completed,
    testPassed: completed && testPassed,
    informationRetained: memoryCount(memory) > 0 || mode === "history",
    policyViolations,
    rereads,
    retries,
    ...(unavailable ? { unavailable } : {}),
  };
}

function executeAction(
  action: ActorAction,
  workspace: Map<string, string>,
  task: HybridTask,
): { readonly text: string; readonly passed: boolean; readonly violation?: string } {
  if (action.path && !safePath(action.path))
    return { text: "path rejected", passed: false, violation: "path_escape" };
  if (action.tool === "read")
    return {
      text: workspace.get(action.path ?? "") ?? "file not found",
      passed: workspace.has(action.path ?? ""),
    };
  if (action.tool === "write") {
    if (!action.path || action.content === undefined)
      return { text: "invalid write", passed: false, violation: "invalid_action" };
    workspace.set(action.path, action.content);
    return { text: "write ok", passed: true };
  }
  if (action.tool === "edit") {
    if (!action.path || action.replacement === undefined || !workspace.has(action.path))
      return { text: "invalid edit", passed: false, violation: "invalid_action" };
    workspace.set(action.path, action.replacement);
    return { text: "edit ok", passed: true };
  }
  if (action.tool === "test") {
    if (action.command && !task.tests.includes(action.command))
      return { text: "test command rejected", passed: false, violation: "test_not_allowed" };
    const passed = testsPass(workspace, task);
    return { text: passed ? "tests passed" : "tests failed", passed };
  }
  return { text: "finished", passed: true };
}

function testsPass(workspace: ReadonlyMap<string, string>, task: HybridTask): boolean {
  const expected = task.expectedFiles;
  if (expected)
    return Object.entries(expected).every(([path, content]) => workspace.get(path) === content);
  return task.tests.length > 0;
}

function actionInput(action: ActorAction): Record<string, unknown> {
  return { ...action };
}

function safePath(path: string): boolean {
  return !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\");
}

function applyActorPatch(
  memory: WorkMemory,
  operations: readonly import("./types.js").PatchOperation[],
  candidates: readonly Candidate[],
  now: number,
) {
  return applyOperations(memory, operations, candidates, now);
}

function instrumentJev(
  provider: JevProvider,
  mode: ExperimentMode,
  config: HybridConfig,
  calls: CallRecord[],
): JevProvider {
  return {
    name: provider.name,
    choose: async (request) => {
      if (calls.length >= config.provider.maxRequests) {
        calls.push({
          kind: "jev",
          mode,
          model: config.provider.jevModel ?? provider.name,
          requestBytes: Buffer.byteLength(JSON.stringify(request)),
          startedAt: new Date().toISOString(),
          latencyMs: 0,
          error: "request_limit",
          attempts: 1,
        });
        return { answers: [], error: "request_limit" };
      }
      return recordCall(
        calls,
        "jev",
        mode,
        config.provider.jevModel ?? provider.name,
        request,
        () => provider.choose(request),
      );
    },
  };
}

function instrumentRepair(
  provider: RepairProvider,
  mode: ExperimentMode,
  config: HybridConfig,
  calls: CallRecord[],
): RepairProvider {
  return {
    name: provider.name,
    repair: async (request) => {
      if (calls.length >= config.provider.maxRequests) {
        calls.push({
          kind: "repair",
          mode,
          model: config.provider.repairModel ?? provider.name,
          requestBytes: Buffer.byteLength(JSON.stringify(request)),
          startedAt: new Date().toISOString(),
          latencyMs: 0,
          error: "request_limit",
          attempts: 1,
        });
        return { operations: [], error: "request_limit" };
      }
      return recordCall(
        calls,
        "repair",
        mode,
        config.provider.repairModel ?? provider.name,
        request,
        () => provider.repair(request),
      );
    },
  };
}

function instrumentActor(
  provider: ActorProvider,
  mode: ExperimentMode,
  config: HybridConfig,
  calls: CallRecord[],
): ActorProvider {
  return {
    name: provider.name,
    act: async (request) => {
      if (calls.length >= config.provider.maxRequests) {
        calls.push({
          kind: "actor",
          mode,
          model: config.provider.actorModel ?? provider.name,
          requestBytes: Buffer.byteLength(JSON.stringify(request)),
          startedAt: new Date().toISOString(),
          latencyMs: 0,
          error: "request_limit",
          attempts: 1,
        });
        return { error: "request_limit" };
      }
      return recordCall(
        calls,
        "actor",
        mode,
        config.provider.actorModel ?? provider.name,
        request,
        () => provider.act(request),
      );
    },
  };
}

async function recordCall<
  T extends {
    readonly latencyMs?: number;
    readonly usage?: import("./types.js").Usage;
    readonly error?: string;
  },
>(
  calls: CallRecord[],
  kind: CallRecord["kind"],
  mode: ExperimentMode,
  model: string,
  request: unknown,
  action: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const response = await action();
    calls.push({
      kind,
      mode,
      model,
      requestBytes: Buffer.byteLength(JSON.stringify(request)),
      startedAt: new Date().toISOString(),
      latencyMs: response.latencyMs ?? performance.now() - started,
      ...(response.usage ? { usage: response.usage } : {}),
      ...(response.error ? { error: response.error } : {}),
      attempts: 1,
    });
    return response;
  } catch (error) {
    calls.push({
      kind,
      mode,
      model,
      requestBytes: Buffer.byteLength(JSON.stringify(request)),
      startedAt: new Date().toISOString(),
      latencyMs: performance.now() - started,
      error: error instanceof Error ? error.message : "provider_error",
      attempts: 1,
    });
    throw error;
  }
}

function contextRecord(
  config: HybridConfig,
  input: InputBundle,
  mode: ExperimentMode,
  step: number,
): ContextRecord {
  return {
    mode,
    step,
    bytes: input.bytes,
    included: [
      "instruction",
      "fixedTools",
      "facts",
      "memory",
      "latest",
      ...(input.history === undefined ? [] : ["history"]),
    ],
    truncated: input.truncated,
    ...(config.recordContextText ? { text: JSON.stringify(input) } : {}),
  };
}

function generatedCount(updates: readonly Record<string, unknown>[]): number {
  return updates.reduce((count, update) => {
    const memory = update.memory;
    if (!memory || typeof memory !== "object") return count;
    const items = Object.values(memory as Record<string, unknown>).flatMap((value) =>
      Array.isArray(value) ? value : [],
    );
    return (
      count +
      items.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as Record<string, unknown>).origin === "generated",
      ).length
    );
  }, 0);
}

function selectedCount(updates: readonly Record<string, unknown>[]): number {
  return updates.reduce((count, update) => {
    const decisions = update.decisions;
    if (!Array.isArray(decisions)) return count;
    return (
      count +
      decisions.filter(
        (decision) =>
          decision &&
          typeof decision === "object" &&
          (decision as Record<string, unknown>).disposition === "selected",
      ).length
    );
  }, 0);
}

function memoryCount(memory: WorkMemory): number {
  return Object.values(memory).reduce((count, items) => count + items.length, 0);
}

async function createManifest(
  config: HybridConfig,
  input: string,
  evaluation: "trace_audit" | "closed_loop",
): Promise<ExperimentManifest> {
  let head: string | null = null;
  try {
    head = (await execFile("git", ["rev-parse", "HEAD"])).stdout.trim() || null;
  } catch {
    head = null;
  }
  return {
    schemaVersion: HYBRID_SCHEMA_VERSION,
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
    },
    sdkVersion: "@earendil-works/pi-coding-agent@0.83.0",
    promptVersion: PROMPT_VERSION,
    startedAt: new Date().toISOString(),
    privacy: { recordContextText: config.recordContextText },
  };
}
