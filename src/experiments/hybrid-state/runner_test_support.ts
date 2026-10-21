import type { ActorProvider, CompletionClient } from "./providers.js";
import type { RunRecorder } from "./runner.js";
import type {
  ActorRequest,
  ActorResponse,
  CallRecord,
  CallStartRecord,
  ContextRecord,
  HybridConfig,
  HybridTask,
  SystemPromptRecord,
  UpdateRecord,
} from "./types.js";

export const config: HybridConfig = {
  schemaVersion: 2,
  evaluation: "closed_loop",
  provider: {
    mode: "fake",
    jevModel: "fake",
    actorModel: "fake",
    repairModel: "fake",
    maxRequests: 100,
    trialMaxRequests: 32,
    timeoutMs: 1000,
  },
  budgets: {
    memoryBytes: 8192,
    factsBytes: 4096,
    latestObservationBytes: 8192,
    requestBytes: 24000,
    maxQuestions: 8,
    maxRepairCalls: 1,
    maxActions: 8,
  },
  modes: ["history", "llm"],
  seed: 1,
  iterations: 1,
  recordContextText: true,
  recordResponseText: false,
  candidateMaxBytes: 4096,
};

export const task: HybridTask = {
  id: "test-task",
  instruction: "update the file",
  files: { "src/x.ts": "old" },
  allowedTests: ["test-task"],
  expectedFiles: { "src/x.ts": "new" },
  steps: [
    {
      action: { tool: "write", path: "src/x.ts", content: "new" },
      result: "write",
      statePatch: [
        {
          operation: "add",
          kind: "findings",
          text: "self",
          sourceIds: ["self"],
          trust: "assistant",
          origin: "generated",
        },
      ],
    },
    { action: { tool: "test", command: "test-task" }, result: "test" },
    { action: { tool: "finish" }, result: "finish" },
  ],
};

/** Step-indexed actor whose responses can depend on the request it actually
 * received (e.g. on the previous step's update feedback). */
export class ScriptedActor implements ActorProvider {
  readonly name = "scripted-actor";
  private readonly indexes = new Map<string, number>();
  readonly requests: ActorRequest[] = [];

  constructor(private readonly respond: (request: ActorRequest, step: number) => ActorResponse) {}

  act(request: ActorRequest): Promise<ActorResponse> {
    this.requests.push(request);
    const key = request.trialId ?? request.mode;
    const step = this.indexes.get(key) ?? 0;
    this.indexes.set(key, step + 1);
    return Promise.resolve(this.respond(request, step));
  }
}

/** Every step reads a file until the action budget runs out — the actor never
 * finishes on its own. */
export function readLoop(path = "src/x.ts") {
  return () => ({ action: { tool: "read" as const, path } });
}

/** Recorder that keeps every persisted record in memory for assertions. */
export function collectingRecorder() {
  const calls: (CallStartRecord | CallRecord)[] = [];
  const contexts: ContextRecord[] = [];
  const updates: UpdateRecord[] = [];
  const prompts: SystemPromptRecord[] = [];
  const recorder: RunRecorder = {
    callStart: async (record) => void calls.push(record),
    call: async (record) => void calls.push(record),
    context: async (record) => void contexts.push(record),
    update: async (record) => void updates.push(record),
    prompt: async (record) => void prompts.push(record),
  };
  return { recorder, calls, contexts, updates, prompts };
}

/** Completion stub: never touches a network, returns a fixed actor payload. */
export function stubClient(over?: { model?: string }): {
  readonly client: CompletionClient;
  readonly received: { system: string; user: string; model: string }[];
} {
  const received: { system: string; user: string; model: string }[] = [];
  return {
    received,
    client: {
      complete: async (request) => {
        received.push(request);
        return {
          text: JSON.stringify({ action: { tool: "finish" } }),
          ...(over?.model ? { model: over.model } : {}),
        };
      },
    },
  };
}
