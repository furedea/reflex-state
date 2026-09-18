import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadHybridConfig, ResultWriter } from "./cli.js";
import { buildProjection } from "./projection.js";
import { buildActorRequest } from "./prompts.js";
import {
  decodeActorResponse,
  decodeAnswers,
  FakeActorProvider,
  InputDependentActorProvider,
  LiveActorProvider,
  readRecordedProviders,
  requestHash,
  sentRequestBody,
  type CompletionClient,
} from "./providers.js";
import { runClosedLoop } from "./runner.js";
import { safePath, TaskEnvironment } from "./task_environment.js";
import type { ActorRequest, HybridConfig, HybridTask, JevQuestion, TraceMessage } from "./types.js";
import { emptyMemory, emptyUsage, parseHybridConfig } from "./types.js";
import { applyOperations, initialFacts } from "./update.js";

const budgets = {
  memoryBytes: 8192,
  factsBytes: 4096,
  latestObservationBytes: 8192,
  requestBytes: 24000,
  maxQuestions: 8,
  maxRepairCalls: 1,
  maxActions: 8,
} as const;

function config(overrides: Partial<HybridConfig> = {}): HybridConfig {
  return {
    schemaVersion: 2,
    evaluation: "closed_loop",
    provider: {
      mode: "fake",
      actorModel: "fake",
      maxRequests: 100,
      trialMaxRequests: 32,
      timeoutMs: 1000,
    },
    budgets,
    modes: ["history", "llm"],
    seed: 1,
    iterations: 1,
    recordContextText: true,
    candidateMaxBytes: 4096,
    ...overrides,
  };
}

const task: HybridTask = {
  id: "acc-task",
  instruction: "update the file",
  files: { "src/x.ts": "old" },
  allowedTests: ["acc-test"],
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
    { action: { tool: "test", command: "acc-test" }, result: "test" },
    { action: { tool: "finish" }, result: "finish" },
  ],
};

function actorRequest(overrides: Partial<ActorRequest> = {}): ActorRequest {
  return {
    ...buildActorRequest({
      mode: "history",
      taskId: "acc-task",
      trialId: "trial-1",
      step: 0,
      userText: '{"instruction":"task"}',
      allowedTests: ["acc-test"],
      model: "fake",
    }),
    ...overrides,
  };
}

function message(id: string, text: string): TraceMessage {
  return { id, role: "tool_result", text, sequence: 0, sourceId: id, truncated: false };
}

describe("acceptance: provider communication contract", () => {
  it("C1: the actor wire body is the ModelRuntime.complete shape without local metadata", () => {
    const request = actorRequest();
    const body = sentRequestBody("actor", request) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["messages", "system"]);
    expect(body.system).toBe(request.system);
    expect(body.messages).toEqual([{ role: "user", content: request.user }]);
    const serialized = JSON.stringify(body);
    for (const local of ["trialId", "taskId", "step", "mode", "allowedTools"])
      expect(serialized).not.toContain(local);
    expect(requestHash("actor", request)).toBe(
      createHash("sha256").update(serialized).digest("hex"),
    );
  });

  it("C2: missing usage stays absent while measured zeros are preserved", async () => {
    const client = (usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }): CompletionClient => ({
      complete: () =>
        Promise.resolve({
          text: '{"action":{"tool":"finish"}}',
          ...(usage ? { usage } : {}),
        }),
    });
    const provider = new LiveActorProvider("model", client());
    const missing = await provider.act(actorRequest());
    expect(missing.error).toBeUndefined();
    expect("usage" in missing).toBe(false);
    const measured = await new LiveActorProvider(
      "model",
      client({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).act(actorRequest());
    expect(measured.usage?.inputTokens).toBe(0);
    expect(emptyUsage().inputTokens).toBeNull();
    expect(emptyUsage().inputTokens).not.toBe(0);
  });

  it("C3: the actor response is one JSON object with action plus optional state patch", () => {
    const decoded = decodeActorResponse(
      JSON.stringify({
        action: { tool: "write", path: "a.ts", content: "x" },
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
        text: "done",
      }),
      "llm",
    );
    expect(decoded.action.tool).toBe("write");
    expect(decoded.statePatch).toHaveLength(1);
    expect(decoded.text).toBe("done");
    expect(() => decodeActorResponse('{"action":{"tool":"finish"}}', "llm")).toThrow(
      "actor_state_patch_missing",
    );
    expect(() => decodeActorResponse('{"action":{"tool":"shell"}}', "history")).toThrow(
      "actor_action_invalid",
    );
    expect(decodeActorResponse('{"action":{"tool":"finish"}}', "history").action.tool).toBe(
      "finish",
    );
  });

  it("C4: Jev answers decode per question with invalid entries marked, never fabricated", () => {
    const questions: JevQuestion[] = [
      {
        id: "q1",
        kind: "choice",
        prompt: "keep?",
        options: { "keep-a": "keep it", "drop-a": "drop it" },
        candidateIds: ["c1"],
        evidence: ["m1"],
      },
      {
        id: "q2",
        kind: "choice",
        prompt: "keep?",
        options: { "keep-b": "keep it" },
        candidateIds: ["c2"],
        evidence: ["m2"],
      },
    ];
    const answers = decodeAnswers(
      {
        answers: {
          q1: {
            choice: "keep-a",
            confidence: 0.8,
            probabilities: { "keep-a": 0.8, "drop-a": 0.2 },
          },
          q2: { choice: "keep-b", confidence: "high" },
        },
      },
      questions,
    );
    expect(answers[0]).toMatchObject({
      questionId: "q1",
      choice: "keep-a",
      probability: 0.8,
      confidence: 0.8,
    });
    expect(answers[1]?.invalid).toBeDefined();
  });

  it("C5: recorded providers replay only the call bound to kind, trial, step, and request hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hybrid-recorded-"));
    try {
      const request = actorRequest();
      const file = join(directory, "calls.json");
      await writeFile(
        file,
        JSON.stringify({
          calls: [
            {
              kind: "actor",
              trialId: "trial-1",
              step: 0,
              requestHash: requestHash("actor", request),
              response: { action: { tool: "finish" } },
            },
          ],
        }),
      );
      const providers = await readRecordedProviders(file);
      const hit = await providers.actor?.act(request);
      expect(hit?.action?.tool).toBe("finish");
      const miss = await providers.actor?.act({ ...request, step: 1 });
      expect(miss?.error).toBe("recorded_response_missing");
      const changed = await providers.actor?.act({ ...request, user: "different" });
      expect(changed?.error).toBe("recorded_response_missing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("C6: exhausted request budgets record sent:false instead of pretending a call happened", async () => {
    const result = await runClosedLoop({
      config: config({
        provider: {
          mode: "fake",
          actorModel: "fake",
          maxRequests: 1,
          trialMaxRequests: 1,
          timeoutMs: 1000,
        },
        modes: ["history"],
      }),
      tasks: [task],
      providers: { actor: new FakeActorProvider([task]) },
    });
    const blocked = result.calls.filter((call) => !call.sent);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((call) => call.error?.startsWith("not_sent"))).toBe(true);
    expect(blocked.every((call) => call.attempts === 0 && call.latencyMs === null)).toBe(true);
    expect(result.summary.scores[0]?.executionStatus).toBe("incomplete");
    expect(result.summary.scores[0]?.failureReason).toBe("request_limit");
  });
});

describe("acceptance: state, environment, and evaluation", () => {
  it("E1: extracted operations must match cited source text and generated ones need approval", () => {
    const context = {
      candidates: [],
      observations: [message("obs-1", "the cited text")],
      allowGenerated: false,
      now: 0,
      extraSourceIds: ["src-1"],
      extraSources: [
        {
          id: "src-1",
          role: "tool_result" as const,
          text: "the cited text",
          trust: "tool_result" as const,
        },
      ],
    };
    const extracted = {
      operation: "add" as const,
      kind: "findings" as const,
      text: "the cited text",
      sourceIds: ["src-1"],
      trust: "tool_result" as const,
      origin: "extracted" as const,
    };
    expect(applyOperations(emptyMemory(), [extracted], context).ok).toBe(true);
    const mismatch = applyOperations(
      emptyMemory(),
      [{ ...extracted, text: "invented text" }],
      context,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.errors[0]).toContain("extracted_text_mismatch");
    const generated = applyOperations(
      emptyMemory(),
      [{ ...extracted, text: "judgment", origin: "generated" as const }],
      context,
    );
    expect(generated.ok).toBe(false);
    const allowed = applyOperations(
      emptyMemory(),
      [
        {
          operation: "add" as const,
          kind: "findings" as const,
          text: "judgment",
          sourceIds: ["resp-1"],
          trust: "assistant" as const,
          origin: "generated" as const,
        },
      ],
      {
        ...context,
        allowGenerated: true,
        extraSourceIds: ["resp-1"],
        extraSources: [{ id: "resp-1", role: "assistant", text: "visible", trust: "assistant" }],
      },
    );
    expect(allowed.ok).toBe(true);
  });

  it("E2: an oversized latest observation group is reported unavailable, never split", () => {
    const group = [message("g1", "x".repeat(4000)), message("g2", "y".repeat(6000))];
    const projected = buildProjection({
      mode: "llm",
      instruction: "task",
      facts: initialFacts(),
      memory: emptyMemory(),
      latest: group,
      history: [],
      budgets: { ...budgets, latestObservationBytes: 500 },
    });
    expect(projected.bundle.unavailable).toBe("latest_observation_exceeds_budget");
  });

  it("E3: Stage A compares history and llm through identical single actor calls with no Jev", async () => {
    const result = await runClosedLoop({
      config: config(),
      tasks: [task],
      providers: { actor: new FakeActorProvider([task]) },
    });
    expect(result.summary.modes).toEqual(["history", "llm"]);
    expect(result.calls.every((call) => call.kind === "actor")).toBe(true);
    const history = result.contexts.filter((record) => record.mode === "history");
    const llm = result.contexts.filter((record) => record.mode === "llm");
    expect(history.every((record) => record.included.includes("history"))).toBe(true);
    expect(llm.every((record) => !record.included.includes("history"))).toBe(true);
    expect(result.updates.some((record) => record.mode === "llm" && record.kind === "update")).toBe(
      true,
    );
  });

  it("E4: a fake provider run reports efficacy as not evaluated", async () => {
    const result = await runClosedLoop({
      config: config(),
      tasks: [task],
      providers: { actor: new FakeActorProvider([task]) },
    });
    expect(result.summary.efficacyStatus).toBe("not_evaluated");
    expect(result.summary.scores.every((score) => score.efficacyStatus === "not_evaluated")).toBe(
      true,
    );
  });

  it("E5: the task environment rejects path escapes and unlisted test ids", async () => {
    expect(safePath("../evil")).toBe(false);
    expect(safePath("/abs")).toBe(false);
    expect(safePath("a\\b")).toBe(false);
    expect(safePath("src/ok.ts")).toBe(true);
    const env = new TaskEnvironment(task, undefined, { isolated: false });
    const escape = await env.execute({ tool: "write", path: "../evil", content: "x" });
    expect(escape.violation).toBe("path_escape");
    const denied = await env.execute({ tool: "test", command: "other-test" });
    expect(denied.violation).toBe("test_not_allowed");
  });

  it("E6: live preflight and output reservation fail before any execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hybrid-out-"));
    try {
      await ResultWriter.reserve(join(directory, "run"));
      await expect(ResultWriter.reserve(join(directory, "run"))).rejects.toThrow("already exists");
      const livePath = join(directory, "live.json");
      await writeFile(
        livePath,
        JSON.stringify({
          schemaVersion: 2,
          evaluation: "closed_loop",
          provider: {
            mode: "live",
            actorModel: "anthropic/test",
            maxRequests: 8,
            timeoutMs: 1000,
          },
          budgets,
          modes: ["history", "llm"],
          seed: 0,
          recordContextText: false,
          candidateMaxBytes: 4096,
        }),
      );
      await expect(loadHybridConfig(livePath, "run", false)).rejects.toThrow("--live");
      await expect(
        loadHybridConfig("experiments/hybrid-state/config.offline.json", "audit", true),
      ).rejects.toThrow("--live");
      expect(() =>
        parseHybridConfig({
          schemaVersion: 2,
          evaluation: "closed_loop",
          provider: { mode: "live", maxRequests: 8, timeoutMs: 1000 },
          budgets,
          modes: ["history"],
          seed: 0,
          recordContextText: false,
          candidateMaxBytes: 4096,
        }),
      ).toThrow("actorModel");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("F1: the input-dependent fake detects providers that ignore the sent input", async () => {
    const provider = new InputDependentActorProvider([task], ["update the file"]);
    const missing = await provider.act(actorRequest({ user: "unrelated content" }));
    expect(missing.text).toContain("missing:");
    const present = await provider.act(actorRequest({ user: "please update the file now" }));
    expect(present.action).toEqual(task.steps?.[0]?.action);
    expect(present.text).toBeUndefined();
  });
});
