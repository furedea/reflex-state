import { describe, expect, it } from "vitest";

import { checkIsolation, TaskEnvironment } from "./task_environment.js";
import type { HybridTask, TaskScoring } from "./types.js";

function task(overrides: Partial<HybridTask> = {}): HybridTask {
  return {
    id: "env-task",
    instruction: "fix the file",
    files: { "src/a.js": "export const v = 0;\n" },
    allowedTests: ["env-check"],
    ...overrides,
  };
}

function scriptOracle(body: string): TaskScoring {
  return {
    taskId: "env-task",
    oracles: [{ testId: "env-check", kind: "script", script: body }],
  };
}

const PASS_ORACLE = `console.log("oracle-result: " + JSON.stringify({ passed: true, detail: "ok" }));`;

describe("task environment oracle protocol", () => {
  it("passes only when the oracle emits a verdict line", async () => {
    const env = new TaskEnvironment(task(), scriptOracle(PASS_ORACLE), { isolated: false });
    const result = await env.execute({ tool: "test", command: "env-check" });
    expect(result.passed).toBe(true);
    expect(result.verification?.status).toBe("passed");
  });

  it("fails a clean exit that never emits the verdict line", async () => {
    const env = new TaskEnvironment(task(), scriptOracle('console.log("looks fine");'), {
      isolated: false,
    });
    const result = await env.execute({ tool: "test", command: "env-check" });
    expect(result.passed).toBe(false);
    expect(result.text).toContain("invalid_result_protocol");
  });

  it("fails an oracle that crashes", async () => {
    const env = new TaskEnvironment(task(), scriptOracle('throw new Error("oracle exploded");'), {
      isolated: false,
    });
    const result = await env.execute({ tool: "test", command: "env-check" });
    expect(result.passed).toBe(false);
    expect(result.text).toContain("invalid_result_protocol");
  });

  it("enforces the oracle timeout", async () => {
    const env = new TaskEnvironment(task(), scriptOracle("while (true) {}"), {
      isolated: false,
      oracleTimeoutMs: 500,
    });
    const started = performance.now();
    const result = await env.execute({ tool: "test", command: "env-check" });
    expect(result.passed).toBe(false);
    expect(result.text).toContain("stopped by limits");
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("records check key, generation, sequence, and evidence id per run", async () => {
    const env = new TaskEnvironment(task(), scriptOracle(PASS_ORACLE), { isolated: false });
    const first = await env.execute({ tool: "test", command: "env-check" }, "ev-1");
    const second = await env.execute({ tool: "test", command: "env-check" }, "ev-2");
    expect(first.verification?.checkKey).toBe(second.verification?.checkKey);
    expect(first.verification?.generation).toBe(0);
    expect(second.verification?.generation).toBe(0);
    expect(second.verification?.seq).toBeGreaterThan(first.verification?.seq ?? -1);
    expect(first.verification?.evidenceId).toBe("ev-1");
    const facts = env.verificationFacts();
    expect(facts.verification.test.status).toBe("passed");
    expect(facts.verification.test.freshness).toBe("current");
  });

  it("marks a check run before the latest observation as stale", async () => {
    const env = new TaskEnvironment(task(), scriptOracle(PASS_ORACLE), { isolated: false });
    await env.execute({ tool: "test", command: "env-check" });
    await env.execute({ tool: "write", path: "src/a.js", content: "export const v = 1;\n" });
    const facts = env.verificationFacts();
    expect(facts.verification.test.status).toBe("passed");
    expect(facts.verification.test.freshness).toBe("stale");
  });

  it("requires an oracle for every allowed test when the task is scored", async () => {
    const scored: TaskScoring = {
      taskId: "env-task",
      oracles: [],
      expectedFiles: { "src/a.js": "export const v = 9;\n" },
    };
    const env = new TaskEnvironment(task({ expectedFiles: { "src/a.js": "x" } }), scored, {
      isolated: false,
    });
    const result = await env.execute({ tool: "test", command: "env-check" });
    expect(result.violation).toBe("test_no_oracle");
  });

  it("falls back to task expectedFiles only when no scoring file exists", async () => {
    const env = new TaskEnvironment(
      task({ expectedFiles: { "src/a.js": "export const v = 0;\n" } }),
      undefined,
      { isolated: false },
    );
    const result = await env.execute({ tool: "test", command: "env-check" });
    expect(result.passed).toBe(true);
  });

  it("evaluates final workspace state through the oracle, not string presence", async () => {
    const env = new TaskEnvironment(task(), scriptOracle(PASS_ORACLE), { isolated: false });
    await env.execute({ tool: "write", path: "src/a.js", content: "export const v = 7;\n" });
    const results = await env.evaluateFinal();
    expect(results).toEqual([{ testId: "env-check", status: "passed", output: "ok" }]);
  });
});

describe("isolation boundary", () => {
  const darwin = process.platform === "darwin";

  it("verifies the real boundary on macOS and reports unavailable elsewhere", async () => {
    const status = await checkIsolation();
    if (!darwin) {
      expect(status.available).toBe(false);
      expect(status.mechanism).toBe("none");
      return;
    }
    expect(status.mechanism).toBe("sandbox-exec");
    expect(status.checks?.map((check) => check.name)).toEqual([
      "allowed_write_and_oracle",
      "outside_read_denied",
      "symlink_escape_denied",
      "env_not_inherited",
      "network_denied",
      "timeout_enforced",
    ]);
    for (const check of status.checks ?? [])
      expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
    expect(status.available).toBe(true);
    expect(status.profileHash).toMatch(/^[0-9a-f]{16}$/);
  }, 60_000);

  it("runs an isolated oracle inside the deny-default sandbox on macOS", async () => {
    if (!darwin) return;
    const env = new TaskEnvironment(task(), scriptOracle(PASS_ORACLE), { isolated: true });
    const result = await env.execute({ tool: "test", command: "env-check" });
    expect(result.passed).toBe(true);
  }, 30_000);

  it("denies workspace escape inside the sandbox on macOS", async () => {
    if (!darwin) return;
    const escape = scriptOracle(
      `import { readFileSync } from "node:fs";
       let leaked = false;
       try { readFileSync("/etc/passwd", "utf8"); leaked = true; } catch {}
       console.log("oracle-result: " + JSON.stringify({ passed: !leaked, detail: leaked ? "escaped" : "confined" }));`,
    );
    const env = new TaskEnvironment(task(), escape, { isolated: true });
    const result = await env.execute({ tool: "test", command: "env-check" });
    expect(result.passed).toBe(true);
    expect(result.text).toContain("confined");
  }, 30_000);
});
