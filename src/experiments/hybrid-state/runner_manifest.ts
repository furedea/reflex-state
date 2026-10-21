import { createHash } from "node:crypto";

import { snapshotForRun } from "./freeze.js";
import type { RunContext } from "./runner_context.js";
import type { ExperimentEnvironment, ExperimentManifest, HybridConfig } from "./types.js";
import { PROMPT_VERSION, PROTOCOL_ID, RESULT_SCHEMA_VERSION } from "./types.js";

/** Oracle scripts execute workspace code, so isolation is required whenever a
 * config asks for it or when a closed_loop run uses a non-fake provider
 * (recorded responses still replay generated code into the environment). */
export function requiresIsolation(config: HybridConfig): boolean {
  return (
    config.provider.executionIsolation === "required" ||
    (config.evaluation === "closed_loop" && config.provider.mode !== "fake")
  );
}

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function experimentEnvironment(config: HybridConfig): ExperimentEnvironment {
  return {
    node: process.version,
    platform: process.platform,
    isolation: config.provider.executionIsolation === "required" ? "sandbox-exec" : "none",
  };
}

export async function createManifest(
  ctx: RunContext,
  input: string,
  evaluation: "trace_audit" | "closed_loop",
): Promise<ExperimentManifest> {
  const { config, runId } = ctx;
  const snapshot = await snapshotForRun(config);
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    protocolId: PROTOCOL_ID,
    runId,
    status: "completed",
    head: snapshot.head,
    dirty: snapshot.dirty,
    inputHash: createHash("sha256").update(input).digest("hex"),
    ...(snapshot.taskSetHash ? { taskSetHash: snapshot.taskSetHash } : {}),
    promptHashes: snapshot.promptHashes,
    runtime: {
      node: snapshot.node,
      platform: snapshot.platform,
      ...(snapshot.lockfileHash ? { lockfileHash: snapshot.lockfileHash } : {}),
      generationOptions: "provider_defaults",
    },
    config,
    modes: config.modes,
    provider: config.provider.mode,
    evaluation,
    modelIds: {
      jev: config.provider.jevModel ?? null,
      actor: config.provider.actorModel ?? null,
      repair: config.provider.repairModel ?? null,
      update: config.provider.updateModel ?? null,
    },
    sdkVersion: "@earendil-works/pi-coding-agent@0.83.0",
    promptVersion: PROMPT_VERSION,
    startedAt: new Date().toISOString(),
    environment: experimentEnvironment(config),
    privacy: {
      recordContextText: config.recordContextText,
      recordResponseText: config.recordResponseText,
    },
  };
}
