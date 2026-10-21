import { describe, expect, it } from "vitest";

import { FakeActorProvider } from "./providers.js";
import { runClosedLoop } from "./runner.js";
import { config, ScriptedActor, task, readLoop } from "./runner_test_support.js";
import type { HybridTask } from "./types.js";

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

/** The first llm request's user payload text for a run, as JSON. */
function actor1stLlmUser(result: {
  readonly contexts: readonly { mode: string; step: number; text?: string }[];
}): string {
  const context = result.contexts.find((record) => record.mode === "llm" && record.step === 0);
  return context?.text ?? "{}";
}
