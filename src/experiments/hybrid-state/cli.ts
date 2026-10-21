#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ActiveRun } from "./cli_active_run.js";
import { enforceLivePolicy } from "./cli_live_policy.js";
import { parseManifest, parseSummaryForManifest } from "./cli_manifest.js";
import type { CliOptions } from "./cli_options.js";
import { providerSet } from "./cli_providers.js";
import { recorderFor, ResultWriter } from "./cli_result_writer.js";
import {
  loadScoring,
  loadTasks,
  taskInputHash,
  validateScoredTasks,
  type ScoredTasks,
} from "./cli_tasks.js";
import { parseHybridConfig } from "./config_parsing.js";
import { reportMarkdown, loadLabels } from "./evaluation.js";
import { captureFreeze, verifyFreeze, type FreezeRecord } from "./freeze.js";
import { requiresIsolation, runAudit, runClosedLoop } from "./runner.js";
import { checkIsolation } from "./task_environment.js";
import { parseTraceEntries } from "./trace.js";
import type { EvaluationKind, HybridConfig, TraceData } from "./types.js";

export { enforceLivePolicy, verifyApprovedTasks } from "./cli_live_policy.js";
export { parseManifest } from "./cli_manifest.js";
export { recorderFor, ResultWriter } from "./cli_result_writer.js";
export { loadScoring, loadTasks, validateScoredTasks } from "./cli_tasks.js";

type Command = "audit" | "run";

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
  await verifyIsolation(command, config);
  await verifyFrozenCondition(config, values.freeze);
  // Task and scoring validation belongs to preflight: a rejected run must not
  // reserve or leave a partial result directory.
  const prepared = command === "run" ? await prepareTasks(config) : undefined;
  const writer = await ResultWriter.reserve(values.out);
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run = new ActiveRun(config, writer, runId);
  try {
    if (command === "audit") await executeAudit(run, values);
    else if (prepared) await executeClosedLoop(run, values, prepared);
  } catch (error) {
    await run.recordFailure(error);
    throw error;
  }
}

/** Live closed-loop runs require a verified sandbox; audits never run the actor. */
async function verifyIsolation(command: Command, config: HybridConfig): Promise<void> {
  if (command !== "run" || !requiresIsolation(config)) return;
  const isolation = await checkIsolation();
  if (!isolation.available)
    throw new Error(`live_ready=false: ${isolation.detail}${failedChecks(isolation.checks)}`);
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

async function prepareTasks(config: HybridConfig): Promise<ScoredTasks> {
  const taskRoot = config.taskRoot ?? "experiments/hybrid-state/tasks";
  const tasks = await loadTasks(taskRoot);
  const scoring = await loadScoring(taskRoot, tasks);
  validateScoredTasks(tasks, scoring);
  return { tasks, scoring };
}

async function executeAudit(run: ActiveRun, values: CliOptions): Promise<void> {
  const { config, writer, runId } = run;
  const trace = await loadTrace(values);
  const labels = values.labels
    ? await loadLabels(values.labels)
    : await loadLabels("experiments/hybrid-state/labels/basic.json").catch(() => undefined);
  const providers = await providerSet(config, values);
  await run.start(trace.sourceHash);
  const result = await runAudit({
    config,
    trace,
    ...(labels ? { labels } : {}),
    providers,
    runId,
    recorder: recorderFor(writer),
  });
  await run.finalize(result);
}

async function executeClosedLoop(
  run: ActiveRun,
  values: CliOptions,
  { tasks, scoring }: ScoredTasks,
): Promise<void> {
  const { config, writer, runId } = run;
  const providers = await providerSet(config, values, tasks);
  await run.start(taskInputHash(tasks));
  const result = await runClosedLoop({
    config,
    tasks,
    scoring,
    providers,
    runId,
    recorder: recorderFor(writer),
    isolationVerified: true,
  });
  await run.finalize(result);
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
