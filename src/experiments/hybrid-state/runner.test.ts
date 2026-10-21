import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  LiveActorProvider,
} from "./providers.js";
import { runClosedLoop, type RunRecorder } from "./runner.js";
import {
  collectingRecorder,
  config,
  readLoop,
  ScriptedActor,
  stubClient,
  task,
} from "./runner_test_support.js";
import { TaskEnvironment } from "./task_environment.js";
import type { HybridConfig, HybridTask } from "./types.js";

describe("hybrid closed loop", () => {
  it("runs history and llm through the same safe action boundary", async () => {
    const result = await runClosedLoop({
      config,
      tasks: [task],
      providers: {
        jev: new FakeJevProvider(),
        repair: new FakeRepairProvider(),
        actor: new FakeActorProvider([task]),
      },
    });
    expect(result.summary.scores).toHaveLength(2);
    expect(result.summary.scores.every((score) => score.completed && score.testPassed)).toBe(true);
    expect(
      result.contexts
        .filter((context) => context.mode !== "history")
        .every((context) => !context.included.includes("history")),
    ).toBe(true);
  });

  it("marks fake provider runs as not evaluated for efficacy", async () => {
    const result = await runClosedLoop({
      config,
      tasks: [task],
      providers: { actor: new FakeActorProvider([task]) },
    });
    expect(result.summary.efficacyStatus).toBe("not_evaluated");
  });

  it("records raw provider text on decode failures only when opted in", async () => {
    const failing = {
      name: "failing-actor",
      act: () =>
        Promise.resolve({
          error: "actor_action_invalid",
          rawText: "```json\n{}\n```",
          latencyMs: 1,
        }),
    };
    const runWith = async (recordResponseText: boolean) =>
      runClosedLoop({
        config: { ...config, recordResponseText },
        tasks: [task],
        providers: { actor: failing },
      });
    const optedIn = await runWith(true);
    expect(optedIn.calls.find((call) => call.kind === "actor")?.responseText).toBe(
      "```json\n{}\n```",
    );
    const optedOut = await runWith(false);
    expect(optedOut.calls.find((call) => call.kind === "actor")?.responseText).toBeUndefined();
  });
});

describe("request evidence capture", () => {
  it("G-03: persisted records reconstruct the exact sent body with matching hash and bytes", async () => {
    const stub = stubClient({ model: "stub-model-1" });
    const { recorder, contexts, prompts } = collectingRecorder();
    const result = await runClosedLoop({
      config,
      tasks: [task],
      providers: { actor: new LiveActorProvider("stub/actor", stub.client) },
      recorder,
    });
    const calls = result.calls.filter((call) => call.kind === "actor" && call.providerInvoked);
    expect(calls.length).toBeGreaterThan(0);
    // The live provider reported the answering model; it is recorded, not assumed.
    expect(calls.every((call) => call.responseModel === "stub-model-1")).toBe(true);
    const promptByHash = new Map(prompts.map((record) => [record.hash, record.text]));
    for (const context of contexts) {
      const system = promptByHash.get(context.systemHash);
      expect(system, `system prompt ${context.systemHash} is persisted`).toBeDefined();
      // Rebuild the transport body purely from persisted evidence.
      const body = { system, messages: [{ role: "user", content: context.text! }] };
      const call = calls.find(
        (entry) => entry.trialId === context.trialId && entry.step === context.step,
      );
      expect(call, `call for ${context.trialId} step ${context.step}`).toBeDefined();
      const serialized = JSON.stringify(body);
      expect(createHash("sha256").update(serialized).digest("hex")).toBe(call!.requestHash);
      expect(Buffer.byteLength(serialized)).toBe(call!.requestBytes);
      // Local metadata and auth material are never part of the sent body.
      expect(Object.keys(body).sort()).toEqual(["messages", "system"]);
      expect(serialized).not.toMatch(/authorization|api[_-]?key|cookie/i);
    }
    // The stub actually received exactly the persisted system and user text.
    for (const sent of stub.received) {
      expect(prompts.some((record) => record.text === sent.system)).toBe(true);
      expect(contexts.some((context) => context.text === sent.user)).toBe(true);
    }
  });

  it("G-03: scoring results stay out of request evidence", async () => {
    const stub = stubClient();
    const { recorder, contexts } = collectingRecorder();
    const result = await runClosedLoop({
      config,
      tasks: [task],
      providers: { actor: new LiveActorProvider("stub/actor", stub.client) },
      recorder,
    });
    const serialized = JSON.stringify([...contexts, ...result.calls]);
    // Verdict strings exist only in scoring records, not in request evidence.
    for (const call of result.calls) expect(call).not.toHaveProperty("finalArtifact");
    expect(serialized).not.toContain("testPassed");
  });
});

describe("final evaluation safety", () => {
  const isolatedConfig: HybridConfig = {
    ...config,
    provider: { ...config.provider, executionIsolation: "required" },
  };

  it("G-05: unverified isolation blocks the final oracle pass entirely", async () => {
    let finalCalls = 0;
    const result = await runClosedLoop({
      config: isolatedConfig,
      tasks: [task],
      providers: { actor: new ScriptedActor(readLoop()) },
      isolationVerified: false,
      environmentFor: (taskArg, scoring, isolated) => {
        const env = new TaskEnvironment(taskArg, scoring, { isolated });
        const original = env.evaluateFinal.bind(env);
        return Object.assign(env, {
          evaluateFinal: () => {
            finalCalls++;
            return original();
          },
        });
      },
    });
    for (const score of result.summary.scores) {
      expect(score.finalArtifact).toMatchObject({
        status: "not_evaluated",
        reason: "isolation_unverified",
      });
      expect(Object.values(score.finalArtifact.tests)).toEqual(["not_run"]);
    }
    expect(finalCalls).toBe(0);
  });

  it("G-05: a corrupt workspace ends the trial with zero additional candidate runs", async () => {
    let finalCalls = 0;
    const result = await runClosedLoop({
      config,
      tasks: [task],
      providers: { actor: new ScriptedActor(readLoop()) },
      environmentFor: (taskArg, scoring, isolated) => {
        const env = new TaskEnvironment(taskArg, scoring, { isolated });
        return Object.assign(env, {
          execute: () => Promise.reject(new Error("workspace_corrupt")),
          evaluateFinal: () => {
            finalCalls++;
            return Promise.resolve([]);
          },
        });
      },
    });
    for (const score of result.summary.scores) {
      expect(score.failureReason).toMatch(/^environment_error:/);
      expect(score.terminationReason).toBe("environment_error");
      expect(score.finalArtifact).toMatchObject({
        status: "not_evaluated",
        reason: "environment_error",
      });
    }
    expect(finalCalls).toBe(0);
  });

  it("G-05: a writer failure aborts the run; later trials never execute", async () => {
    const actor = new ScriptedActor(readLoop());
    let writes = 0;
    const recorder: RunRecorder = {
      callStart: async () => {},
      call: async () => {},
      context: async () => {
        if (++writes >= 3) throw new Error("disk_full");
      },
      update: async () => {},
    };
    await expect(
      runClosedLoop({ config, tasks: [task], providers: { actor }, recorder }),
    ).rejects.toThrow(/persistence_failed/);
    // The failing record stopped the run mid-flight: fewer than the 16
    // requests two full trials would need ever reached the provider.
    expect(actor.requests.length).toBeLessThan(16);
  });

  it("G-05: a cancelled run marks trials cancelled and runs no candidate code", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runClosedLoop({
      config,
      tasks: [task],
      providers: { actor: new ScriptedActor(readLoop()) },
      signal: controller.signal,
    });
    expect(result.summary.scores).toHaveLength(0);
    expect(result.summary.skippedTrials).toHaveLength(2);
    expect(result.summary.skippedTrials.every((entry) => entry.reason === "cancelled")).toBe(true);
    expect(result.calls.filter((call) => call.providerInvoked)).toHaveLength(0);
  });
});

describe("frozen stage-a plan", () => {
  it("G-06: 18 trials at most 144 actor calls with identical budgets and zero update calls", async () => {
    const tasks: HybridTask[] = [0, 1, 2].map((index) => ({
      id: `task-${index}`,
      instruction: "update the file",
      files: { "src/x.ts": "old" },
      allowedTests: ["t"],
      expectedFiles: { "src/x.ts": "new" },
      steps: [{ action: { tool: "finish" }, result: "finish" }],
    }));
    const planConfig: HybridConfig = {
      ...config,
      iterations: 3,
      provider: { ...config.provider, maxRequests: 144 },
    };
    const actor = new ScriptedActor((request) => {
      const budget = JSON.parse(request.user).action_budget;
      expect(budget.limit).toBe(8);
      expect(budget.finish_counts_as_action).toBe(true);
      return { action: { tool: "finish" } };
    });
    const jev = new FakeJevProvider();
    const repair = new FakeRepairProvider();
    const result = await runClosedLoop({
      config: planConfig,
      tasks,
      providers: { jev, repair, actor },
    });
    expect(result.summary.plannedTrials).toBe(18);
    expect(result.summary.scores).toHaveLength(18);
    expect(actor.requests.length).toBe(18);
    expect(actor.requests.length).toBeLessThanOrEqual(144);
    // Stage A runs actor calls only: no jev, repair, or separate update call.
    const kinds = new Set(result.calls.map((call) => call.kind));
    expect(kinds).toEqual(new Set(["actor"]));
    // Both modes see the identical budget contract.
    for (const request of actor.requests)
      expect(JSON.parse(request.user).action_budget).toMatchObject({ limit: 8 });
  });
});
