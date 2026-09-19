import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  enforceLivePolicy,
  loadScoring,
  loadTasks,
  validateScoredTasks,
  verifyApprovedTasks,
} from "./cli.js";
import { FakeActorProvider, FakeJevProvider, FakeRepairProvider } from "./providers.js";
import { PersistenceError, requiresIsolation, runClosedLoop } from "./runner.js";
import type { HybridConfig, HybridTask } from "./types.js";

const STAGE_A_ROOT = "experiments/hybrid-state/tasks/stage-a";

function config(overrides: Partial<HybridConfig> = {}): HybridConfig {
  return {
    schemaVersion: 2,
    evaluation: "closed_loop",
    provider: {
      mode: "fake",
      actorModel: "fake",
      maxRequests: 128,
      trialMaxRequests: 32,
      timeoutMs: 3000,
    },
    budgets: {
      memoryBytes: 8192,
      factsBytes: 4096,
      latestObservationBytes: 8192,
      requestBytes: 24000,
      maxQuestions: 8,
      maxRepairCalls: 0,
      maxActions: 8,
    },
    modes: ["history", "llm"],
    seed: 17,
    iterations: 1,
    recordContextText: false,
    recordResponseText: false,
    candidateMaxBytes: 4096,
    taskRoot: STAGE_A_ROOT,
    ...overrides,
  };
}

async function stageARun(): Promise<{
  tasks: HybridTask[];
  run: Awaited<ReturnType<typeof runClosedLoop>>;
}> {
  const tasks = await loadTasks(STAGE_A_ROOT);
  const scoring = await loadScoring(STAGE_A_ROOT, tasks);
  const run = await runClosedLoop({
    config: config(),
    tasks,
    scoring,
    providers: {
      actor: new FakeActorProvider(tasks),
      jev: new FakeJevProvider(),
      repair: new FakeRepairProvider(),
    },
  });
  return { tasks, run };
}

describe("Stage A fixtures", () => {
  it("loads the three Stage A tasks each with scoring and a per-test oracle", async () => {
    const tasks = await loadTasks(STAGE_A_ROOT);
    const scoring = await loadScoring(STAGE_A_ROOT, tasks);
    expect(tasks.map((task) => task.id).sort()).toEqual([
      "observation-derived",
      "protected-constraint",
      "transient-recovery",
    ]);
    for (const task of tasks) {
      const scored = scoring.get(task.id);
      expect(scored, `scoring for ${task.id}`).toBeDefined();
      for (const testId of task.allowedTests) {
        const oracle = scored?.oracles?.find((oracle) => oracle.testId === testId);
        expect(oracle?.kind, `${task.id}/${testId} oracle kind`).toBe("script");
        expect(oracle?.script).toContain("oracle-result:");
      }
      expect(scored?.checkpoints?.length).toBeGreaterThan(0);
    }
  });
});

describe("Stage A closed loop", () => {
  it("runs 3 tasks x 2 modes through actor calls only, no jev/update/repair", async () => {
    const { run } = await stageARun();
    expect(run.summary.scores).toHaveLength(6);
    expect(run.summary.scores.every((score) => score.completed)).toBe(true);
    expect(run.summary.wiring).toEqual({ passed: 6, failed: 0, notEvaluated: 0 });
    expect(run.calls.every((call) => call.kind === "actor")).toBe(true);
    expect(run.calls.every((call) => call.providerInvoked)).toBe(true);
    expect(run.summary.metrics.llm.invocations.jev).toBe(0);
    expect(run.summary.metrics.llm.invocations.update).toBe(0);
    expect(run.summary.metrics.llm.invocations.repair).toBe(0);
    expect(run.summary.efficacyStatus).toBe("not_evaluated");
  }, 60_000);

  it("passes every oracle-backed test in both modes", async () => {
    const { run } = await stageARun();
    for (const score of run.summary.scores) {
      expect(score.tests, score.trialId).not.toEqual({});
      for (const [testId, status] of Object.entries(score.tests))
        expect(status, `${score.trialId}/${testId}`).toBe("passed");
      expect(score.testPassed).toBe(true);
    }
  }, 60_000);

  it("retains the protected constraint after the distractor in both modes", async () => {
    const { run } = await stageARun();
    const trials = run.summary.scores.filter((score) => score.taskId === "protected-constraint");
    expect(trials).toHaveLength(2);
    for (const trial of trials) {
      const checkpoint = trial.checkpoints.find(
        (checkpoint) => checkpoint.checkpointId === "constraint-retained-after-distractor",
      );
      expect(checkpoint, trial.trialId).toBeDefined();
      const item = checkpoint?.items.find((item) => item.id === "no-key-change");
      expect(item?.retained, `${trial.mode} ${item?.reason ?? ""}`).toBe(true);
      expect(trial.constraints["api-key-unchanged"]).toBe(true);
      expect(trial.constraintPassed).toBe(true);
    }
  }, 60_000);

  it("keeps the transient failure observable and records test fail then pass", async () => {
    const { run } = await stageARun();
    const trials = run.summary.scores.filter((score) => score.taskId === "transient-recovery");
    expect(trials).toHaveLength(2);
    for (const trial of trials) {
      const calc = trial.actorTests.filter((test) => test.testId === "calc-check");
      expect(calc.map((test) => test.passed)).toEqual([false, true]);
      const syntax = trial.actorTests.filter((test) => test.testId === "syntax-check");
      expect(syntax.map((test) => test.passed)).toEqual([true]);
      const decoy = trial.checkpoints
        .find((checkpoint) => checkpoint.checkpointId === "decoy-pass-visible")
        ?.items.find((item) => item.id === "syntax-check-passed");
      expect(decoy?.retained, `${trial.mode} ${decoy?.reason ?? ""}`).toBe(true);
      const recovered = trial.checkpoints.find(
        (checkpoint) => checkpoint.checkpointId === "recovered-check-retained",
      );
      const verification = recovered?.items.find((item) => item.id === "calc-check-recovered");
      expect(verification?.retained, `${trial.mode} ${verification?.reason ?? ""}`).toBe(true);
      const failure = recovered?.items.find((item) => item.id === "transient-failure");
      expect(failure?.retained, `${trial.mode} ${failure?.reason ?? ""}`).toBe(true);
    }
  }, 60_000);

  it("retains the conditional port selection in both modes", async () => {
    const { run } = await stageARun();
    const trials = run.summary.scores.filter((score) => score.taskId === "observation-derived");
    expect(trials).toHaveLength(2);
    for (const trial of trials) {
      const checkpoint = trial.checkpoints.find((entry) => entry.checkpointId === "ports-retained");
      const value = checkpoint?.items.find((item) => item.id === "fallback-port-value");
      expect(value?.retained, `${trial.mode} ${value?.reason ?? ""}`).toBe(true);
      const condition = checkpoint?.items.find((item) => item.id === "selection-condition");
      expect(condition?.retained, `${trial.mode} ${condition?.reason ?? ""}`).toBe(true);
      expect(trial.tests["port-check"]).toBe("passed");
    }
  }, 60_000);
});

describe("live gating", () => {
  const liveConfig = (overrides: Partial<HybridConfig> = {}): HybridConfig =>
    config({
      provider: {
        mode: "live",
        actorModel: "anthropic/test-model",
        maxRequests: 64,
        trialMaxRequests: 32,
        timeoutMs: 30000,
        executionIsolation: "required",
      },
      ...overrides,
    });

  it("accepts the checked-in approved task set by content hash", async () => {
    await expect(verifyApprovedTasks(STAGE_A_ROOT)).resolves.toBeUndefined();
  });

  it("rejects a task root that is not the approved directory", async () => {
    await expect(verifyApprovedTasks("experiments/hybrid-state/tasks")).rejects.toThrow(
      /approved task set/,
    );
  });

  it("rejects tampered, missing, and extra task files by content hash", async () => {
    const { createHash } = await import("node:crypto");
    const { readFile, readdir } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "stage-a-tampered-"));
    try {
      const root = join(dir, "tasks");
      await cp(STAGE_A_ROOT, root, { recursive: true });
      const files: Record<string, string> = {};
      const hash = async (name: string) =>
        createHash("sha256")
          .update(await readFile(join(root, name), "utf8"))
          .digest("hex");
      for (const entry of await readdir(root))
        if (entry.endsWith(".json")) files[entry] = await hash(entry);
      for (const entry of await readdir(join(root, "scoring")))
        if (entry.endsWith(".json")) files[`scoring/${entry}`] = await hash(`scoring/${entry}`);
      const manifestPath = join(dir, "manifest.json");
      const writeManifest = async (filesMap: Record<string, string>) =>
        writeFile(manifestPath, JSON.stringify({ taskRoot: root, files: filesMap }));
      await writeManifest(files);
      await expect(verifyApprovedTasks(root, manifestPath)).resolves.toBeUndefined();

      await writeFile(
        join(root, "01_protected_constraint.json"),
        JSON.stringify({ id: "tampered", instruction: "x", files: {}, allowedTests: [] }),
      );
      await expect(verifyApprovedTasks(root, manifestPath)).rejects.toThrow(
        /does not match the approved content hash/,
      );

      await cp(STAGE_A_ROOT, root, { recursive: true });
      await writeFile(join(root, "scoring", "extra.json"), "{}");
      await expect(verifyApprovedTasks(root, manifestPath)).rejects.toThrow(/Unapproved files/);

      await rm(join(root, "scoring", "extra.json"));
      await rm(join(root, "03_observation_derived.json"));
      await expect(verifyApprovedTasks(root, manifestPath)).rejects.toThrow(
        /Approved task file missing/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces the approved set inside the live policy", async () => {
    const values = { live: true, out: ".local/x" };
    await expect(enforceLivePolicy(liveConfig(), values)).resolves.toBeUndefined();
    const moved = liveConfig({ taskRoot: "experiments/hybrid-state/tasks" });
    await expect(enforceLivePolicy(moved, values)).rejects.toThrow();
  });

  it("requires live flag, Stage A modes, isolation, and an actor model", async () => {
    const values = { live: true, out: ".local/x" };
    await expect(enforceLivePolicy(liveConfig(), { ...values, live: false })).rejects.toThrow(
      /--live/,
    );
    await expect(
      enforceLivePolicy(liveConfig({ modes: ["history", "jev"] }), values),
    ).rejects.toThrow(/Stage A modes/);
    await expect(
      enforceLivePolicy(
        liveConfig({
          provider: {
            mode: "live",
            actorModel: "m",
            maxRequests: 1,
            trialMaxRequests: 1,
            timeoutMs: 1,
          },
        }),
        values,
      ),
    ).rejects.toThrow(/executionIsolation/);
    await expect(
      enforceLivePolicy(
        liveConfig({
          provider: {
            mode: "live",
            maxRequests: 1,
            trialMaxRequests: 1,
            timeoutMs: 1,
            executionIsolation: "required",
          },
        }),
        values,
      ),
    ).rejects.toThrow(/actorModel/);
  });

  it("requires isolation for any non-fake closed-loop provider, including recorded", () => {
    expect(requiresIsolation(config({ provider: { mode: "recorded" } as never }))).toBe(true);
    expect(requiresIsolation(config())).toBe(false);
    expect(
      requiresIsolation(
        config({ provider: { mode: "fake", executionIsolation: "required" } as never }),
      ),
    ).toBe(true);
  });

  it("makes scoring mandatory for closed-loop comparisons", async () => {
    const tasks = await loadTasks(STAGE_A_ROOT);
    expect(() => validateScoredTasks(tasks, new Map())).toThrow(/no scoring file/);
    const scoring = await loadScoring(STAGE_A_ROOT, tasks);
    expect(() => validateScoredTasks(tasks, scoring)).not.toThrow();
    const missing = tasks.map((task) => ({ ...task, allowedTests: [...task.allowedTests, "x"] }));
    expect(() => validateScoredTasks(missing, scoring)).toThrow(/no oracle registered/);
  });
});

describe("runner contract", () => {
  const miniTask: HybridTask = {
    id: "mini",
    instruction: "do a thing",
    files: { "a.txt": "x" },
    allowedTests: [],
    steps: [
      {
        action: { tool: "finish" },
        result: "finish",
        statePatch: [
          {
            operation: "add",
            kind: "findings",
            text: "note",
            sourceIds: ["self"],
            trust: "assistant",
            origin: "generated",
          },
        ],
      },
    ],
  };

  it("writes a call-start record before each provider invocation record", async () => {
    const order: string[] = [];
    const recorder = {
      callStart: async (record: { callId: string }) => {
        order.push(`start:${record.callId}`);
      },
      call: async (record: { callId: string }) => {
        order.push(`end:${record.callId}`);
      },
      context: async () => {},
      update: async () => {},
    };
    await runClosedLoop({
      config: config({ modes: ["llm"], seed: 1 }),
      tasks: [miniTask],
      providers: { actor: new FakeActorProvider([miniTask]) },
      recorder,
    });
    const ids = new Set(order.map((entry) => entry.slice(entry.indexOf(":") + 1)));
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) {
      const start = order.indexOf(`start:${id}`);
      const end = order.indexOf(`end:${id}`);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
    }
  });

  it("drops an invalid patch operation, applies the rest, and continues the trial", async () => {
    const mixedTask: HybridTask = {
      ...miniTask,
      steps: [
        {
          action: { tool: "finish" },
          result: "finish",
          statePatch: [
            {
              operation: "add",
              kind: "findings",
              text: "note",
              sourceIds: ["self"],
              trust: "assistant",
              origin: "generated",
            },
            {
              operation: "add",
              kind: "findings",
              text: "miscited",
              sourceIds: ["self"],
              trust: "tool_result",
              origin: "extracted",
            },
          ],
        },
      ],
    };
    const result = await runClosedLoop({
      config: config({ modes: ["llm"], seed: 1 }),
      tasks: [mixedTask],
      providers: { actor: new FakeActorProvider([mixedTask]) },
    });
    const score = result.summary.scores[0];
    expect(score?.completed).toBe(true);
    const update = result.updates.find((record) => record.source === "actor_patch");
    expect(update?.dropped).toEqual([expect.stringContaining("extracted_text_mismatch")]);
    expect(update?.operations).toHaveLength(1);
  });

  it("rejects an over-budget llm patch without committing it or running the action", async () => {
    const giantPatchTask: HybridTask = {
      ...miniTask,
      steps: [
        {
          action: { tool: "write", path: "a.txt", content: "written" },
          result: "write",
          statePatch: [
            {
              operation: "add",
              kind: "findings",
              text: "x".repeat(9000),
              sourceIds: ["self"],
              trust: "assistant",
              origin: "generated",
            },
          ],
        },
        { action: { tool: "finish" }, result: "finish" },
      ],
    };
    const result = await runClosedLoop({
      config: config({ modes: ["llm"], seed: 1 }),
      tasks: [giantPatchTask],
      providers: { actor: new FakeActorProvider([giantPatchTask]) },
    });
    const score = result.summary.scores[0];
    expect(score?.completed).toBe(false);
    expect(score?.failureReason).toBe("invalid_update:memory_exceeds_budget");
    const rejection = result.updates.find((record) => record.rejected === "memory_exceeds_budget");
    expect(rejection).toBeDefined();
    const committed = result.updates.filter(
      (record) => record.source === "actor_patch" && record.rejected === undefined,
    );
    expect(committed).toHaveLength(0);
  });

  it("propagates a recorder failure as PersistenceError and stops the run", async () => {
    const recorder = {
      callStart: async () => {},
      call: async () => {
        throw new Error("disk_full");
      },
      context: async () => {},
      update: async () => {},
    };
    await expect(
      runClosedLoop({
        config: config({ modes: ["history"], seed: 1 }),
        tasks: [miniTask],
        providers: { actor: new FakeActorProvider([miniTask]) },
        recorder,
      }),
    ).rejects.toThrow(PersistenceError);
  });

  it("produces a deterministic trial order from the config seed", async () => {
    const tasks = await loadTasks(STAGE_A_ROOT);
    const runA = await runClosedLoop({
      config: config({ seed: 42 }),
      tasks,
      providers: { actor: new FakeActorProvider(tasks) },
    });
    const runB = await runClosedLoop({
      config: config({ seed: 42 }),
      tasks,
      providers: { actor: new FakeActorProvider(tasks) },
    });
    expect(runA.summary.scores.map((score) => score.trialId)).toEqual(
      runB.summary.scores.map((score) => score.trialId),
    );
  }, 60_000);
});
