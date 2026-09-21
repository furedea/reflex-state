import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  LiveActorProvider,
  type ActorProvider,
  type CompletionClient,
} from "./providers.js";
import { runClosedLoop, type RunRecorder } from "./runner.js";
import { TaskEnvironment } from "./task_environment.js";
import type {
  ActorRequest,
  ActorResponse,
  CallRecord,
  CallStartRecord,
  ContextRecord,
  HybridConfig,
  HybridTask,
  SystemPromptRecord,
  UpdateRecord,
} from "./types.js";

const config: HybridConfig = {
  schemaVersion: 2,
  evaluation: "closed_loop",
  provider: {
    mode: "fake",
    jevModel: "fake",
    actorModel: "fake",
    repairModel: "fake",
    maxRequests: 100,
    trialMaxRequests: 32,
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
  modes: ["history", "llm"],
  seed: 1,
  iterations: 1,
  recordContextText: true,
  recordResponseText: false,
  candidateMaxBytes: 4096,
};

const task: HybridTask = {
  id: "test-task",
  instruction: "update the file",
  files: { "src/x.ts": "old" },
  allowedTests: ["test-task"],
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
    { action: { tool: "test", command: "test-task" }, result: "test" },
    { action: { tool: "finish" }, result: "finish" },
  ],
};

/** Step-indexed actor whose responses can depend on the request it actually
 * received (e.g. on the previous step's update feedback). */
class ScriptedActor implements ActorProvider {
  readonly name = "scripted-actor";
  private readonly indexes = new Map<string, number>();
  readonly requests: ActorRequest[] = [];

  constructor(private readonly respond: (request: ActorRequest, step: number) => ActorResponse) {}

  act(request: ActorRequest): Promise<ActorResponse> {
    this.requests.push(request);
    const key = request.trialId ?? request.mode;
    const step = this.indexes.get(key) ?? 0;
    this.indexes.set(key, step + 1);
    return Promise.resolve(this.respond(request, step));
  }
}

/** Every step reads a file until the action budget runs out — the actor never
 * finishes on its own. */
function readLoop(path = "src/x.ts") {
  return () => ({ action: { tool: "read" as const, path } });
}

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

describe("follow-up protocol: update feedback, budget, and final artifact", () => {
  it("L-03: a partially invalid patch applies the valid op, records the drop, and notifies the next step", async () => {
    const actor = new ScriptedActor((request, step) => {
      if (request.mode !== "llm") return { action: { tool: "finish" } };
      if (step === 0)
        return {
          action: { tool: "read", path: "src/x.ts" },
          statePatch: [
            {
              operation: "add",
              kind: "findings",
              text: "saved note",
              sourceIds: ["self"],
              trust: "assistant",
              origin: "generated",
            },
            {
              operation: "add",
              kind: "findings",
              text: "unsaved claim",
              sourceIds: ["nonexistent-source"],
              trust: "tool_result",
              origin: "extracted",
            },
          ],
          text: "saved note",
        };
      return { action: { tool: "finish" }, statePatch: [] };
    });
    const result = await runClosedLoop({ config, tasks: [task], providers: { actor } });
    const score = result.summary.scores.find((entry) => entry.mode === "llm");
    expect(score?.executionStatus).toBe("completed");
    // A completed trial with dropped operations is not "zero update issues":
    // wiring stays passed while patchStats keeps the rejection visible.
    expect(score?.wiringStatus).toBe("passed");
    expect(score?.patchStats).toMatchObject({ proposed: 2, applied: 1, rejected: 1 });
    const update = result.updates.find(
      (record) => record.mode === "llm" && record.source === "actor_patch",
    );
    expect(update?.patchInput).toBe("present");
    expect(update?.dropped).toEqual(["missing_source:nonexistent-source#1"]);
    const second = actor.requests.filter((request) => request.mode === "llm")[1];
    const payload = JSON.parse(second!.user);
    expect(payload.last_update_result).toMatchObject({
      patch_input: "present",
      applied_count: 1,
      rejected_count: 1,
      rejected: [{ index: 1, reason: "missing_source:nonexistent-source" }],
    });
    expect(payload.last_update_result.applied[0].index).toBe(0);
    expect(JSON.stringify(payload.memory)).toContain("saved note");
    expect(JSON.stringify(payload.memory)).not.toContain("unsaved claim");
  });

  it("L-04: a valid-but-duplicate op is unchanged, never counted as applied", async () => {
    const finding = {
      operation: "add" as const,
      kind: "findings" as const,
      text: "same finding",
      sourceIds: ["self"],
      trust: "assistant" as const,
      origin: "generated" as const,
    };
    const actor = new ScriptedActor((request, step) => {
      if (request.mode !== "llm") return { action: { tool: "finish" } };
      if (step === 0)
        return {
          action: { tool: "read", path: "src/x.ts" },
          statePatch: [finding],
          text: "same finding",
        };
      if (step === 1)
        return {
          action: { tool: "read", path: "src/x.ts" },
          statePatch: [{ ...finding }],
          text: "same finding",
        };
      return { action: { tool: "finish" }, statePatch: [] };
    });
    const result = await runClosedLoop({ config, tasks: [task], providers: { actor } });
    const score = result.summary.scores.find((entry) => entry.mode === "llm");
    expect(score?.patchStats).toMatchObject({ proposed: 2, applied: 1, unchanged: 1 });
    const second = JSON.parse(actor.requests.filter((request) => request.mode === "llm")[2]!.user);
    expect(second.last_update_result).toMatchObject({
      patch_input: "present",
      applied_count: 0,
      unchanged_count: 1,
      rejected_count: 0,
      unchanged: [0],
    });
  });

  it("L-05: the update notification covers only the previous step and stays under its cap", async () => {
    const rejected = Array.from({ length: 60 }, (_, index) => ({
      operation: "add" as const,
      kind: "findings" as const,
      text: `claim ${index}`,
      sourceIds: [`missing-${index}`],
      trust: "tool_result" as const,
      origin: "extracted" as const,
    }));
    const actor = new ScriptedActor((request, step) => {
      if (request.mode !== "llm") return { action: { tool: "finish" } };
      if (step === 0) return { action: { tool: "read", path: "src/x.ts" }, statePatch: rejected };
      if (step === 1)
        return {
          action: { tool: "read", path: "src/x.ts" },
          statePatch: [
            {
              operation: "add",
              kind: "findings",
              text: "fresh",
              sourceIds: ["self"],
              trust: "assistant",
              origin: "generated",
            },
          ],
          text: "fresh",
        };
      return { action: { tool: "finish" }, statePatch: [] };
    });
    const result = await runClosedLoop({ config, tasks: [task], providers: { actor } });
    const requests = actor.requests.filter((request) => request.mode === "llm");
    const step1 = JSON.parse(requests[1]!.user).last_update_result;
    expect(step1.patch_input).toBe("present");
    expect(step1.rejected_count).toBe(60);
    expect(step1.rejected.length).toBeLessThan(60);
    expect(step1.omitted_detail_count).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(step1), "utf8")).toBeLessThanOrEqual(2048);
    // Step 2 reports only step 1's outcome — earlier results never accumulate.
    const step2 = JSON.parse(requests[2]!.user).last_update_result;
    expect(step2).toMatchObject({
      patch_input: "present",
      applied_count: 1,
      rejected_count: 0,
    });
    expect(JSON.stringify(JSON.parse(requests[2]!.user).memory)).toContain("fresh");
    const context = result.contexts.find((record) => record.mode === "llm" && record.step === 1);
    expect(context?.bytes.feedback).toBeGreaterThan(0);
  });

  it("L-06: both modes see identical remaining budgets and no ninth actor call happens", async () => {
    const actor = new ScriptedActor(readLoop());
    await runClosedLoop({ config, tasks: [task], providers: { actor } });
    for (const mode of ["history", "llm"] as const) {
      const requests = actor.requests.filter((request) => request.mode === mode);
      expect(requests).toHaveLength(8);
      requests.forEach((request, step) => {
        expect(JSON.parse(request.user).action_budget).toEqual({
          limit: 8,
          used: step,
          remaining_including_next: 8 - step,
          finish_counts_as_action: true,
        });
      });
    }
  });

  it("L-08: verified-but-unfinished scores the artifact without crediting a finish", async () => {
    const actor = new ScriptedActor((request, step) =>
      step === 0
        ? { action: { tool: "write", path: "src/x.ts", content: "new" } }
        : step === 1
          ? { action: { tool: "test", command: "test-task" } }
          : { action: { tool: "read", path: "src/x.ts" } },
    );
    const result = await runClosedLoop({ config, tasks: [task], providers: { actor } });
    for (const score of result.summary.scores) {
      expect(score.completed).toBe(false);
      expect(score.finishedWithinBudget).toBe(false);
      expect(score.terminationReason).toBe("action_budget");
      expect(score.executionStatus).toBe("incomplete");
      expect(score.finalArtifact).toMatchObject({
        status: "evaluated",
        tests: { "test-task": "passed" },
      });
      expect(score.actorVerificationAtStop["test-task"]).toMatchObject({
        status: "passed",
        freshness: "current",
      });
      expect(score.testPassed).toBe(false);
    }
  });

  it("L-09: a correct artifact without actor verification keeps actor not_run", async () => {
    const actor = new ScriptedActor((request, step) =>
      step === 0
        ? { action: { tool: "write", path: "src/x.ts", content: "new" } }
        : { action: { tool: "read", path: "src/x.ts" } },
    );
    const result = await runClosedLoop({ config, tasks: [task], providers: { actor } });
    for (const score of result.summary.scores) {
      expect(score.finalArtifact.tests["test-task"]).toBe("passed");
      expect(score.actorVerificationAtStop["test-task"]?.status).toBe("not_run");
      expect(score.finishedWithinBudget).toBe(false);
    }
  });

  it("L-10: a change after the actor's passing test keeps the stale flag", async () => {
    const multi: HybridTask = {
      id: "multi-file",
      instruction: "update the file",
      files: { "src/x.ts": "old", "src/y.ts": "keep" },
      allowedTests: ["test-task"],
      expectedFiles: { "src/x.ts": "new" },
    };
    const actor = new ScriptedActor((request, step) =>
      step === 0
        ? { action: { tool: "write", path: "src/x.ts", content: "new" } }
        : step === 1
          ? { action: { tool: "test", command: "test-task" } }
          : step === 2
            ? { action: { tool: "write", path: "src/y.ts", content: "changed" } }
            : { action: { tool: "read", path: "src/y.ts" } },
    );
    const result = await runClosedLoop({ config, tasks: [multi], providers: { actor } });
    for (const score of result.summary.scores) {
      // The final artifact still satisfies the declared expectation, while the
      // actor's own verification is stale and is never rewritten to current.
      expect(score.finalArtifact.tests["test-task"]).toBe("passed");
      expect(score.actorVerificationAtStop["test-task"]).toMatchObject({
        status: "passed",
        freshness: "stale",
      });
    }
  });

  it("L-11: a wrong artifact fails the final oracle and an oracle-less task reports not evaluated", async () => {
    const actor = new ScriptedActor((request, step) =>
      step === 0
        ? { action: { tool: "write", path: "src/x.ts", content: "wrong" } }
        : { action: { tool: "read", path: "src/x.ts" } },
    );
    const result = await runClosedLoop({ config, tasks: [task], providers: { actor } });
    for (const score of result.summary.scores) {
      expect(score.finalArtifact).toMatchObject({
        status: "evaluated",
        tests: { "test-task": "failed" },
      });
      expect(score.finishedWithinBudget).toBe(false);
    }
    // A task whose declared tests have no oracle is never silently scored.
    const unevaluable: HybridTask = {
      id: "no-oracle",
      instruction: "update the file",
      files: { "src/x.ts": "old" },
      allowedTests: ["test-task"],
    };
    const second = await runClosedLoop({
      config,
      tasks: [unevaluable],
      providers: { actor: new ScriptedActor(readLoop()) },
    });
    for (const score of second.summary.scores)
      expect(score.finalArtifact).toMatchObject({
        status: "not_evaluated",
        reason: "no_oracle_verdict",
      });
  });

  it("L-12: fake runs keep efficacy not_evaluated while patch and artifact fields stay separate", async () => {
    const result = await runClosedLoop({
      config,
      tasks: [task],
      providers: { actor: new FakeActorProvider([task]) },
    });
    expect(result.summary.efficacyStatus).toBe("not_evaluated");
    const llm = result.summary.scores.find((score) => score.mode === "llm");
    const history = result.summary.scores.find((score) => score.mode === "history");
    expect(llm?.wiringStatus).toBe("passed");
    expect(llm?.patchStats.proposed).toBeGreaterThan(0);
    expect(llm?.patchStats.applied).toBeGreaterThan(0);
    expect(llm?.finishedWithinBudget).toBe(true);
    expect(llm?.terminationReason).toBe("finish");
    expect(llm?.finalArtifact.tests["test-task"]).toBe("passed");
    // History mode never carries patch accounting.
    expect(history?.patchStats.proposed).toBe(0);
    expect(history?.patchStats.applied).toBe(0);
    expect(JSON.parse(actor1stLlmUser(result)).last_update_result).toBeNull();
  });

  it("L-15: the sent request carries feedback and budget but never scoring internals", async () => {
    const scoringTask: HybridTask = {
      id: "secret-task",
      instruction: "update the file",
      files: { "src/x.ts": "old" },
      allowedTests: ["test-task"],
      expectedFiles: { "src/x.ts": "EXPECTED_ANSWER_9f3c" },
    };
    const scoring = new Map([
      [
        "secret-task",
        {
          taskId: "secret-task",
          checkpoints: [
            {
              id: "cp-secret-marker",
              at: "final" as const,
              required: [
                {
                  id: "req-secret-marker",
                  kind: "exact_value" as const,
                  value: "EXPECTED_ANSWER_9f3c",
                  markers: ["EXPECTED_ANSWER_9f3c"],
                },
              ],
            },
          ],
        },
      ],
    ]);
    const actor = new ScriptedActor(readLoop());
    const result = await runClosedLoop({
      config,
      tasks: [scoringTask],
      scoring,
      providers: { actor },
    });
    for (const request of actor.requests) {
      const payload = JSON.parse(request.user);
      expect(payload.action_budget).toMatchObject({ limit: 8, finish_counts_as_action: true });
      if (request.mode === "llm") expect(payload).toHaveProperty("last_update_result");
      const wire = `${request.system}\n${request.user}`;
      for (const secret of [
        "EXPECTED_ANSWER_9f3c",
        "cp-secret-marker",
        "req-secret-marker",
        "checkpoint",
        "oracle",
      ])
        expect(wire).not.toContain(secret);
    }
    // The recorded request hash is the hash of the exact sent body.
    const call = result.calls.find((entry) => entry.kind === "actor" && entry.providerInvoked);
    expect(call?.requestBytes).toBeGreaterThan(0);
  });

  it("L-16: the actor can read the rejection and correct its patch on the next step", async () => {
    const actor = new ScriptedActor((request, step) => {
      if (request.mode !== "llm") return { action: { tool: "finish" } };
      const feedback = JSON.parse(request.user).last_update_result;
      if (step === 0)
        return {
          action: { tool: "read", path: "src/x.ts" },
          statePatch: [
            {
              operation: "add",
              kind: "findings",
              text: "bad claim",
              sourceIds: ["ghost-source"],
              trust: "tool_result",
              origin: "extracted",
            },
          ],
        };
      // The corrected proposal is only sent when the rejection was reported;
      // a script that ignored the notification would finish instead.
      if (feedback?.rejected_count > 0)
        return {
          action: { tool: "read", path: "src/x.ts" },
          statePatch: [
            {
              operation: "add",
              kind: "findings",
              text: "corrected finding",
              sourceIds: ["self"],
              trust: "assistant",
              origin: "generated",
            },
          ],
          text: "corrected finding",
        };
      return { action: { tool: "finish" }, statePatch: [] };
    });
    const result = await runClosedLoop({ config, tasks: [task], providers: { actor } });
    const score = result.summary.scores.find((entry) => entry.mode === "llm");
    expect(score?.patchStats).toMatchObject({ proposed: 2, applied: 1, rejected: 1 });
    const last = JSON.parse(
      actor.requests.filter((request) => request.mode === "llm").at(-1)!.user,
    );
    expect(JSON.stringify(last.memory)).toContain("corrected finding");
    expect(JSON.stringify(last.memory)).not.toContain("bad claim");
  });
});

/** Recorder that keeps every persisted record in memory for assertions. */
function collectingRecorder() {
  const calls: (CallStartRecord | CallRecord)[] = [];
  const contexts: ContextRecord[] = [];
  const updates: UpdateRecord[] = [];
  const prompts: SystemPromptRecord[] = [];
  const recorder: RunRecorder = {
    callStart: async (record) => void calls.push(record),
    call: async (record) => void calls.push(record),
    context: async (record) => void contexts.push(record),
    update: async (record) => void updates.push(record),
    prompt: async (record) => void prompts.push(record),
  };
  return { recorder, calls, contexts, updates, prompts };
}

/** Completion stub: never touches a network, returns a fixed actor payload. */
function stubClient(over?: { model?: string }): {
  readonly client: CompletionClient;
  readonly received: { system: string; user: string; model: string }[];
} {
  const received: { system: string; user: string; model: string }[] = [];
  return {
    received,
    client: {
      complete: async (request) => {
        received.push(request);
        return {
          text: JSON.stringify({ action: { tool: "finish" } }),
          ...(over?.model ? { model: over.model } : {}),
        };
      },
    },
  };
}

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

/** The first llm request's user payload text for a run, as JSON. */
function actor1stLlmUser(result: {
  readonly contexts: readonly { mode: string; step: number; text?: string }[];
}): string {
  const context = result.contexts.find((record) => record.mode === "llm" && record.step === 0);
  return context?.text ?? "{}";
}
