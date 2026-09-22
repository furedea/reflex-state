import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureFreeze,
  promptHashes,
  taskSetHash,
  verifyFreeze,
  type FreezeRecord,
} from "./freeze.js";
import type { HybridConfig } from "./types.js";

const config: HybridConfig = {
  schemaVersion: 2,
  evaluation: "closed_loop",
  provider: {
    mode: "fake",
    actorModel: "fake",
    maxRequests: 144,
    trialMaxRequests: 32,
    timeoutMs: 120_000,
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
  iterations: 3,
  recordContextText: true,
  recordResponseText: true,
  candidateMaxBytes: 4096,
};

describe("frozen condition snapshot", () => {
  it("G-04: identical conditions verify; any content drift is a different condition", async () => {
    const frozen = await captureFreeze(config);
    expect(verifyFreeze(frozen, await captureFreeze(config)).ok).toBe(true);
    const drifted: HybridConfig = { ...config, iterations: 2 };
    const check = verifyFreeze(frozen, await captureFreeze(drifted));
    expect(check.ok).toBe(false);
    expect(check.mismatches.some((line) => line.startsWith("configHash"))).toBe(true);
  });

  it("G-04: task and scoring content changes break the frozen identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hybrid-freeze-"));
    await writeFile(join(root, "a.json"), '{"id":"a"}', "utf8");
    const before = await taskSetHash(root);
    await writeFile(join(root, "a.json"), '{"id":"a","x":1}', "utf8");
    expect(await taskSetHash(root)).not.toBe(before);
    // Scoring files participate in the same hash.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "scoring"));
    await writeFile(join(root, "scoring", "a.json"), '{"taskId":"a"}', "utf8");
    const withScoring = await taskSetHash(root);
    await writeFile(join(root, "scoring", "a.json"), '{"taskId":"a","x":1}', "utf8");
    expect(await taskSetHash(root)).not.toBe(withScoring);
  });

  it("G-04: a dirty tree is never the frozen clean condition", async () => {
    const frozen = await captureFreeze(config);
    const dirtyCopy: FreezeRecord = { ...frozen, dirty: !frozen.dirty };
    const check = verifyFreeze(frozen, dirtyCopy);
    expect(check.ok).toBe(false);
    expect(check.mismatches.some((line) => line.startsWith("dirty:"))).toBe(true);
    // And a different commit can never masquerade as the frozen code.
    const moved = { ...frozen, commit: "0".repeat(40) };
    expect(verifyFreeze(frozen, moved).ok).toBe(false);
  });

  it("G-04: prompt hashes pin each mode's system prompt", () => {
    const hashes = promptHashes(["history", "llm"]);
    expect(Object.keys(hashes).sort()).toEqual(["history", "llm"]);
    for (const hash of Object.values(hashes)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.history).not.toBe(hashes.llm);
  });
});
