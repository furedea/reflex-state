import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { actorRequest, budgets, config, message, task } from "./acceptance_fixtures.js";
import { buildProjection } from "./projection.js";
import { buildActorRequest } from "./prompts.js";
import {
  decodeActorResponse,
  decodeAnswers,
  FakeActorProvider,
  LiveActorProvider,
  readRecordedProviders,
  requestHash,
  sentRequestBody,
  type CompletionClient,
} from "./providers.js";
import { runClosedLoop } from "./runner.js";
import type { JevQuestion } from "./types.js";
import { emptyMemory, emptyUsage } from "./types.js";
import { initialFacts } from "./update.js";

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
    // A missing patch decodes as no update; malformed patches still fail.
    expect(decodeActorResponse('{"action":{"tool":"finish"}}', "llm").statePatch).toEqual([]);
    expect(() =>
      decodeActorResponse('{"action":{"tool":"finish"},"statePatch":"oops"}', "llm"),
    ).toThrow("operations_not_array");
    expect(() => decodeActorResponse('{"action":{"tool":"shell"}}', "history")).toThrow(
      "actor_action_invalid",
    );
    expect(decodeActorResponse('{"action":{"tool":"finish"}}', "history").action.tool).toBe(
      "finish",
    );
  });

  it("C3b: the actor response decodes the first JSON object amid prose, fences, and extras", () => {
    const action = '{"action":{"tool":"finish"}}';
    for (const wrapped of [
      `Here is my answer:\n${action}\nDone.`,
      `\`\`\`json\n${action}\n\`\`\``,
      `${action}\n{"extra": true}`,
      `{"action":{"tool":"read","path":"src/{weird}.ts"}} extra text`,
    ])
      expect(decodeActorResponse(wrapped, "history").action.tool).not.toBeUndefined();
    expect(
      decodeActorResponse('prefix {"action":{"tool":"finish"}} suffix {"a":1}', "history").action
        .tool,
    ).toBe("finish");
    expect(() => decodeActorResponse("no json at all", "history")).toThrow("response_invalid_json");
    expect(() => decodeActorResponse('{"action":{"tool":"finish"', "history")).toThrow(
      "response_invalid_json",
    );
    // The shorthand forms `{"action":"read","path":...}` and a bare
    // `{"tool":...}` normalize to the same validated action; unknown tools
    // still fail.
    const shorthand = decodeActorResponse('{"action":"read","path":"src/calc.js"}', "history");
    expect(shorthand.action).toEqual({ tool: "read", path: "src/calc.js" });
    const bare = decodeActorResponse('{"tool":"read","path":"src/calc.js"}', "history");
    expect(bare.action).toEqual({ tool: "read", path: "src/calc.js" });
    const withPatch = decodeActorResponse(
      '{"action":"test","command":"t1","statePatch":[]}',
      "llm",
    );
    expect(withPatch.action).toEqual({ tool: "test", command: "t1" });
    expect(() => decodeActorResponse('{"action":"shell","path":"x"}', "history")).toThrow(
      "actor_action_invalid",
    );
  });

  it("C3c: a failed decode keeps the raw provider text for recording", async () => {
    const client: CompletionClient = {
      complete: () => Promise.resolve({ text: "```json\n{}\n```\nextra" }),
    };
    const provider = new LiveActorProvider("model", client);
    const response = await provider.act(actorRequest());
    expect(response.error).toBe("actor_action_invalid");
    expect(response.rawText).toBe("```json\n{}\n```\nextra");
  });

  it("L-01: the llm system prompt carries no task-specific answers or policies", () => {
    const system = buildActorRequest({
      mode: "llm",
      taskId: "any",
      trialId: "t",
      step: 0,
      userText: "{}",
      allowedTests: [],
      model: "fake",
    }).system;
    for (const leaked of [
      "FALLBACK_PORT",
      "PRIMARY_PORT",
      "8080",
      "9377",
      "apiKey",
      "maxRetries",
      "src/calc.js",
      "src/config.js",
      "src/server.js",
      "net-policy",
      "ports.conf",
    ])
      expect(system).not.toContain(leaked);
    // The prompt still explains the patch contract without task content.
    expect(system).toContain("statePatch");
    // Real observed values still flow through the per-step input as usual.
    const observed = buildProjection({
      mode: "llm",
      instruction: "task",
      facts: initialFacts(),
      memory: emptyMemory(),
      latest: [message("obs-1", "PRIMARY_PORT=9377")],
      history: [],
      actionBudget: {
        limit: 8,
        used: 0,
        remaining_including_next: 8,
        finish_counts_as_action: true,
      },
      budgets,
    });
    expect(observed.userText).toContain("PRIMARY_PORT=9377");
  });

  it("L-02: missing, empty, and present patches stay distinct; malformed ones fail", () => {
    const missing = decodeActorResponse('{"action":{"tool":"finish"}}', "llm");
    expect(missing.patchInput).toBe("missing");
    expect(missing.statePatch).toEqual([]);
    const empty = decodeActorResponse('{"action":{"tool":"finish"},"statePatch":[]}', "llm");
    expect(empty.patchInput).toBe("empty");
    const present = decodeActorResponse(
      JSON.stringify({
        action: { tool: "finish" },
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
      }),
      "llm",
    );
    expect(present.patchInput).toBe("present");
    expect(present.statePatch).toHaveLength(1);
    // A malformed patch is an error, never a silent empty patch.
    expect(() =>
      decodeActorResponse('{"action":{"tool":"finish"},"statePatch":"oops"}', "llm"),
    ).toThrow("operations_not_array");
    // Action surface forms are recorded, not silently normalized away.
    expect(decodeActorResponse('{"action":{"tool":"finish"}}', "llm").actionForm).toBe("canonical");
    expect(decodeActorResponse('{"action":"read","path":"x"}', "llm").actionForm).toBe("shorthand");
    expect(decodeActorResponse('{"tool":"read","path":"x"}', "llm").actionForm).toBe("bare");
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
    const blocked = result.calls.filter((call) => !call.providerInvoked);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((call) => call.error?.startsWith("not_sent"))).toBe(true);
    expect(blocked.every((call) => call.attempts === 0 && call.latencyMs === null)).toBe(true);
    expect(result.summary.scores[0]?.executionStatus).toBe("incomplete");
    expect(result.summary.scores[0]?.failureReason).toBe("request_limit");
  });
});
