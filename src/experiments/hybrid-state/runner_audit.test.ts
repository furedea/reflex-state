import { describe, expect, it } from "vitest";

import { FakeJevProvider, FakeRepairProvider } from "./providers.js";
import { runAudit } from "./runner.js";
import type { HybridConfig, TraceData, TraceMessage } from "./types.js";

const config: HybridConfig = {
  schemaVersion: 2,
  evaluation: "trace_audit",
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
  modes: ["history", "llm", "rules", "jev"],
  seed: 1,
  iterations: 1,
  recordContextText: false,
  recordResponseText: false,
  candidateMaxBytes: 4096,
};

const messages: TraceMessage[] = [
  ["user", "fix the bug in src/a.ts"],
  ["assistant", "I will read it"],
  ["tool_result", "const a = 1; error: boom"],
  ["user", "also update the tests"],
  ["assistant", "done"],
].map(([role, text], index) => ({
  id: `m${index}`,
  role: role as TraceMessage["role"],
  text: text!,
  sequence: index,
  sourceId: `s${index}`,
  truncated: false,
}));

const trace: TraceData = {
  format: "synthetic",
  leaf: null,
  messages,
  events: [],
  missingText: [],
  sourceHash: "hash-a",
};

describe("trace audit", () => {
  it("audits every mode over the observation groups and summarizes once", async () => {
    const result = await runAudit({ config, trace, runId: "r" });
    expect(result.summary.scores.map((score) => score.mode)).toEqual(config.modes);
    expect(result.summary.scores.every((score) => score.completed)).toBe(true);
    const steps = result.updates.filter((record) => record.kind === "audit_step");
    expect(steps.map((record) => record.mode)).toEqual([
      "history",
      "history",
      "llm",
      "llm",
      "rules",
      "rules",
      "jev",
      "jev",
    ]);
    expect(result.updates.filter((record) => record.kind === "audit_summary")).toHaveLength(1);
  });

  it("records rejected labels when the source hash differs", async () => {
    const labels = { sourceHash: "other", labels: [] };
    const result = await runAudit({ config, trace, labels, runId: "r" });
    const rejected = result.updates.find((record) => record.labels_rejected !== undefined);
    expect(rejected).toMatchObject({
      labels_rejected: "source_hash_mismatch",
      expected: "hash-a",
      actual: "other",
    });
  });

  it("ends llm mode as state_unavailable when no update provider exists", async () => {
    const providers = { jev: new FakeJevProvider(), repair: new FakeRepairProvider() };
    const result = await runAudit({ config, trace, providers, runId: "r" });
    const llm = result.summary.scores.find((score) => score.mode === "llm");
    expect(llm?.completed).toBe(false);
    expect(llm?.terminationReason).toBe("state_unavailable");
    expect(llm?.failureReason).toBe("state_first_unavailable:update_provider_missing");
  });

  it("skips modes once the global request budget is spent", async () => {
    const tight = { ...config, provider: { ...config.provider, maxRequests: 0 } };
    const result = await runAudit({ config: tight, trace, runId: "r" });
    expect(result.summary.skippedTrials.map((skip) => skip.reason)).toEqual(
      tight.modes.map(() => "not_run_global_budget"),
    );
  });
});
