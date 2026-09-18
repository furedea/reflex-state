import { describe, expect, it } from "vitest";

import { buildProjection } from "./projection.js";
import { emptyMemory, type HybridBudgets, type TraceMessage } from "./types.js";
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
      budgets,
    });
    expect(input.history).toBeUndefined();
    expect(input.latest).toContain("message 199");
    expect(input.latest).not.toContain("message 0");
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
      budgets,
    });
    expect(input.history).toContain("message 0");
    expect(input.history).toContain("message 199");
    expect(input.bytes.history).toBeGreaterThan(2000);
  });

  it("fails explicitly when facts metadata alone exceeds its budget", () => {
    const input = buildProjection({
      mode: "rules",
      instruction: "task",
      facts: { ...initialFacts(), modifiedFiles: ["x".repeat(1000)] },
      memory: emptyMemory(),
      latest: [],
      history: [],
      budgets: { ...budgets, factsBytes: 10 },
    });
    expect(input.unavailable).toBe("facts_metadata_exceeds_budget");
  });
});
