import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { actorRequest, budgets, config, message, task } from "./acceptance_fixtures.js";
import { loadHybridConfig, parseManifest, ResultWriter } from "./cli.js";
import { reportMarkdown } from "./evaluation.js";
import { buildProjection } from "./projection.js";
import { FakeActorProvider, InputDependentActorProvider } from "./providers.js";
import { runClosedLoop } from "./runner.js";
import { safePath, TaskEnvironment } from "./task_environment.js";
import { emptyMemory, parseHybridConfig } from "./types.js";
import { applyOperations, initialFacts } from "./update.js";

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
      actionBudget: {
        limit: 8,
        used: 0,
        remaining_including_next: 8,
        finish_counts_as_action: true,
      },
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

  it("L-13: a schema v2 result renders read-only and never gains v3 fields", () => {
    const usageField = { observedSubtotal: null, completeTotal: null, coverage: 0 };
    const usage = {
      inputTokens: usageField,
      outputTokens: usageField,
      cacheReadTokens: usageField,
      cacheWriteTokens: usageField,
    };
    const metric = {
      uniqueCandidates: 0,
      decisionCount: 0,
      appliedExtractive: 0,
      appliedGenerated: 0,
      invocations: { actor: 1, jev: 0, repair: 0, update: 0 },
      sentBytes: 10,
      usage,
      wallMs: 1,
      contextBytes: { history: 0, state: 0, memory: 0, observations: 0, feedback: 0 },
    };
    // A v2-shaped score has no termination/final-artifact/patch fields at all.
    const v2Score = {
      trialId: "iter0-a-history",
      taskId: "a",
      mode: "history",
      iteration: 0,
      executionStatus: "completed",
      wiringStatus: "passed",
      efficacyStatus: "descriptive_only",
      startedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:00:01.000Z",
      wallMs: 1,
      completed: true,
      testPassed: true,
      constraintPassed: null,
      constraints: {},
      tests: { t: "passed" },
      actorTests: [],
      checkpoints: [],
      rereads: 0,
      retries: 0,
      appliedExtractive: 0,
      appliedGenerated: 0,
      activeMemoryItems: 0,
    };
    const v2Summary = {
      schemaVersion: 2,
      runId: "old-run",
      evaluation: "closed_loop",
      provider: "live",
      modes: ["history"],
      efficacyStatus: "descriptive_only",
      wiring: { passed: 1, failed: 0, notEvaluated: 0 },
      plannedTrials: 1,
      skippedTrials: [],
      scores: [v2Score],
      metrics: { history: metric },
      limitations: [],
    };
    const report = reportMarkdown(v2Summary as never);
    // The report labels the old schema and keeps new-protocol columns absent.
    expect(report).toContain("schema v2 result");
    expect(report).not.toContain("| termination |");
    expect(report).not.toContain("last_update_result");
    // A v2 manifest parses read-only: it is returned as stored, not upgraded.
    const manifest = parseManifest({
      schemaVersion: 2,
      runId: "old-run",
      status: "completed",
      summaryFile: "summary.json",
      reportFile: "report.md",
    });
    expect(manifest.schemaVersion).toBe(2);
  });
});
