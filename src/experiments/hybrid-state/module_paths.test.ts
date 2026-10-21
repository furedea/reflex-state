import { describe, expect, it } from "vitest";

import {
  enforceLivePolicy,
  loadScoring,
  loadTasks,
  parseManifest,
  recorderFor,
  ResultWriter,
  validateScoredTasks,
  verifyApprovedTasks,
} from "./cli.js";
import * as livePolicy from "./cli_live_policy.js";
import * as manifest from "./cli_manifest.js";
import * as resultWriter from "./cli_result_writer.js";
import * as tasks from "./cli_tasks.js";
import * as configParsing from "./config_parsing.js";
import { buildRepairRequest } from "./prompts.js";
import { candidateId } from "./trace.js";
import type { Candidate, PatchOperation, TraceMessage, UpdateInput } from "./types.js";
import { isExperimentMode, parseHybridConfig, parseHybridTask, parseTaskScoring } from "./types.js";
import { needsRepair, type ApplyContext } from "./update.js";

describe("module paths from before the split", () => {
  it("cli.ts still exports the CLI helpers", () => {
    expect(enforceLivePolicy).toBe(livePolicy.enforceLivePolicy);
    expect(verifyApprovedTasks).toBe(livePolicy.verifyApprovedTasks);
    expect(parseManifest).toBe(manifest.parseManifest);
    expect(recorderFor).toBe(resultWriter.recorderFor);
    expect(ResultWriter).toBe(resultWriter.ResultWriter);
    expect(loadScoring).toBe(tasks.loadScoring);
    expect(loadTasks).toBe(tasks.loadTasks);
    expect(validateScoredTasks).toBe(tasks.validateScoredTasks);
  });

  it("types.ts still exports config parsing", () => {
    expect(isExperimentMode).toBe(configParsing.isExperimentMode);
    expect(parseHybridConfig).toBe(configParsing.parseHybridConfig);
    expect(parseHybridTask).toBe(configParsing.parseHybridTask);
    expect(parseTaskScoring).toBe(configParsing.parseTaskScoring);
  });
});

describe("signatures changed by the split", () => {
  it("no longer type-check in their pre-split forms", () => {
    const legacyCalls = [
      (input: UpdateInput, operations: readonly PatchOperation[], context: ApplyContext) =>
        // @ts-expect-error the repair-time apply context belongs to RepairCheck
        needsRepair(input, operations, 8192, context),
      (input: UpdateInput, candidates: readonly Candidate[]) =>
        // @ts-expect-error repair observations are derived from the input's candidates
        buildRepairRequest(input, [], candidates, "model"),
      (message: TraceMessage) =>
        // @ts-expect-error the text is derived from the message and span
        candidateId(message, 0, 1, "text"),
    ];
    expect(legacyCalls).toHaveLength(3);
  });
});
