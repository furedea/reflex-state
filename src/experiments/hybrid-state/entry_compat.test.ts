import { initialState } from "../../core/reducer.js";
import {
  emptyMemory,
  initialFacts,
  needsRepair,
  RepairCheck,
  type ApplyContext,
  type ExperimentMode,
  type PatchOperation,
  type RunContext,
  type UpdateInput,
} from "./index.js";

const input: UpdateInput = {
  mode: "facts" as ExperimentMode,
  instruction: "task",
  state: initialState(),
  facts: initialFacts(),
  memory: emptyMemory(),
  candidates: [],
  observations: [],
  latest: [],
  step: 0,
  now: 0,
};

const citesExtraSource: PatchOperation = {
  operation: "add",
  kind: "findings",
  text: "a finding",
  sourceIds: ["extra-source"],
  trust: "tool_result",
  origin: "generated",
};

describe("needsRepair's former context argument", () => {
  const context: ApplyContext = {
    candidates: [],
    observations: [],
    extraSourceIds: ["extra-source"],
    allowGenerated: true,
    now: 0,
  };

  it("is passed to RepairCheck from the experiment entry", () => {
    expect(new RepairCheck(input, 8192).reasonsFor([citesExtraSource], context)).toEqual([]);
  });

  it("is derived from the input when needsRepair is called with three arguments", () => {
    expect(needsRepair(input, [citesExtraSource], 8192)).toContain("missing_evidence");
  });
});

describe("RunContext", () => {
  it("can still be built from its original fields", () => {
    const context: RunContext = {
      runId: "run",
      calls: [],
      contexts: [],
      updates: [],
      uniqueCandidates: new Map(),
      decisionCounts: new Map(),
      appliedCounts: new Map(),
      budget: { sent: 0, limit: 1 },
      trialSent: new Map(),
      systemPrompts: new Set(),
      callSeq: 0,
    };
    expect(context.runId).toBe("run");
  });
});
