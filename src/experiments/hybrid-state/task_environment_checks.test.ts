import { describe, expect, it } from "vitest";

import { TaskEnvironment } from "./task_environment.js";
import type { HybridTask, TaskScoring } from "./types.js";

const task: HybridTask = {
  id: "t",
  instruction: "x",
  files: { "a.txt": "old" },
  allowedTests: ["t1", "t2"],
  expectedFiles: { "a.txt": "new" },
};

const scoring: TaskScoring = {
  taskId: "t",
  expectedFiles: { "a.txt": "new" },
  oracles: [
    { testId: "t1", kind: "expected_files" },
    {
      testId: "t2",
      kind: "script",
      script: `console.log("oracle-result: " + JSON.stringify({ passed: true, constraints: { a: true, b: "x" } }));`,
    },
  ],
};

describe("task environment verification facts", () => {
  it("reports checks, blockers and staleness per test", async () => {
    const env = new TaskEnvironment(task, scoring, { isolated: false });
    const failed = await env.execute({ tool: "test", command: "t1" }, "ev-1");
    expect(failed.text).toBe("test t1: failed (files differ: a.txt)");
    await env.execute({ tool: "write", path: "a.txt", content: "new" });
    const passed = await env.execute({ tool: "test", command: "t1" });
    expect(passed.text).toContain("test t1: passed check=");
    const script = await env.execute({ tool: "test", command: "t2" });
    expect(script.verification?.constraints).toEqual({ a: true });

    const { verification, blockers } = env.verificationFacts();
    expect(blockers).toHaveLength(0);
    expect(verification.test.status).toBe("passed");
    expect(verification.test.freshness).toBe("current");
    expect(Object.keys(verification.tests ?? {})).toEqual(["t1", "t2"]);

    await env.execute({ tool: "write", path: "b.txt", content: "z" });
    expect(env.verificationFacts().verification.tests?.t1?.freshness).toBe("stale");
  });

  it("keeps a failed check as a blocker and rejects unknown tests", async () => {
    const env = new TaskEnvironment(task, scoring, { isolated: false });
    await env.execute({ tool: "test", command: "t1" });
    expect(env.verificationFacts().blockers).toHaveLength(1);
    const denied = await env.execute({ tool: "test", command: "nope" });
    expect(denied.violation).toBe("test_not_allowed");
  });
});

describe("task environment final evaluation", () => {
  it("evaluates each declared oracle and marks undeclared tests not_run", async () => {
    const env = new TaskEnvironment({ ...task, allowedTests: ["t1", "t2", "t3"] }, scoring, {
      isolated: false,
    });
    await env.execute({ tool: "write", path: "a.txt", content: "new" });
    const results = await env.evaluateFinal();
    expect(results.map((r) => [r.testId, r.status])).toEqual([
      ["t1", "passed"],
      ["t2", "passed"],
      ["t3", "not_run"],
    ]);
  });

  it("falls back to task expectedFiles only without a scoring file", async () => {
    const withoutScoring = new TaskEnvironment(task, undefined, { isolated: false });
    expect((await withoutScoring.evaluateFinal()).map((r) => r.status)).toEqual([
      "failed",
      "failed",
    ]);
    const withEmptyScoring = new TaskEnvironment(task, { taskId: "t" }, { isolated: false });
    expect((await withEmptyScoring.evaluateFinal()).map((r) => r.status)).toEqual([
      "not_run",
      "not_run",
    ]);
  });
});
