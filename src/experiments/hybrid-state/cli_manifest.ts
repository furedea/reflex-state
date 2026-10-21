import { createHash } from "node:crypto";

import type { ExperimentManifest, HybridConfig } from "./types.js";
import { PROMPT_VERSION, PROTOCOL_ID, RESULT_SCHEMA_VERSION } from "./types.js";

export function parseManifest(value: unknown): ExperimentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid manifest.json");
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || typeof record.status !== "string")
    throw new Error("Invalid manifest.json: missing runId/status");
  if (record.schemaVersion !== RESULT_SCHEMA_VERSION)
    console.log("note: legacy result schema; metrics may be untrusted");
  return record as unknown as ExperimentManifest;
}

/** The summary must belong to the manifest in the same directory; a report
 * never invents a run and never mixes results across runs. */
export function parseSummaryForManifest(value: unknown, manifest: ExperimentManifest): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid summary.json");
  const record = value as Record<string, unknown>;
  if (record.runId !== manifest.runId)
    throw new Error(
      `summary.json runId ${String(record.runId)} does not match manifest runId ${manifest.runId}`,
    );
  if (record.schemaVersion !== manifest.schemaVersion)
    throw new Error(
      `summary.json schemaVersion ${String(record.schemaVersion)} does not match manifest schemaVersion ${manifest.schemaVersion}`,
    );
  if (
    record.protocolId !== undefined &&
    manifest.protocolId !== undefined &&
    record.protocolId !== manifest.protocolId
  )
    throw new Error(
      `summary.json protocolId ${String(record.protocolId)} does not match manifest protocolId ${manifest.protocolId}`,
    );
  return value;
}

export interface ManifestStart {
  readonly config: HybridConfig;
  readonly runId: string;
  readonly evaluation: "trace_audit" | "closed_loop";
  readonly input: string;
}

export function startManifest(start: ManifestStart): ExperimentManifest {
  const { config, runId, evaluation, input } = start;
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    protocolId: PROTOCOL_ID,
    runId,
    status: "running",
    head: null,
    inputHash: createHash("sha256").update(input).digest("hex"),
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
    environment: {
      node: process.version,
      platform: process.platform,
      isolation: config.provider.executionIsolation === "required" ? "sandbox-exec" : "none",
    },
    privacy: {
      recordContextText: config.recordContextText,
      recordResponseText: config.recordResponseText,
    },
  };
}
