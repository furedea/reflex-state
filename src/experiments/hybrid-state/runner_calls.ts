import {
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  FakeUpdateProvider,
  type ActorProvider,
  type CallOptions,
  type JevProvider,
  type ProviderSet,
  requestHash,
  sentRequestBody,
  type RepairProvider,
} from "./providers.js";
import {
  BudgetExhausted,
  PersistenceError,
  pushCall,
  pushCallStart,
  type RunContext,
} from "./runner_context.js";
import type {
  CallRecord,
  ExperimentMode,
  HybridConfig,
  HybridTask,
  UpdateResult,
} from "./types.js";
import { updateMemory } from "./update.js";

/** Where a provider call happens: which trial step, under which config. */
export interface StepScope {
  readonly trialId: string;
  readonly taskId: string;
  readonly step: number;
  readonly config: HybridConfig;
}

export interface UpdateScope extends StepScope {
  readonly providers: ProviderSet;
}

export interface CallSpec extends StepScope {
  readonly kind: CallRecord["kind"];
  readonly mode: ExperimentMode;
  readonly request: unknown;
}

interface Instrumentable {
  latencyMs?: number;
  usage?: CallRecord["usage"];
  error?: string;
  rawText?: string;
  responseModel?: string;
}

interface CallBase {
  readonly callId: string;
  readonly runId: string;
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly step: number;
  readonly kind: CallRecord["kind"];
  readonly model: string;
}

interface CallAttempt {
  readonly base: CallBase;
  readonly requestBytes: number;
  readonly requestHash: string;
}

interface RunningCall extends CallAttempt {
  readonly startedAt: string;
  readonly started: number;
}

interface ProviderBinding {
  readonly ctx: RunContext;
  readonly mode: ExperimentMode;
  readonly scope: StepScope;
}

export async function instrumented<T extends Instrumentable>(
  ctx: RunContext,
  spec: CallSpec,
  call: () => Promise<T>,
): Promise<T> {
  const attempt = openAttempt(ctx, spec);
  await admit(ctx, spec, attempt);
  const running: RunningCall = {
    ...attempt,
    startedAt: new Date().toISOString(),
    started: performance.now(),
  };
  // A start record precedes the invocation so a crash before the end record is
  // distinguishable from "no request was made".
  await pushCallStart(ctx, {
    record: "call_start",
    ...attempt.base,
    startedAt: running.startedAt,
    requestBytes: attempt.requestBytes,
    requestHash: attempt.requestHash,
  });
  try {
    const response = await call();
    await pushCall(ctx, completedCall(running, response, spec.config.recordResponseText));
    return response;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    await pushCall(ctx, failedCall(running, error));
    throw error;
  }
}

export async function updateWithProviders(
  ctx: RunContext,
  input: Parameters<typeof updateMemory>[0],
  scope: UpdateScope,
): Promise<UpdateResult> {
  const { providers, config } = scope;
  const binding: ProviderBinding = { ctx, mode: input.mode, scope };
  const jev = providers.jev && instrumentedJev(providers.jev, binding);
  const repair = providers.repair && instrumentedRepair(providers.repair, binding);
  return updateMemory(input, {
    ...(jev ? { jev } : {}),
    ...(repair ? { repair } : {}),
    ...modelSettings(config),
    maxQuestions: config.budgets.maxQuestions,
    maxRepairCalls: config.budgets.maxRepairCalls,
    memoryBytes: config.budgets.memoryBytes,
    requestBytes: config.budgets.requestBytes,
    signal: AbortSignal.timeout(config.provider.timeoutMs),
  });
}

export function callOptions(config: HybridConfig): CallOptions {
  return { signal: AbortSignal.timeout(config.provider.timeoutMs) };
}

export function actorProvider(providers: ProviderSet): ActorProvider {
  if (!providers.actor) throw new Error("actor provider is required for closed_loop");
  return providers.actor;
}

export function fakeProviders(tasks: readonly HybridTask[]): ProviderSet {
  return {
    jev: new FakeJevProvider(),
    repair: new FakeRepairProvider(),
    actor: new FakeActorProvider(tasks),
    update: new FakeUpdateProvider(),
  };
}

function instrumentedJev(provider: JevProvider, binding: ProviderBinding): JevProvider {
  const { ctx, mode, scope } = binding;
  return {
    name: provider.name,
    choose: (request, options) =>
      instrumented(ctx, { kind: "jev", mode, request, ...scope }, () =>
        provider.choose(request, options ?? callOptions(scope.config)),
      ),
  };
}

function instrumentedRepair(provider: RepairProvider, binding: ProviderBinding): RepairProvider {
  const { ctx, mode, scope } = binding;
  return {
    name: provider.name,
    repair: (request, options) =>
      instrumented(ctx, { kind: "repair", mode, request, ...scope }, () =>
        provider.repair(request, options ?? callOptions(scope.config)),
      ),
  };
}

function modelSettings(config: HybridConfig): {
  readonly jevModel?: string;
  readonly repairModel?: string;
} {
  const repairModel = config.provider.repairModel ?? config.provider.actorModel;
  return {
    ...(config.provider.jevModel ? { jevModel: config.provider.jevModel } : {}),
    ...(repairModel ? { repairModel } : {}),
  };
}

function openAttempt(ctx: RunContext, spec: CallSpec): CallAttempt {
  const { kind, request } = spec;
  const requestBytes = Buffer.byteLength(JSON.stringify(sentRequestBody(kind, request)));
  const hash = requestHash(kind, request);
  return {
    base: {
      callId: `${kind}-${spec.trialId}-${spec.step}-${ctx.callSeq++}`,
      runId: ctx.runId,
      trialId: spec.trialId,
      taskId: spec.taskId,
      mode: spec.mode,
      step: spec.step,
      kind,
      model: modelFor(kind, spec.config),
    },
    requestBytes,
    requestHash: hash,
  };
}

async function admit(ctx: RunContext, spec: CallSpec, attempt: CallAttempt): Promise<void> {
  if (ctx.budget.sent >= ctx.budget.limit) await rejectUnsent(ctx, attempt, "not_sent");
  const sentForTrial = ctx.trialSent.get(spec.trialId) ?? 0;
  if (sentForTrial >= spec.config.provider.trialMaxRequests)
    await rejectUnsent(ctx, attempt, "not_sent_trial_budget");
  ctx.budget.sent++;
  ctx.trialSent.set(spec.trialId, sentForTrial + 1);
}

async function rejectUnsent(ctx: RunContext, attempt: CallAttempt, error: string): Promise<never> {
  await pushCall(ctx, {
    ...attempt.base,
    providerInvoked: false,
    requestBytes: attempt.requestBytes,
    requestHash: attempt.requestHash,
    startedAt: new Date().toISOString(),
    latencyMs: null,
    error,
    attempts: 0,
  });
  throw new BudgetExhausted();
}

function completedCall(
  running: RunningCall,
  response: Instrumentable,
  recordResponseText: boolean,
): CallRecord {
  return {
    ...running.base,
    providerInvoked: true,
    requestBytes: running.requestBytes,
    requestHash: running.requestHash,
    startedAt: running.startedAt,
    latencyMs: response.latencyMs ?? performance.now() - running.started,
    ...(response.usage ? { usage: response.usage } : {}),
    ...(response.error ? { error: response.error } : {}),
    ...(response.responseModel ? { responseModel: response.responseModel } : {}),
    ...(recordResponseText && typeof response.rawText === "string"
      ? { responseText: response.rawText }
      : {}),
    attempts: 1,
  };
}

function failedCall(running: RunningCall, error: unknown): CallRecord {
  return {
    ...running.base,
    providerInvoked: true,
    requestBytes: running.requestBytes,
    requestHash: running.requestHash,
    startedAt: running.startedAt,
    latencyMs: performance.now() - running.started,
    error: error instanceof Error ? error.message : "provider_error",
    attempts: 1,
  };
}

function modelFor(kind: CallRecord["kind"], config: HybridConfig): string {
  if (kind === "jev") return config.provider.jevModel ?? "fake-jev";
  if (kind === "repair") return config.provider.repairModel ?? "fake-repair";
  if (kind === "update")
    return config.provider.updateModel ?? config.provider.actorModel ?? "fake-update";
  return config.provider.actorModel ?? "fake-actor";
}
