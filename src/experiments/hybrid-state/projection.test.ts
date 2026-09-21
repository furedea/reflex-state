import { describe, expect, it } from "vitest";

import { buildProjection } from "./projection.js";
import { emptyMemory, type HybridBudgets, type TraceMessage, type WorkMemory } from "./types.js";
import { initialFacts } from "./update.js";

const budgets: HybridBudgets = {
  memoryBytes: 8192,
  factsBytes: 4096,
  latestObservationBytes: 8192,
  requestBytes: 24000,
  maxQuestions: 8,
  maxRepairCalls: 1,
  maxActions: 8,
};

const actionBudget = {
  limit: 8,
  used: 0,
  remaining_including_next: 8,
  finish_counts_as_action: true,
} as const;

function messages(count: number): TraceMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `message ${index}`,
    sequence: index,
    sourceId: `m-${index}`,
    truncated: false,
  }));
}

describe("hybrid projection", () => {
  it("does not append old conversation to state-first input", () => {
    const history = messages(200);
    const input = buildProjection({
      mode: "rules",
      instruction: "task",
      facts: initialFacts(),
      memory: emptyMemory(),
      latest: history.slice(-2),
      history,
      actionBudget,
      budgets,
    });
    expect(input.bundle.unavailable).toBeUndefined();
    expect(input.bundle.history).toBeUndefined();
    expect(input.bundle.latest).toContain("message 199");
    expect(input.bundle.latest).not.toContain("message 0");
    expect(input.userText).not.toContain("message 0");
  });

  it("retains the complete history baseline and measures its growth", () => {
    const history = messages(200);
    const input = buildProjection({
      mode: "history",
      instruction: "task",
      facts: initialFacts(),
      memory: emptyMemory(),
      latest: history.slice(-2),
      history,
      actionBudget,
      budgets,
    });
    expect(input.bundle.unavailable).toBeUndefined();
    expect(input.bundle.history).toContain("message 0");
    expect(input.bundle.history).toContain("message 199");
    expect(input.bundle.bytes.history).toBeGreaterThan(2000);
  });

  it("keeps protected user constraints within the memory budget", () => {
    const memory: WorkMemory = {
      ...emptyMemory(),
      constraints: [
        {
          id: "c-1",
          kind: "constraints",
          text: "never drop this constraint",
          sourceIds: ["m-1"],
          origin: "extracted",
          trust: "user",
          status: "active",
          updatedAt: 0,
        },
      ],
      findings: [
        {
          id: "f-1",
          kind: "findings",
          text: "x".repeat(9000),
          sourceIds: ["m-2"],
          origin: "extracted",
          trust: "tool_result",
          status: "active",
          updatedAt: 0,
        },
      ],
    };
    const input = buildProjection({
      mode: "llm",
      instruction: "task",
      facts: initialFacts(),
      memory,
      latest: [],
      history: [],
      actionBudget,
      budgets: { ...budgets, memoryBytes: 2048 },
    });
    expect(input.bundle.unavailable).toBeUndefined();
    expect(input.bundle.memory).toContain("never drop this constraint");
    expect(input.bundle.truncated).toContain("memory");
  });

  it("fails explicitly when facts metadata alone exceeds its budget", () => {
    const input = buildProjection({
      mode: "rules",
      instruction: "task",
      facts: { ...initialFacts(), modifiedFiles: ["x".repeat(1000)] },
      memory: emptyMemory(),
      latest: [],
      history: [],
      actionBudget,
      budgets: { ...budgets, factsBytes: 10 },
    });
    expect(input.bundle.unavailable).toBe("facts_metadata_exceeds_budget");
  });
});
