import { describe, expect, it } from "vitest";

import { FakeActorProvider, FakeJevProvider, FakeRepairProvider } from "./providers.js";
import { runClosedLoop } from "./runner.js";
import type { HybridConfig, HybridTask } from "./types.js";

const config: HybridConfig = {
  schemaVersion: 1,
  evaluation: "closed_loop",
  provider: {
    mode: "fake",
    jevModel: "fake",
    actorModel: "fake",
    repairModel: "fake",
    maxRequests: 100,
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
  modes: ["history", "llm", "rules", "jev"],
  seed: 1,
  recordContextText: true,
  candidateMaxBytes: 4096,
};

const task: HybridTask = {
  id: "test-task",
  instruction: "update the file",
  files: { "src/x.ts": "old" },
  expectedFiles: { "src/x.ts": "new" },
  tests: ["test-task"],
  steps: [
    { action: { tool: "write", path: "src/x.ts", content: "new" }, result: "write" },
    { action: { tool: "test", command: "test-task" }, result: "test" },
    { action: { tool: "finish" }, result: "finish" },
  ],
};

describe("hybrid closed loop", () => {
  it("runs every comparison mode through the same safe action boundary", async () => {
    const result = await runClosedLoop({
      config,
      tasks: [task],
      providers: {
        jev: new FakeJevProvider(),
        repair: new FakeRepairProvider(),
        actor: new FakeActorProvider([task]),
      },
    });
    expect(result.summary.scores).toHaveLength(4);
    expect(result.summary.scores.every((score) => score.completed && score.testPassed)).toBe(true);
    expect(
      result.contexts
        .filter((context) => context.mode !== "history")
        .every((context) => !context.included.includes("history")),
    ).toBe(true);
  });
});
