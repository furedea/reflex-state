#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { reportMarkdown, loadLabels } from "./evaluation.js";
import {
  createLiveProviders,
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  FakeUpdateProvider,
  readRecordedProviders,
  type ProviderSet,
} from "./providers.js";
import { runAudit, runClosedLoop, type ExperimentRun, type RunContext } from "./runner.js";
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
import { parseHybridConfig, parseHybridTask, parseTaskScoring } from "./types.js";

interface CliOptions {
  readonly config?: string;
  readonly out: string;
  readonly input?: string;
  readonly session?: string;
  readonly leaf?: string;
  readonly case?: string;
  readonly labels?: string;
  readonly recorded?: string;
  readonly live: boolean;
}

export class ResultWriter {
  private constructor(private readonly directory: string) {}

  static async reserve(directory: string): Promise<ResultWriter> {
    const target = resolve(directory);
    await mkdir(resolve(target, ".."), { recursive: true });
    try {
      await mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`Output directory already exists: ${directory}`);
      throw error;
    }
    return new ResultWriter(target);
  }

  async writeManifest(manifest: ExperimentManifest): Promise<void> {
    await writeFile(
      join(this.directory, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }

  append(record: object, file: string): Promise<void> {
    return appendFile(join(this.directory, file), JSON.stringify(record) + "\n");
  }

  async writeSummary(summary: unknown): Promise<void> {
    await writeFile(join(this.directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  }

  async writeReport(text: string): Promise<void> {
    await writeFile(join(this.directory, "report.md"), text);
  }
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
      live: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (command === "audit") await execute("audit", values as CliOptions);
  else if (command === "run") await execute("run", values as CliOptions);
  else if (command === "report") await report(values);
  else throw new Error("Usage: experiment:hybrid audit|run|report [options]");
}

async function execute(command: "audit" | "run", values: CliOptions): Promise<void> {
  const config = await loadHybridConfig(values.config, command, values.live);
  enforceLivePolicy(config, values);
  if (config.provider.mode === "live" && config.provider.executionIsolation === "required") {
    const isolation = await checkIsolation();
    if (!isolation.available)
      throw new Error(
        `Live code execution requires a sandbox, but none is available (${isolation.detail})`,
      );
  }
  const writer = await ResultWriter.reserve(values.out);
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let manifest: ExperimentManifest | undefined;
  try {
    if (command === "audit") {
      const trace = await loadTrace(values);
      const labels = values.labels
        ? await loadLabels(values.labels)
        : await loadLabels("experiments/hybrid-state/labels/basic.json").catch(() => undefined);
      if (config.provider.mode === "live" && trace.format !== "synthetic")
        throw new Error("Live audit requires an approved synthetic fixture");
      const providers = await providerSet(config, values);
      manifest = startManifest(config, runId, "trace_audit", trace.sourceHash);
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
    } else {
      const taskRoot = config.taskRoot ?? "experiments/hybrid-state/tasks";
      const tasks = await loadTasks(taskRoot);
      const scoring = await loadScoring(taskRoot, tasks);
      const providers = await providerSet(config, values, tasks);
      manifest = startManifest(config, runId, "closed_loop", taskInputHash(tasks));
      await writer.writeManifest(manifest);
      const result = await runClosedLoop({
        config,
        tasks,
        scoring,
        providers,
        runId,
        recorder: recorderFor(writer),
      });
      await finalize(writer, manifest, result);
    }
  } catch (error) {
    if (manifest) {
      const failed: ExperimentManifest = {
        ...manifest,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "run_failed",
      };
      await writer.writeManifest(failed).catch(() => undefined);
    }
    throw error;
  }
}

async function finalize(
  writer: ResultWriter,
  started: ExperimentManifest,
  result: ExperimentRun,
): Promise<void> {
  await writer.writeManifest({
    ...result.manifest,
    status: "completed",
    startedAt: started.startedAt,
    finishedAt: new Date().toISOString(),
  });
  await writer.writeSummary(result.summary);
  await writer.writeReport(reportMarkdown(result.summary, result.manifest));
  console.log(`new run executed: ${result.summary.runId}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

function recorderFor(writer: ResultWriter): NonNullable<RunContext["recorder"]> {
  return {
    call: (record) => void writer.append(record, "calls.jsonl"),
    context: (record) => void writer.append(record, "contexts.jsonl"),
    update: (record) => void writer.append(record, "updates.jsonl"),
  };
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
  const summary: unknown = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
  console.log(`existing result displayed: run ${manifest.runId} (${manifest.status})`);
  console.log(reportMarkdown(summary, manifest));
}

function parseManifest(value: unknown): ExperimentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid manifest.json");
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || typeof record.status !== "string")
    throw new Error("Invalid manifest.json: missing runId/status");
  if (record.schemaVersion !== 2)
    console.log("note: legacy result schema; metrics may be untrusted");
  return record as unknown as ExperimentManifest;
}

export async function loadHybridConfig(
  path: string | undefined,
  command: "audit" | "run",
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

function enforceLivePolicy(config: HybridConfig, values: CliOptions): void {
  if (config.provider.mode !== "live") return;
  if (typeof values.session === "string")
    throw new Error("Live provider does not accept --session inputs");
  if (values.live !== true) throw new Error("provider.mode=live requires --live");
}

async function providerSet(
  config: HybridConfig,
  values: CliOptions,
  tasks: readonly HybridTask[] = [],
): Promise<ProviderSet> {
  const needs = {
    actor: config.evaluation === "closed_loop",
    jev: config.modes.includes("jev"),
    repair: config.modes.some((mode) => mode === "rules" || mode === "jev"),
    update: config.evaluation === "trace_audit" && config.modes.includes("llm"),
  };
  if (config.provider.mode === "fake")
    return {
      ...(needs.jev ? { jev: new FakeJevProvider() } : {}),
      ...(needs.repair ? { repair: new FakeRepairProvider() } : {}),
      ...(needs.actor ? { actor: new FakeActorProvider(tasks) } : {}),
      ...(needs.update ? { update: new FakeUpdateProvider() } : {}),
    };
  if (config.provider.mode === "recorded") {
    if (typeof values.recorded !== "string")
      throw new Error("Recorded provider requires --recorded <file>");
    return readRecordedProviders(values.recorded);
  }
  const providers = await createLiveProviders({
    ...(config.provider.actorModel ? { actorModel: config.provider.actorModel } : {}),
    ...(config.provider.jevModel ? { jevModel: config.provider.jevModel } : {}),
    ...(config.provider.repairModel ? { repairModel: config.provider.repairModel } : {}),
    ...(config.provider.updateModel ? { updateModel: config.provider.updateModel } : {}),
    needs,
  });
  const missing = (Object.keys(needs) as (keyof typeof needs)[]).filter(
    (key) => needs[key] && !providers[key],
  );
  if (missing.length)
    throw new Error(`Live configuration is missing providers for: ${missing.join(", ")}`);
  return providers;
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

async function loadTasks(root: string): Promise<HybridTask[]> {
  const files = (await readdir(root)).filter((file) => file.endsWith(".json")).sort();
  const tasks: HybridTask[] = [];
  for (const file of files)
    tasks.push(parseHybridTask(JSON.parse(await readFile(join(root, file), "utf8")), file));
  if (!tasks.length) throw new Error("No hybrid-state tasks found");
  return tasks;
}

async function loadScoring(
  taskRoot: string,
  tasks: readonly HybridTask[],
): Promise<ReadonlyMap<string, TaskScoring>> {
  const scoring = new Map<string, TaskScoring>();
  const directory = join(taskRoot, "scoring");
  const files = await readdir(directory).catch(() => [] as string[]);
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const parsed = parseTaskScoring(
      JSON.parse(await readFile(join(directory, file), "utf8")),
      file,
    );
    scoring.set(parsed.taskId, parsed);
  }
  const ids = new Set(tasks.map((task) => task.id));
  for (const key of scoring.keys())
    if (!ids.has(key)) throw new Error(`Scoring file targets unknown task: ${key}`);
  return scoring;
}

function taskInputHash(tasks: readonly HybridTask[]): string {
  return tasks.map((task) => JSON.stringify(task)).join("\n");
}

function startManifest(
  config: HybridConfig,
  runId: string,
  evaluation: "trace_audit" | "closed_loop",
  input: string,
): ExperimentManifest {
  return {
    schemaVersion: 2,
    runId,
    status: "running",
    head: null,
    inputHash: inputHash(input),
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
    promptVersion: "hybrid-state-prompt-v2",
    startedAt: new Date().toISOString(),
    privacy: { recordContextText: config.recordContextText },
  };
}

function inputHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Hybrid experiment failed");
    process.exitCode = 1;
  });
