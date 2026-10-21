import { buildActorRequest } from "./prompts.js";
import type { ActorRequest, HybridConfig, HybridTask, TraceMessage } from "./types.js";

export const budgets = {
  memoryBytes: 8192,
  factsBytes: 4096,
  latestObservationBytes: 8192,
  requestBytes: 24000,
  maxQuestions: 8,
  maxRepairCalls: 1,
  maxActions: 8,
} as const;

export function config(overrides: Partial<HybridConfig> = {}): HybridConfig {
  return {
    schemaVersion: 2,
    evaluation: "closed_loop",
    provider: {
      mode: "fake",
      actorModel: "fake",
      maxRequests: 100,
      trialMaxRequests: 32,
      timeoutMs: 1000,
    },
    budgets,
    modes: ["history", "llm"],
    seed: 1,
    iterations: 1,
    recordContextText: true,
    recordResponseText: false,
    candidateMaxBytes: 4096,
    ...overrides,
  };
}

export const task: HybridTask = {
  id: "acc-task",
  instruction: "update the file",
  files: { "src/x.ts": "old" },
  allowedTests: ["acc-test"],
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
    { action: { tool: "test", command: "acc-test" }, result: "test" },
    { action: { tool: "finish" }, result: "finish" },
  ],
};

export function actorRequest(overrides: Partial<ActorRequest> = {}): ActorRequest {
  return {
    ...buildActorRequest({
      mode: "history",
      taskId: "acc-task",
      trialId: "trial-1",
      step: 0,
      userText: '{"instruction":"task"}',
      allowedTests: ["acc-test"],
      model: "fake",
    }),
    ...overrides,
  };
}

export function message(id: string, text: string): TraceMessage {
  return { id, role: "tool_result", text, sequence: 0, sourceId: id, truncated: false };
}
