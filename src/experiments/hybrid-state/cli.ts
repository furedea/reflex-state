#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { enforceLivePolicy } from "./cli_live_policy.js";
import { parseManifest, parseSummaryForManifest, startManifest } from "./cli_manifest.js";
import type { CliOptions } from "./cli_options.js";
import { providerSet } from "./cli_providers.js";
import { recorderFor, ResultWriter } from "./cli_result_writer.js";
import { loadScoring, loadTasks, taskInputHash, validateScoredTasks } from "./cli_tasks.js";
import { parseHybridConfig } from "./config_parsing.js";
import { reportMarkdown, loadLabels } from "./evaluation.js";
import { captureFreeze, verifyFreeze, type FreezeRecord } from "./freeze.js";
import {
  PersistenceError,
  requiresIsolation,
  runAudit,
  runClosedLoop,
  type ExperimentRun,
} from "./runner.js";
import { checkIsolation } from "./task_environment.js";
import { parseTraceEntries } from "./trace.js";
import type {
  EvaluationKind,
  ExperimentManifest,
  HybridConfig,
  HybridTask,
  TaskScoring,
  TraceData,
} from "./types.js";

export { enforceLivePolicy, verifyApprovedTasks } from "./cli_live_policy.js";
export { parseManifest } from "./cli_manifest.js";
export { recorderFor, ResultWriter } from "./cli_result_writer.js";
export { loadScoring, loadTasks, validateScoredTasks } from "./cli_tasks.js";

type Command = "audit" | "run";

interface RunJob {
  readonly config: HybridConfig;
  readonly values: CliOptions;
  readonly writer: ResultWriter;
  readonly runId: string;
  /** Registers the started manifest so a later failure can be recorded on it. */
  readonly track: (manifest: ExperimentManifest) => void;
}

interface PreparedTasks {
  readonly taskRoot: string;
  readonly tasks: readonly HybridTask[];
  readonly scoring: ReadonlyMap<string, TaskScoring>;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      out: { type: "string", default: ".local/hybrid-state/result" },
      input: { type: "string" },
      session: { type: "string" },
      leaf: { type: "string" },
      case: { type: "string" },
      labels: { type: "string" },
      recorded: { type: "string" },
      freeze: { type: "string" },
      live: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (command === "audit") await execute("audit", values as CliOptions);
  else if (command === "run") await execute("run", values as CliOptions);
  else if (command === "report") await report(values);
  else throw new Error("Usage: experiment:hybrid audit|run|report [options]");
}

async function execute(command: Command, values: CliOptions): Promise<void> {
  const config = await loadHybridConfig(values.config, command, values.live);
  // Preflight completes before the output directory is reserved or any record
  // is written, so a rejected run leaves no partial result.
  await enforceLivePolicy(config, values);
  const isolationVerified = await resolveIsolation(command, config);
  await verifyFrozenCondition(config, values.freeze);
  // Task and scoring validation belongs to preflight: a rejected run must not
  // reserve or leave a partial result directory.
  const prepared = command === "run" ? await prepareTasks(config) : undefined;
  const writer = await ResultWriter.reserve(values.out);
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let manifest: ExperimentManifest | undefined;
  const job: RunJob = {
    config,
    values,
    writer,
    runId,
    track: (started) => {
      manifest = started;
    },
  };
  try {
    if (command === "audit") await executeAudit(job);
    else if (prepared) await executeClosedLoop(job, prepared, isolationVerified);
  } catch (error) {
    await recordFailure(writer, manifest, error);
    throw error;
  }
}

async function resolveIsolation(command: Command, config: HybridConfig): Promise<boolean> {
  if (!requiresIsolation(config)) return true;
  if (command !== "run") return false;
  const isolation = await checkIsolation();
  if (!isolation.available)
    throw new Error(`live_ready=false: ${isolation.detail}${failedChecks(isolation.checks)}`);
  return true;
}

function failedChecks(checks: readonly { name: string; passed: boolean }[] | undefined): string {
  if (!checks) return "";
  return ` (${checks
    .filter((check) => !check.passed)
    .map((check) => check.name)
    .join(", ")})`;
}

/** A frozen run must reproduce the recorded condition exactly; any drift in
 * code, config, tasks, scoring, or prompts is a new condition, not the
 * frozen experiment. */
async function verifyFrozenCondition(config: HybridConfig, freezePath?: string): Promise<void> {
  if (!freezePath) return;
  const frozen = JSON.parse(await readFile(freezePath, "utf8")) as FreezeRecord;
  const check = verifyFreeze(frozen, await captureFreeze(config));
  if (!check.ok) throw new Error(`frozen_condition_mismatch: ${check.mismatches.join("; ")}`);
}

async function prepareTasks(config: HybridConfig): Promise<PreparedTasks> {
  const taskRoot = config.taskRoot ?? "experiments/hybrid-state/tasks";
  const tasks = await loadTasks(taskRoot);
  const scoring = await loadScoring(taskRoot, tasks);
  validateScoredTasks(tasks, scoring);
  return { taskRoot, tasks, scoring };
}

async function executeAudit(job: RunJob): Promise<void> {
  const { config, values, writer, runId } = job;
  const trace = await loadTrace(values);
  const labels = values.labels
    ? await loadLabels(values.labels)
    : await loadLabels("experiments/hybrid-state/labels/basic.json").catch(() => undefined);
  const providers = await providerSet(config, values);
  const manifest = startManifest({
    config,
    runId,
    evaluation: "trace_audit",
    input: trace.sourceHash,
  });
  job.track(manifest);
  await writer.writeManifest(manifest);
  const result = await runAudit({
    config,
    trace,
    ...(labels ? { labels } : {}),
    providers,
    runId,
    recorder: recorderFor(writer),
  });
  await finalize(writer, manifest, result);
}

async function executeClosedLoop(
  job: RunJob,
  prepared: PreparedTasks,
  isolationVerified: boolean,
): Promise<void> {
  const { config, values, writer, runId } = job;
  const { tasks, scoring } = prepared;
  const providers = await providerSet(config, values, tasks);
  const manifest = startManifest({
    config,
    runId,
    evaluation: "closed_loop",
    input: taskInputHash(tasks),
  });
  job.track(manifest);
  await writer.writeManifest(manifest);
  const result = await runClosedLoop({
    config,
    tasks,
    scoring,
    providers,
    runId,
    recorder: recorderFor(writer),
    isolationVerified,
  });
  await finalize(writer, manifest, result);
}

async function recordFailure(
  writer: ResultWriter,
  manifest: ExperimentManifest | undefined,
  error: unknown,
): Promise<void> {
  if (!manifest) return;
  const failed: ExperimentManifest = {
    ...manifest,
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : "run_failed",
    failedStage: error instanceof PersistenceError ? "recording" : "execution",
  };
  await writer.writeManifest(failed).catch(() => undefined);
}

/** Runs end with summary and report persisted before the completed manifest is
 * finalized; a persistence failure leaves status "failed", never "completed". */
async function finalize(
  writer: ResultWriter,
  started: ExperimentManifest,
  result: ExperimentRun,
): Promise<void> {
  await writer.writeSummary(result.summary);
  await writer.writeReport(reportMarkdown(result.summary, result.manifest));
  await writer.writeManifest({
    ...result.manifest,
    status: "completed",
    startedAt: started.startedAt,
    finishedAt: new Date().toISOString(),
  });
  console.log(`new run executed: ${result.summary.runId}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function report(values: Record<string, string | boolean | undefined>): Promise<void> {
  const input = values.input ?? values.out;
  if (typeof input !== "string") throw new Error("report requires --input <result directory>");
  const directory = resolve(input);
  const files = await readdir(directory).catch(() => {
    throw new Error(`Result directory not found: ${input}`);
  });
  if (!files.includes("manifest.json"))
    throw new Error(`Result directory has no manifest.json: ${input}`);
  const manifest = parseManifest(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  if (!files.includes("summary.json")) {
    console.log(`existing result (run ${manifest.runId}) is ${manifest.status}; no summary yet`);
    return;
  }
  const summary = parseSummaryForManifest(
    JSON.parse(await readFile(join(directory, "summary.json"), "utf8")),
    manifest,
  );
  console.log(`existing result displayed: run ${manifest.runId} (${manifest.status})`);
  console.log(reportMarkdown(summary, manifest));
}

export async function loadHybridConfig(
  path: string | undefined,
  command: Command,
  live: boolean,
): Promise<HybridConfig> {
  const configPath =
    typeof path === "string" ? path : "experiments/hybrid-state/config.offline.json";
  const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const parsed = parseHybridConfig(raw);
  const expected: EvaluationKind = command === "audit" ? "trace_audit" : "closed_loop";
  const config = parsed.evaluation === expected ? parsed : { ...parsed, evaluation: expected };
  if (live && config.provider.mode !== "live")
    throw new Error("--live is only valid with provider.mode=live");
  if (config.provider.mode === "live" && !live)
    throw new Error("provider.mode=live requires --live");
  return config;
}

async function loadTrace(values: CliOptions): Promise<TraceData> {
  if (typeof values.session === "string")
    return parseTraceEntries(await readJsonLines(values.session), {
      session: values.session,
      ...(typeof values.leaf === "string" ? { leaf: values.leaf } : {}),
    });
  const casePath =
    typeof values.case === "string" ? values.case : "experiments/hybrid-state/cases/basic.jsonl";
  return parseTraceEntries(await readJsonLines(casePath), {
    synthetic: true,
    ...(typeof values.leaf === "string" ? { leaf: values.leaf } : {}),
  });
}

async function readJsonLines(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid JSONL input: ${path}`);
      return value as Record<string, unknown>;
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Hybrid experiment failed");
    process.exitCode = 1;
  });
