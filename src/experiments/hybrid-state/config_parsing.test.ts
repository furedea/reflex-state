import { describe, expect, it } from "vitest";

import { parseHybridConfig, parseHybridTask, parseTaskScoring } from "./config_parsing.js";

function config(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    evaluation: "closed_loop",
    provider: { mode: "fake", maxRequests: 5, timeoutMs: 1000 },
    budgets: {
      memoryBytes: 1,
      factsBytes: 1,
      latestObservationBytes: 1,
      requestBytes: 1,
      maxQuestions: 1,
      maxRepairCalls: 0,
      maxActions: 1,
    },
    modes: ["history"],
    seed: 0,
    candidateMaxBytes: 64,
    ...overrides,
  };
}

describe("parseHybridConfig", () => {
  it("fills defaults and keeps only present models", () => {
    const parsed = parseHybridConfig(
      config({ provider: { mode: "fake", maxRequests: 5, timeoutMs: 9, actorModel: "m" } }),
    );
    expect(parsed.provider).toEqual({
      mode: "fake",
      actorModel: "m",
      maxRequests: 5,
      trialMaxRequests: 5,
      timeoutMs: 9,
    });
    expect(parsed.iterations).toBe(1);
  });

  it.each([
    [{ schemaVersion: 1 }, "Unsupported hybrid-state config version (expected 2)"],
    [{ modes: ["history", "history"] }, "Config modes must not contain duplicates"],
    [
      { provider: { mode: "live", maxRequests: 1, timeoutMs: 1 } },
      "Live closed_loop config requires provider.actorModel",
    ],
    [
      { provider: { mode: "fake", maxRequests: 1, trialMaxRequests: 2, timeoutMs: 1 } },
      "provider.trialMaxRequests must not exceed provider.maxRequests",
    ],
    [
      { provider: { mode: "fake", maxRequests: 1, timeoutMs: 1, executionIsolation: "x" } },
      "Invalid provider.executionIsolation",
    ],
    [{ candidateMaxBytes: 1 }, "Invalid config candidateMaxBytes: expected an integer >= 64"],
  ])("rejects %j", (overrides, message) => {
    expect(() => parseHybridConfig(config(overrides))).toThrow(message);
  });
});

describe("parseHybridTask", () => {
  it("parses a task and rejects invalid injections", () => {
    const task = {
      id: "t",
      instruction: "i",
      files: { "a.txt": "x" },
      tests: ["unit"],
      injections: [{ step: 1, text: "hi", extra: true }],
    };
    expect(parseHybridTask(task, "f").injections).toEqual([{ step: 1, text: "hi" }]);
    expect(() => parseHybridTask({ ...task, injections: [{ step: -1, text: "x" }] }, "f")).toThrow(
      "Invalid injection in f",
    );
  });
});

describe("parseTaskScoring", () => {
  it("parses oracles and checkpoint requirements", () => {
    const scoring = parseTaskScoring(
      {
        taskId: "t",
        oracles: [{ testId: "u", kind: "script", script: "run" }],
        checkpoints: [
          {
            id: "c",
            at: "final",
            appliesWhen: "always",
            required: [
              {
                id: "r",
                anyOf: [["a"]],
                inverted: ["b"],
                scope: { roles: ["user"] },
                description: "d",
              },
              { id: "v", kind: "verification", testId: "u", status: "passed", fresh: true },
            ],
          },
        ],
      },
      "f",
    );
    expect(scoring.oracles).toEqual([{ testId: "u", kind: "script", script: "run" }]);
    expect(scoring.checkpoints?.[0]?.required).toEqual([
      {
        id: "r",
        kind: "verbatim",
        anyOf: [["a"]],
        scope: { roles: ["user"] },
        inverted: ["b"],
        description: "d",
      },
      { id: "v", kind: "verification", testId: "u", status: "passed", fresh: true },
    ]);
    expect(scoring.checkpoints?.[0]?.appliesWhen).toBe("always");
  });

  it.each([
    [{ kind: "verbatim" }, "verbatim required item r in f needs anyOf"],
    [{ kind: "exact_value" }, "exact_value required item r in f needs a value"],
    [{ kind: "bogus" }, "Invalid kind for required item r in f"],
    [{ anyOf: [["a"]], markers: [""] }, "Invalid markers for required item r in f"],
    [{ anyOf: [["a"]], scope: { trusts: [1] } }, "Invalid scope.trusts for required item r in f"],
  ])("rejects requirement %j", (item, message) => {
    const scoring = {
      taskId: "t",
      checkpoints: [{ id: "c", at: 0, required: [{ id: "r", ...item }] }],
    };
    expect(() => parseTaskScoring(scoring, "f")).toThrow(message);
  });
});
