import type {
  CallOptions,
  ActorProvider,
  JevProvider,
  RepairProvider,
  UpdateProvider,
} from "./providers_types.js";
import type {
  ActorAction,
  ActorRequest,
  ActorResponse,
  GenerativeUpdateRequest,
  GenerativeUpdateResponse,
  HybridTask,
  JevRequest,
  JevResponse,
  PatchOperation,
  RepairRequest,
  RepairResponse,
  TaskStep,
} from "./types.js";
import { emptyUsage } from "./types.js";

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
    let operations: PatchOperation[];
    try {
      operations = fakeUpdateOperations(request.latest);
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
    const key = stepKey(request, task);
    const index = this.indexes.get(key) ?? 0;
    const step = task.steps?.[index];
    if (!step)
      return Promise.resolve({ action: { tool: "finish" }, usage: emptyUsage(), latencyMs: 0 });
    this.indexes.set(key, index + 1);
    return Promise.resolve(scriptedActorResponse(request, step));
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
    const step = this.advance(request, task);
    return Promise.resolve({
      action: step?.action ?? { tool: "finish" },
      ...(request.mode === "llm" ? { statePatch: step?.statePatch ?? [] } : {}),
    });
  }

  private advance(request: ActorRequest, task: HybridTask): TaskStep | undefined {
    const key = stepKey(request, task);
    const index = this.indexes.get(key) ?? 0;
    this.indexes.set(key, index + 1);
    return task.steps?.[index];
  }
}

function stepKey(request: ActorRequest, task: HybridTask): string {
  return `${request.trialId ?? request.mode}:${task.id}`;
}

function scriptedActorResponse(request: ActorRequest, step: TaskStep): ActorResponse {
  const statePatch = request.mode === "llm" ? (step.statePatch ?? fakePatch(request)) : undefined;
  return {
    action: step.action,
    ...(step.observation === undefined ? {} : { text: step.observation }),
    ...(statePatch ? { statePatch } : {}),
    usage: emptyUsage(),
    latencyMs: 0,
  };
}

function fakeUpdateOperations(latest: string): PatchOperation[] {
  const parsed: unknown = JSON.parse(latest);
  const items = (parsed as Record<string, unknown>).items;
  return Array.isArray(items) ? items.flatMap(fakeUpdateOperation) : [];
}

function fakeUpdateOperation(item: unknown): PatchOperation[] {
  const value = item as Record<string, unknown>;
  if (
    typeof value.text !== "string" ||
    typeof value.sourceId !== "string" ||
    typeof value.role !== "string"
  )
    return [];
  return [
    {
      operation: "add",
      kind: kindForRole(value.role),
      text: value.text,
      sourceIds: [value.sourceId],
      trust: trustForRole(value.role),
      origin: "extracted",
    },
  ];
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
        // The fallback patch replays the latest observation as-is; a generated
        // origin keeps it valid even when the message never produced a
        // citable candidate (an extracted origin would demand exact-text
        // provenance the fake cannot prove).
        origin: "generated",
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
