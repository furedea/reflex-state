import { readFile } from "node:fs/promises";

import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../../core/config.js";
import { createTypeSafeClient } from "../../typesafe/client.js";
import { actorSystemPrompt, repairSystemPrompt } from "./prompts.js";
import type {
  ActorAction,
  ActorRequest,
  ActorResponse,
  HybridTask,
  JevRequest,
  JevResponse,
  PatchOperation,
  RepairRequest,
  RepairResponse,
} from "./types.js";
import { emptyUsage } from "./types.js";

export interface JevProvider {
  readonly name: string;
  choose(request: JevRequest): Promise<JevResponse>;
}

export interface RepairProvider {
  readonly name: string;
  repair(request: RepairRequest): Promise<RepairResponse>;
}

export interface ActorProvider {
  readonly name: string;
  act(request: ActorRequest): Promise<ActorResponse>;
}

export interface ProviderSet {
  readonly jev: JevProvider;
  readonly repair: RepairProvider;
  readonly actor: ActorProvider;
}

export class FakeJevProvider implements JevProvider {
  readonly name = "fake-jev";

  choose(request: JevRequest): Promise<JevResponse> {
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

  repair(request: RepairRequest): Promise<RepairResponse> {
    const first = request.observations.find((candidate) => candidate.contextComplete);
    return Promise.resolve({
      operations: first
        ? [
            {
              operation: "add",
              kind: first.category,
              text: first.text,
              sourceIds: first.sourceIds,
              trust: first.trust,
              origin: "extracted",
            },
          ]
        : [],
      usage: emptyUsage(),
      latencyMs: 0,
    });
  }
}

export class FakeActorProvider implements ActorProvider {
  readonly name = "fake-actor";
  private readonly indexes = new Map<string, number>();

  constructor(private readonly tasks: readonly HybridTask[]) {}

  act(request: ActorRequest): Promise<ActorResponse> {
    const task = this.tasks.find((candidate) => candidate.id === request.taskId);
    if (!task)
      return Promise.resolve({ error: "task_not_found", usage: emptyUsage(), latencyMs: 0 });
    const index = this.indexes.get(`${request.mode}:${task.id}`) ?? 0;
    const step = task.steps[index];
    if (!step)
      return Promise.resolve({ action: { tool: "finish" }, usage: emptyUsage(), latencyMs: 0 });
    this.indexes.set(`${request.mode}:${task.id}`, index + 1);
    const statePatch = step.statePatch ?? fakePatch(request);
    return Promise.resolve({
      action: step.action,
      ...(step.observation === undefined ? {} : { text: step.observation }),
      statePatch,
      usage: emptyUsage(),
      latencyMs: 0,
    });
  }
}

function fakePatch(request: ActorRequest): PatchOperation[] {
  try {
    const parsed: unknown = JSON.parse(request.input.latest);
    if (!parsed || typeof parsed !== "object") return [];
    const items = (parsed as Record<string, unknown>).items;
    if (!Array.isArray(items)) return [];
    const latest = items.at(-1);
    if (!latest || typeof latest !== "object") return [];
    const value = latest as Record<string, unknown>;
    if (typeof value.text !== "string" || typeof value.sourceId !== "string") return [];
    const role = value.role;
    const kind: PatchOperation["kind"] =
      role === "user" ? "constraints" : role === "tool_result" ? "findings" : "attempts";
    const trust: PatchOperation["trust"] =
      role === "user" ? "user" : role === "tool_result" ? "tool_result" : "unknown";
    return [
      {
        operation: "add",
        kind,
        text: value.text,
        sourceIds: [value.sourceId],
        trust,
        origin: "extracted",
      },
    ];
  } catch {
    return [];
  }
}

export class RecordedJevProvider implements JevProvider {
  readonly name = "recorded-jev";
  constructor(private readonly responses: readonly JevResponse[]) {}
  private index = 0;
  choose(): Promise<JevResponse> {
    return Promise.resolve(
      this.responses[this.index++] ?? { answers: [], error: "recorded_response_missing" },
    );
  }
}

export class RecordedRepairProvider implements RepairProvider {
  readonly name = "recorded-repair";
  constructor(private readonly responses: readonly RepairResponse[]) {}
  private index = 0;
  repair(): Promise<RepairResponse> {
    return Promise.resolve(
      this.responses[this.index++] ?? { operations: [], error: "recorded_response_missing" },
    );
  }
}

export class RecordedActorProvider implements ActorProvider {
  readonly name = "recorded-actor";
  constructor(private readonly responses: readonly ActorResponse[]) {}
  private index = 0;
  act(): Promise<ActorResponse> {
    return Promise.resolve(this.responses[this.index++] ?? { error: "recorded_response_missing" });
  }
}

export async function readRecordedProviders(path: string): Promise<ProviderSet> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid recorded provider file");
  const record = value as Record<string, unknown>;
  const array = (key: string): unknown[] => (Array.isArray(record[key]) ? record[key] : []);
  return {
    jev: new RecordedJevProvider(array("jev") as JevResponse[]),
    repair: new RecordedRepairProvider(array("repair") as RepairResponse[]),
    actor: new RecordedActorProvider(array("actor") as ActorResponse[]),
  };
}

export class LiveJevProvider implements JevProvider {
  readonly name = "typesafe-live-jev";
  private readonly client = createTypeSafeClient({
    ...defaultConfig(),
    jev: { ...defaultConfig().jev, enabled: true },
  });

  constructor(private readonly model: string) {}

  async choose(request: JevRequest): Promise<JevResponse> {
    const started = performance.now();
    try {
      const response = await this.client.systemOne(
        {
          state: request.state,
          model: this.model,
          questions: Object.fromEntries(
            request.questions.map((question) => [
              question.id,
              { type: "choice", instructions: question.prompt, criteria: question.options },
            ]),
          ),
        },
        { signal: new AbortController().signal },
      );
      return {
        answers: decodeAnswers(response, request.questions),
        latencyMs: performance.now() - started,
        usage: emptyUsage(),
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

export class LiveRepairProvider implements RepairProvider {
  readonly name = "pi-live-repair";
  constructor(private readonly model: string) {}

  async repair(request: RepairRequest): Promise<RepairResponse> {
    const started = performance.now();
    try {
      const text = await askPi(
        request.model || this.model,
        repairSystemPrompt(),
        JSON.stringify(request),
      );
      return {
        operations: decodeOperations(text),
        latencyMs: performance.now() - started,
        usage: emptyUsage(),
      };
    } catch (error) {
      return {
        operations: [],
        latencyMs: performance.now() - started,
        error: errorMessage(error),
        usage: emptyUsage(),
      };
    }
  }
}

export class LiveActorProvider implements ActorProvider {
  readonly name = "pi-live-actor";
  constructor(private readonly model: string) {}

  async act(request: ActorRequest): Promise<ActorResponse> {
    const started = performance.now();
    try {
      const text = await askPi(
        request.model || this.model,
        actorSystemPrompt(request.mode),
        JSON.stringify(request),
      );
      const value = parseJsonObject(text);
      const action = decodeAction(value.action);
      return {
        ...(action ? { action } : {}),
        statePatch: decodeOperations(value.statePatch),
        text,
        latencyMs: performance.now() - started,
        usage: emptyUsage(),
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
  readonly jevModel: string;
  readonly actorModel: string;
  readonly repairModel?: string;
}): Promise<ProviderSet> {
  return {
    jev: new LiveJevProvider(options.jevModel),
    actor: new LiveActorProvider(options.actorModel),
    repair: new LiveRepairProvider(options.repairModel ?? options.actorModel),
  };
}

async function askPi(modelId: string, system: string, input: string): Promise<string> {
  const runtime = await ModelRuntime.create();
  const [provider, ...idParts] = modelId.split("/");
  const model =
    provider && idParts.length ? runtime.getModel(provider, idParts.join("/")) : undefined;
  if (!model) throw new Error(`Pi model unavailable: ${modelId}`);
  const cwd = process.cwd();
  const { session } = await createAgentSession({
    cwd,
    model,
    noTools: "all",
    sessionManager: SessionManager.inMemory(cwd),
  });
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      text += event.assistantMessageEvent.delta;
  });
  try {
    await session.prompt(`${system}\n\n${input}`, { source: "extension" });
    return text;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

function decodeAnswers(
  value: unknown,
  questions: readonly { readonly id: string }[],
): JevResponse["answers"] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return questions.flatMap((question) => {
    const raw = record[question.id];
    if (typeof raw === "string") return [{ questionId: question.id, choice: raw }];
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as Record<string, unknown>).choice === "string"
    )
      return [
        { questionId: question.id, choice: (raw as Record<string, unknown>).choice as string },
      ];
    return [];
  });
}

function decodeOperations(value: unknown): PatchOperation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (
      (record.operation !== "add" && record.operation !== "replace") ||
      typeof record.kind !== "string" ||
      typeof record.text !== "string" ||
      !Array.isArray(record.sourceIds)
    )
      return [];
    return [
      {
        operation: record.operation,
        ...(typeof record.itemId === "string" ? { itemId: record.itemId } : {}),
        kind: record.kind as PatchOperation["kind"],
        text: record.text,
        sourceIds: record.sourceIds.filter((id): id is string => typeof id === "string"),
        trust:
          record.trust === "user" || record.trust === "assistant" || record.trust === "tool_result"
            ? record.trust
            : "unknown",
        origin: record.origin === "generated" ? "generated" : "extracted",
        ...(typeof record.replaces === "string" ? { replaces: record.replaces } : {}),
      },
    ];
  });
}

function decodeAction(value: unknown): ActorAction | undefined {
  if (!value || typeof value !== "object") return undefined;
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
  return {
    tool,
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.replacement === "string" ? { replacement: record.replacement } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("actor_invalid_json");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("actor_invalid_object");
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "provider_error";
}
