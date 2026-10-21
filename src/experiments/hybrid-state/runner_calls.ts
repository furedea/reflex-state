import type { ProjectedInput } from "./projection.js";
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
  persistSystemPrompt,
  pushCall,
  pushCallStart,
  pushContext,
  pushUpdate,
  type ConfiguredRunContext,
} from "./runner_context.js";
import type { TrialIdentity } from "./runner_scoring.js";
import type {
  ActorRequest,
  ActorResponse,
  CallRecord,
  CallStartRecord,
  HybridConfig,
  HybridTask,
  UpdateRecord,
  UpdateResult,
} from "./types.js";
import { updateMemory } from "./update.js";

/** What a provider response reports about the call that produced it. */
interface Instrumentable {
  latencyMs?: number;
  usage?: CallRecord["usage"];
  error?: string;
  rawText?: string;
  responseModel?: string;
}

/** A trial's access to the run: the shared run state, the providers, and the
 * trial's identity. */
export class TrialSession {
  constructor(
    readonly ctx: ConfiguredRunContext,
    readonly providers: ProviderSet,
    readonly identity: TrialIdentity,
  ) {}

  step(index: number): TrialStep {
    return new TrialStep(this, index);
  }
}

/** One step of a trial: every record and provider call of the step is
 * addressed by the trial's identity and the step index. */
export class TrialStep {
  constructor(
    private readonly session: TrialSession,
    readonly index: number,
  ) {}

  get config(): HybridConfig {
    return this.session.ctx.config;
  }

  async recordContext(projected: ProjectedInput, system: string): Promise<void> {
    const { ctx, identity } = this.session;
    // The static system body is persisted once per distinct hash; each step's
    // context record references it so the sent request stays reconstructible.
    const systemHash = await persistSystemPrompt(ctx, system);
    await pushContext(ctx, {
      runId: ctx.runId,
      trialId: identity.trialId,
      taskId: identity.taskId,
      mode: identity.mode,
      step: this.index,
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
      systemHash,
      ...(ctx.config.recordContextText ? { text: projected.userText } : {}),
    });
  }

  recordUpdate(kind: UpdateRecord["kind"], data: Record<string, unknown>): Promise<void> {
    const { ctx, identity } = this.session;
    return pushUpdate(ctx, {
      runId: ctx.runId,
      trialId: identity.trialId,
      taskId: identity.taskId,
      mode: identity.mode,
      step: this.index,
      kind,
      ...data,
    });
  }

  act(request: ActorRequest): Promise<ActorResponse> {
    return this.instrumented("actor", request, () =>
      actorProvider(this.session.providers).act(request, callOptions(this.config)),
    );
  }

  async updateMemory(input: Parameters<typeof updateMemory>[0]): Promise<UpdateResult> {
    const { providers } = this.session;
    const { config } = this;
    const jev = providers.jev && this.instrumentedJev(providers.jev);
    const repair = providers.repair && this.instrumentedRepair(providers.repair);
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

  async instrumented<T extends Instrumentable>(
    kind: CallRecord["kind"],
    request: unknown,
    call: () => Promise<T>,
  ): Promise<T> {
    const { ctx } = this.session;
    const header = this.openHeader(kind, request);
    await this.admit(header);
    const started = performance.now();
    // A start record precedes the invocation so a crash before the end record is
    // distinguishable from "no request was made".
    await pushCallStart(ctx, { record: "call_start", ...header });
    try {
      const response = await call();
      await pushCall(ctx, this.completedCall(header, started, response));
      return response;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      await pushCall(ctx, failedCall(header, started, error));
      throw error;
    }
  }

  private instrumentedJev(provider: JevProvider): JevProvider {
    return {
      name: provider.name,
      choose: (request, options) =>
        this.instrumented("jev", request, () =>
          provider.choose(request, options ?? callOptions(this.config)),
        ),
    };
  }

  private instrumentedRepair(provider: RepairProvider): RepairProvider {
    return {
      name: provider.name,
      repair: (request, options) =>
        this.instrumented("repair", request, () =>
          provider.repair(request, options ?? callOptions(this.config)),
        ),
    };
  }

  private openHeader(kind: CallRecord["kind"], request: unknown): Omit<CallStartRecord, "record"> {
    const { ctx, identity } = this.session;
    const requestBytes = Buffer.byteLength(JSON.stringify(sentRequestBody(kind, request)));
    const hash = requestHash(kind, request);
    return {
      callId: `${kind}-${identity.trialId}-${this.index}-${ctx.callSeq++}`,
      runId: ctx.runId,
      trialId: identity.trialId,
      taskId: identity.taskId,
      mode: identity.mode,
      step: this.index,
      kind,
      model: modelFor(kind, this.config),
      startedAt: new Date().toISOString(),
      requestBytes,
      requestHash: hash,
    };
  }

  private async admit(header: Omit<CallStartRecord, "record">): Promise<void> {
    const { ctx } = this.session;
    if (ctx.budget.sent >= ctx.budget.limit) await rejectUnsent(ctx, header, "not_sent");
    const sentForTrial = ctx.trialSent.get(header.trialId) ?? 0;
    if (sentForTrial >= this.config.provider.trialMaxRequests)
      await rejectUnsent(ctx, header, "not_sent_trial_budget");
    ctx.budget.sent++;
    ctx.trialSent.set(header.trialId, sentForTrial + 1);
  }

  private completedCall(
    header: Omit<CallStartRecord, "record">,
    started: number,
    response: Instrumentable,
  ): CallRecord {
    const { requestBytes, requestHash: hash, startedAt, ...base } = header;
    return {
      ...base,
      providerInvoked: true,
      requestBytes,
      requestHash: hash,
      startedAt,
      latencyMs: response.latencyMs ?? performance.now() - started,
      ...(response.usage ? { usage: response.usage } : {}),
      ...(response.error ? { error: response.error } : {}),
      ...(response.responseModel ? { responseModel: response.responseModel } : {}),
      ...(this.config.recordResponseText && typeof response.rawText === "string"
        ? { responseText: response.rawText }
        : {}),
      attempts: 1,
    };
  }
}

export function callOptions(config: HybridConfig): CallOptions {
  return { signal: AbortSignal.timeout(config.provider.timeoutMs) };
}

export function fakeProviders(tasks: readonly HybridTask[]): ProviderSet {
  return {
    jev: new FakeJevProvider(),
    repair: new FakeRepairProvider(),
    actor: new FakeActorProvider(tasks),
    update: new FakeUpdateProvider(),
  };
}

function actorProvider(providers: ProviderSet): ActorProvider {
  if (!providers.actor) throw new Error("actor provider is required for closed_loop");
  return providers.actor;
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

async function rejectUnsent(
  ctx: ConfiguredRunContext,
  header: Omit<CallStartRecord, "record">,
  error: string,
): Promise<never> {
  const { requestBytes, requestHash: hash, startedAt, ...base } = header;
  await pushCall(ctx, {
    ...base,
    providerInvoked: false,
    requestBytes,
    requestHash: hash,
    startedAt,
    latencyMs: null,
    error,
    attempts: 0,
  });
  throw new BudgetExhausted();
}

function failedCall(
  header: Omit<CallStartRecord, "record">,
  started: number,
  error: unknown,
): CallRecord {
  const { requestBytes, requestHash: hash, startedAt, ...base } = header;
  return {
    ...base,
    providerInvoked: true,
    requestBytes,
    requestHash: hash,
    startedAt,
    latencyMs: performance.now() - started,
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
