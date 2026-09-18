import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../../core/config.js";
import { createTypeSafeClient } from "../../typesafe/client.js";
import type { TypeSafeSystemOneClient } from "../../typesafe/client.js";
import { repairSystemPrompt, updateSystemPrompt } from "./prompts.js";
import type {
  ActorAction,
  ActorRequest,
  ActorResponse,
  GenerativeUpdateRequest,
  GenerativeUpdateResponse,
  HybridTask,
  JevAnswer,
  JevQuestion,
  JevRequest,
  JevResponse,
  MemoryKind,
  PatchOperation,
  RepairRequest,
  RepairResponse,
  Usage,
} from "./types.js";
import { emptyUsage } from "./types.js";

export interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface JevProvider {
  readonly name: string;
  choose(request: JevRequest, options?: CallOptions): Promise<JevResponse>;
}

export interface RepairProvider {
  readonly name: string;
  repair(request: RepairRequest, options?: CallOptions): Promise<RepairResponse>;
}

export interface ActorProvider {
  readonly name: string;
  act(request: ActorRequest, options?: CallOptions): Promise<ActorResponse>;
}

export interface UpdateProvider {
  readonly name: string;
  update(
    request: GenerativeUpdateRequest,
    options?: CallOptions,
  ): Promise<GenerativeUpdateResponse>;
}

export interface ProviderSet {
  readonly jev?: JevProvider;
  readonly repair?: RepairProvider;
  readonly actor?: ActorProvider;
  readonly update?: UpdateProvider;
}

/**
 * The exact body handed to the transport for a call. Request bytes and the
 * recorded-response hash are both derived from this single serialization so
 * they can never disagree about what was sent.
 */
export function sentRequestBody(kind: string, request: unknown): unknown {
  if (kind === "actor") {
    const actor = request as ActorRequest;
    return { system: actor.system, messages: [{ role: "user", content: actor.user }] };
  }
  return request;
}

export function requestHash(kind: string, request: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sentRequestBody(kind, request)))
    .digest("hex");
}

const MEMORY_KINDS = new Set<MemoryKind>([
  "constraints",
  "decisions",
  "findings",
  "attempts",
  "open_questions",
]);

export class FakeJevProvider implements JevProvider {
  readonly name = "fake-jev";
  public lastSignal: AbortSignal | undefined;

  choose(request: JevRequest, options?: CallOptions): Promise<JevResponse> {
    this.lastSignal = options?.signal;
    return Promise.resolve({
      answers: request.questions.map((question) => ({
        questionId: question.id,
        choice: Object.keys(question.options).find((key) => key.startsWith("keep-")) ?? "unknown",
        probability: 0.9,
        confidence: 0.9,
      })),
      usage: emptyUsage(),
      latencyMs: 0,
    });
  }
}

export class FakeRepairProvider implements RepairProvider {
  readonly name = "fake-repair";
  public lastSignal: AbortSignal | undefined;

  repair(request: RepairRequest, options?: CallOptions): Promise<RepairResponse> {
    this.lastSignal = options?.signal;
    const first = request.observations.find((candidate) => candidate.contextComplete);
    return Promise.resolve({
      operations: first
        ? [
            {
              operation: "add" as const,
              kind: first.category,
              text: first.text,
              sourceIds: first.sourceIds,
              trust: first.trust,
              origin: "extracted" as const,
            },
          ]
        : [],
      usage: emptyUsage(),
      latencyMs: 0,
    });
  }
}

export class FakeUpdateProvider implements UpdateProvider {
  readonly name = "fake-update";
  public lastSignal: AbortSignal | undefined;

  update(
    request: GenerativeUpdateRequest,
    options?: CallOptions,
  ): Promise<GenerativeUpdateResponse> {
    this.lastSignal = options?.signal;
    const operations: PatchOperation[] = [];
    try {
      const parsed: unknown = JSON.parse(request.latest);
      const items = (parsed as Record<string, unknown>).items;
      if (Array.isArray(items))
        for (const item of items) {
          const value = item as Record<string, unknown>;
          if (
            typeof value.text === "string" &&
            typeof value.sourceId === "string" &&
            typeof value.role === "string"
          )
            operations.push({
              operation: "add",
              kind: kindForRole(value.role),
              text: value.text,
              sourceIds: [value.sourceId],
              trust: trustForRole(value.role),
              origin: "extracted",
            });
        }
    } catch {
      return Promise.resolve({ error: "fake_update_input_unreadable", usage: emptyUsage() });
    }
    return Promise.resolve({ operations, usage: emptyUsage(), latencyMs: 0 });
  }
}

export class FakeActorProvider implements ActorProvider {
  readonly name = "fake-actor";
  private readonly indexes = new Map<string, number>();
  public lastSignal: AbortSignal | undefined;

  constructor(private readonly tasks: readonly HybridTask[]) {}

  act(request: ActorRequest, options?: CallOptions): Promise<ActorResponse> {
    this.lastSignal = options?.signal;
    const task = this.tasks.find((candidate) => candidate.id === request.taskId);
    if (!task)
      return Promise.resolve({ error: "task_not_found", usage: emptyUsage(), latencyMs: 0 });
    const key = `${request.trialId ?? request.mode}:${task.id}`;
    const index = this.indexes.get(key) ?? 0;
    const step = task.steps?.[index];
    if (!step)
      return Promise.resolve({ action: { tool: "finish" }, usage: emptyUsage(), latencyMs: 0 });
    this.indexes.set(key, index + 1);
    const statePatch = request.mode === "llm" ? (step.statePatch ?? fakePatch(request)) : undefined;
    return Promise.resolve({
      action: step.action,
      ...(step.observation === undefined ? {} : { text: step.observation }),
      ...(statePatch ? { statePatch } : {}),
      usage: emptyUsage(),
      latencyMs: 0,
    });
  }
}

export class InputDependentActorProvider implements ActorProvider {
  readonly name = "input-dependent-actor";
  private readonly indexes = new Map<string, number>();

  constructor(
    private readonly tasks: readonly HybridTask[],
    private readonly requiredPhrases: readonly string[],
    private readonly fallbackAction: ActorAction = { tool: "finish" },
  ) {}

  act(request: ActorRequest): Promise<ActorResponse> {
    const task = this.tasks.find((candidate) => candidate.id === request.taskId);
    if (!task) return Promise.resolve({ error: "task_not_found" });
    const missing = this.requiredPhrases.filter((phrase) => !request.user.includes(phrase));
    if (missing.length)
      return Promise.resolve({
        action: this.fallbackAction,
        text: `missing:${missing.join(",")}`,
        statePatch: [],
      });
    const key = `${request.trialId ?? request.mode}:${task.id}`;
    const index = this.indexes.get(key) ?? 0;
    const step = task.steps?.[index];
    this.indexes.set(key, index + 1);
    return Promise.resolve({
      action: step?.action ?? { tool: "finish" },
      ...(request.mode === "llm" ? { statePatch: step?.statePatch ?? [] } : {}),
    });
  }
}

function fakePatch(request: ActorRequest): PatchOperation[] {
  try {
    const parsed: unknown = JSON.parse(request.user);
    const latest = (parsed as Record<string, unknown>).latest_observation;
    const items = (latest as Record<string, unknown> | undefined)?.items;
    if (!Array.isArray(items) || !items.length) return [];
    const last = items.at(-1) as Record<string, unknown>;
    if (typeof last.text !== "string" || typeof last.sourceId !== "string") return [];
    const role = typeof last.role === "string" ? last.role : "tool_result";
    return [
      {
        operation: "add",
        kind: kindForRole(role),
        text: last.text,
        sourceIds: [last.sourceId],
        trust: trustForRole(role),
        origin: "extracted",
      },
    ];
  } catch {
    return [];
  }
}

function kindForRole(role: string): PatchOperation["kind"] {
  if (role === "user") return "constraints";
  if (role === "tool_result") return "findings";
  if (role === "tool_call") return "attempts";
  return "decisions";
}

function trustForRole(role: string): PatchOperation["trust"] {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "tool_result") return "tool_result";
  return "unknown";
}

interface RecordedCall {
  readonly kind: "actor" | "jev" | "repair" | "update";
  readonly trialId: string;
  readonly step: number;
  readonly requestHash: string;
  readonly response: unknown;
}

export class RecordedJevProvider implements JevProvider {
  readonly name = "recorded-jev";
  constructor(private readonly calls: ReadonlyMap<string, RecordedCall>) {}
  choose(request: JevRequest, options?: CallOptions & { trialId?: string; step?: number }) {
    const key = recordedKey("jev", options?.trialId ?? "", options?.step ?? -1, request);
    const call = this.calls.get(key);
    if (!call) return Promise.resolve({ answers: [], error: "recorded_response_missing" });
    return Promise.resolve(call.response as JevResponse);
  }
}

export class RecordedRepairProvider implements RepairProvider {
  readonly name = "recorded-repair";
  constructor(private readonly calls: ReadonlyMap<string, RecordedCall>) {}
  repair(request: RepairRequest, options?: CallOptions & { trialId?: string; step?: number }) {
    const key = recordedKey("repair", options?.trialId ?? "", options?.step ?? -1, request);
    const call = this.calls.get(key);
    if (!call) return Promise.resolve({ error: "recorded_response_missing" });
    return Promise.resolve(call.response as RepairResponse);
  }
}

export class RecordedActorProvider implements ActorProvider {
  readonly name = "recorded-actor";
  constructor(private readonly calls: ReadonlyMap<string, RecordedCall>) {}
  act(request: ActorRequest) {
    const key = recordedKey("actor", request.trialId ?? "", request.step ?? -1, request);
    const call = this.calls.get(key);
    if (!call) return Promise.resolve({ error: "recorded_response_missing" });
    return Promise.resolve(call.response as ActorResponse);
  }
}

export class RecordedUpdateProvider implements UpdateProvider {
  readonly name = "recorded-update";
  constructor(private readonly calls: ReadonlyMap<string, RecordedCall>) {}
  update(
    request: GenerativeUpdateRequest,
    options?: CallOptions & { trialId?: string; step?: number },
  ) {
    const key = recordedKey("update", options?.trialId ?? "", options?.step ?? -1, request);
    const call = this.calls.get(key);
    if (!call) return Promise.resolve({ error: "recorded_response_missing" });
    return Promise.resolve(call.response as GenerativeUpdateResponse);
  }
}

function recordedKey(kind: string, trialId: string, step: number, request: unknown): string {
  return `${kind}|${trialId}|${step}|${requestHash(kind, request)}`;
}

export async function readRecordedProviders(path: string): Promise<ProviderSet> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid recorded provider file");
  const record = value as Record<string, unknown>;
  const calls = new Map<string, RecordedCall>();
  const entries = Array.isArray(record.calls) ? record.calls : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid recorded call entry");
    const call = entry as Record<string, unknown>;
    if (
      (call.kind !== "actor" &&
        call.kind !== "jev" &&
        call.kind !== "repair" &&
        call.kind !== "update") ||
      typeof call.trialId !== "string" ||
      !Number.isInteger(call.step) ||
      typeof call.requestHash !== "string" ||
      call.response === undefined
    )
      throw new Error("Invalid recorded call shape");
    calls.set(
      `${call.kind as string}|${call.trialId}|${call.step as number}|${call.requestHash}`,
      call as unknown as RecordedCall,
    );
  }
  return {
    jev: new RecordedJevProvider(calls),
    repair: new RecordedRepairProvider(calls),
    actor: new RecordedActorProvider(calls),
    update: new RecordedUpdateProvider(calls),
  };
}

export interface CompletionClient {
  complete(
    request: { readonly system: string; readonly user: string; readonly model: string },
    options: { readonly signal: AbortSignal },
  ): Promise<{
    readonly text: string;
    readonly usage?: Usage;
    readonly stopReason?: string;
    readonly model?: string;
  }>;
}

export class PiCompletionClient implements CompletionClient {
  private runtime: ModelRuntime | undefined;

  constructor(private readonly options: { readonly allowModelNetwork?: boolean } = {}) {}

  private async model(modelId: string) {
    this.runtime ??= await ModelRuntime.create({
      allowModelNetwork: this.options.allowModelNetwork === true,
    });
    const [provider, ...parts] = modelId.split("/");
    const model =
      provider && parts.length ? this.runtime.getModel(provider, parts.join("/")) : undefined;
    if (!model) throw new Error(`Pi model unavailable: ${modelId}`);
    return model;
  }

  async complete(
    request: { readonly system: string; readonly user: string; readonly model: string },
    options: { readonly signal: AbortSignal },
  ) {
    const model = await this.model(request.model);
    const message = await this.runtime!.complete(
      model,
      {
        systemPrompt: request.system,
        messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
      },
      { signal: options.signal },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted")
      throw new Error(`pi_completion_${message.stopReason}:${message.errorMessage ?? ""}`);
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return {
      text,
      usage: {
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cacheReadTokens: message.usage.cacheRead,
        cacheWriteTokens: message.usage.cacheWrite,
      },
      stopReason: message.stopReason,
      model: message.responseModel ?? message.model,
    };
  }
}

export class LiveJevProvider implements JevProvider {
  readonly name = "typesafe-live-jev";
  private readonly client: TypeSafeSystemOneClient;

  constructor(
    private readonly model: string,
    client?: TypeSafeSystemOneClient,
  ) {
    this.client =
      client ??
      createTypeSafeClient({
        ...defaultConfig(),
        jev: { ...defaultConfig().jev, enabled: true, model },
      });
  }

  async choose(request: JevRequest, options?: CallOptions): Promise<JevResponse> {
    const started = performance.now();
    try {
      const response = await this.client.systemOne(
        {
          state: request.state,
          model: request.model || this.model,
          questions: Object.fromEntries(
            request.questions.map((question) => [
              question.id,
              {
                type: "choice" as const,
                instructions: question.prompt,
                criteria: question.options,
              },
            ]),
          ),
        },
        { signal: options?.signal ?? new AbortController().signal },
      );
      const usage = jevUsage(response);
      return {
        answers: decodeAnswers(response, request.questions),
        latencyMs: performance.now() - started,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      return {
        answers: [],
        latencyMs: performance.now() - started,
        error: errorMessage(error),
        usage: emptyUsage(),
      };
    }
  }
}

export class LiveActorProvider implements ActorProvider {
  readonly name = "pi-live-actor";
  constructor(
    private readonly model: string,
    private readonly client: CompletionClient = new PiCompletionClient(),
  ) {}

  async act(request: ActorRequest, options?: CallOptions): Promise<ActorResponse> {
    const started = performance.now();
    try {
      const response = await this.client.complete(
        { system: request.system, user: request.user, model: request.model || this.model },
        { signal: options?.signal ?? new AbortController().signal },
      );
      const decoded = decodeActorResponse(response.text, request.mode);
      return {
        action: decoded.action,
        ...(decoded.statePatch ? { statePatch: decoded.statePatch } : {}),
        ...(decoded.text ? { text: decoded.text } : {}),
        latencyMs: performance.now() - started,
        ...(response.usage ? { usage: response.usage } : {}),
      };
    } catch (error) {
      return {
        latencyMs: performance.now() - started,
        error: errorMessage(error),
        usage: emptyUsage(),
      };
    }
  }
}

export class LiveRepairProvider implements RepairProvider {
  readonly name = "pi-live-repair";
  constructor(
    private readonly model: string,
    private readonly client: CompletionClient = new PiCompletionClient(),
  ) {}

  async repair(request: RepairRequest, options?: CallOptions): Promise<RepairResponse> {
    const started = performance.now();
    try {
      const response = await this.client.complete(
        {
          system: repairSystemPrompt(),
          user: JSON.stringify(request),
          model: request.model || this.model,
        },
        { signal: options?.signal ?? new AbortController().signal },
      );
      return {
        operations: decodeOperationsEnvelope(response.text),
        latencyMs: performance.now() - started,
        ...(response.usage ? { usage: response.usage } : {}),
      };
    } catch (error) {
      return {
        latencyMs: performance.now() - started,
        error: errorMessage(error),
        usage: emptyUsage(),
      };
    }
  }
}

export class LiveUpdateProvider implements UpdateProvider {
  readonly name = "pi-live-update";
  constructor(
    private readonly model: string,
    private readonly client: CompletionClient = new PiCompletionClient(),
  ) {}

  async update(
    request: GenerativeUpdateRequest,
    options?: CallOptions,
  ): Promise<GenerativeUpdateResponse> {
    const started = performance.now();
    try {
      const response = await this.client.complete(
        {
          system: updateSystemPrompt(),
          user: JSON.stringify(request),
          model: request.model || this.model,
        },
        { signal: options?.signal ?? new AbortController().signal },
      );
      return {
        operations: decodeOperationsEnvelope(response.text),
        latencyMs: performance.now() - started,
        ...(response.usage ? { usage: response.usage } : {}),
      };
    } catch (error) {
      return {
        latencyMs: performance.now() - started,
        error: errorMessage(error),
        usage: emptyUsage(),
      };
    }
  }
}

export async function createLiveProviders(options: {
  readonly actorModel?: string;
  readonly jevModel?: string;
  readonly repairModel?: string;
  readonly updateModel?: string;
  readonly needs: {
    readonly actor: boolean;
    readonly jev: boolean;
    readonly repair: boolean;
    readonly update: boolean;
  };
}): Promise<ProviderSet> {
  const client = new PiCompletionClient();
  return {
    ...(options.needs.actor && options.actorModel
      ? { actor: new LiveActorProvider(options.actorModel, client) }
      : {}),
    ...(options.needs.jev && options.jevModel
      ? { jev: new LiveJevProvider(options.jevModel) }
      : {}),
    ...(options.needs.repair && options.repairModel
      ? { repair: new LiveRepairProvider(options.repairModel, client) }
      : {}),
    ...(options.needs.update && (options.updateModel ?? options.actorModel)
      ? { update: new LiveUpdateProvider((options.updateModel ?? options.actorModel)!, client) }
      : {}),
  };
}

export function decodeAnswers(response: unknown, questions: readonly JevQuestion[]): JevAnswer[] {
  const root = record(response);
  const answers = record(root.answers);
  return questions.map((question) => {
    const raw = answers[question.id];
    if (raw === undefined)
      return { questionId: question.id, choice: "", invalid: "missing_answer" };
    try {
      const answer = record(raw);
      const choice = answer.choice;
      const confidence = answer.confidence;
      const probabilities = record(answer.probabilities);
      if (typeof choice !== "string" || !choice) return invalid(question.id, "choice_type");
      if (!isProbability(confidence)) return invalid(question.id, "confidence_type");
      for (const label of Object.keys(question.options)) {
        if (!isProbability(probabilities[label])) return invalid(question.id, "probabilities_type");
      }
      const probability = probabilities[choice];
      return {
        questionId: question.id,
        choice,
        ...(typeof probability === "number" ? { probability } : {}),
        confidence,
      };
    } catch {
      return invalid(question.id, "answer_shape");
    }
  });
}

function invalid(questionId: string, reason: string): JevAnswer {
  return { questionId, choice: "", invalid: reason };
}

export function decodeActorResponse(
  text: string,
  mode: ActorRequest["mode"],
): {
  readonly action: ActorAction;
  readonly statePatch?: readonly PatchOperation[];
  readonly text?: string;
} {
  const value = parseJsonObject(text);
  const action = decodeAction(value.action);
  if (!action) throw new Error("actor_action_invalid");
  const visible = typeof value.text === "string" && value.text.trim() ? value.text : undefined;
  if (mode === "llm") {
    if (!("statePatch" in value)) throw new Error("actor_state_patch_missing");
    const operations = decodeOperationsArray(value.statePatch);
    return { action, statePatch: operations, ...(visible ? { text: visible } : {}) };
  }
  return { action, ...(visible ? { text: visible } : {}) };
}

export function decodeOperationsEnvelope(text: string): PatchOperation[] {
  const value = parseJsonObject(text);
  if (!("operations" in value)) throw new Error("operations_missing");
  return decodeOperationsArray(value.operations);
}

export function decodeOperationsArray(value: unknown): PatchOperation[] {
  if (!Array.isArray(value)) throw new Error("operations_not_array");
  return value.map((item, index) => {
    const record = recordField(item, `operations[${index}]`);
    const operation = record.operation;
    if (operation !== "add" && operation !== "replace")
      throw new Error(`operations[${index}].operation_invalid`);
    const kind = record.kind;
    if (typeof kind !== "string" || !MEMORY_KINDS.has(kind as MemoryKind))
      throw new Error(`operations[${index}].kind_invalid`);
    if (typeof record.text !== "string" || !record.text.trim())
      throw new Error(`operations[${index}].text_invalid`);
    if (
      !Array.isArray(record.sourceIds) ||
      !record.sourceIds.length ||
      !record.sourceIds.every((id) => typeof id === "string" && id.trim())
    )
      throw new Error(`operations[${index}].sourceIds_invalid`);
    const origin = record.origin;
    if (origin !== "extracted" && origin !== "generated")
      throw new Error(`operations[${index}].origin_invalid`);
    if (
      record.trust !== undefined &&
      record.trust !== "user" &&
      record.trust !== "assistant" &&
      record.trust !== "tool_result" &&
      record.trust !== "unknown"
    )
      throw new Error(`operations[${index}].trust_invalid`);
    for (const key of Object.keys(record))
      if (
        ![
          "operation",
          "itemId",
          "kind",
          "text",
          "sourceIds",
          "trust",
          "origin",
          "replaces",
        ].includes(key)
      )
        throw new Error(`operations[${index}].unknown_field:${key}`);
    return {
      operation,
      ...(typeof record.itemId === "string" ? { itemId: record.itemId } : {}),
      kind: kind as MemoryKind,
      text: record.text,
      sourceIds: [...(record.sourceIds as string[])],
      trust: (record.trust as PatchOperation["trust"]) ?? "unknown",
      origin,
      ...(typeof record.replaces === "string" ? { replaces: record.replaces } : {}),
    };
  });
}

function decodeAction(value: unknown): ActorAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tool = record.tool;
  if (
    tool !== "read" &&
    tool !== "write" &&
    tool !== "edit" &&
    tool !== "test" &&
    tool !== "finish"
  )
    return undefined;
  if (tool === "read" && typeof record.path !== "string") return undefined;
  if (tool === "write" && (typeof record.path !== "string" || typeof record.content !== "string"))
    return undefined;
  if (
    tool === "edit" &&
    (typeof record.path !== "string" ||
      typeof record.old !== "string" ||
      typeof record.new !== "string")
  )
    return undefined;
  if (tool === "test" && typeof record.command !== "string") return undefined;
  for (const key of Object.keys(record))
    if (!["tool", "path", "content", "old", "new", "command"].includes(key)) return undefined;
  return {
    tool,
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.old === "string" ? { old: record.old } : {}),
    ...(typeof record.new === "string" ? { new: record.new } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_response_shape");
  return value as Record<string, unknown>;
}

function recordField(value: unknown, name: string): Record<string, unknown> {
  try {
    return record(value);
  } catch {
    throw new Error(`${name}_invalid`);
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("response_invalid_json");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("response_invalid_object");
  return value as Record<string, unknown>;
}

function jevUsage(response: unknown): Usage | undefined {
  try {
    const usage = record(record(response).usage);
    const input = usage.input_tokens;
    const output = usage.output_tokens;
    if (typeof input !== "number" && typeof output !== "number") return undefined;
    return {
      inputTokens: typeof input === "number" ? input : null,
      outputTokens: typeof output === "number" ? output : null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "provider_error";
}
