#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { reportMarkdown, loadLabels } from "./evaluation.js";
import { captureFreeze, verifyFreeze, type FreezeRecord } from "./freeze.js";
import {
  createLiveProviders,
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  FakeUpdateProvider,
  readRecordedProviders,
  type ProviderSet,
} from "./providers.js";
import {
  PersistenceError,
  requiresIsolation,
  runAudit,
  runClosedLoop,
  type ExperimentRun,
  type RunRecorder,
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
import {
  parseHybridConfig,
  parseHybridTask,
  parseTaskScoring,
  PROMPT_VERSION,
  PROTOCOL_ID,
  RESULT_SCHEMA_VERSION,
} from "./types.js";

interface CliOptions {
  readonly config?: string;
  readonly out: string;
  readonly input?: string;
  readonly session?: string;
  readonly leaf?: string;
  readonly case?: string;
  readonly labels?: string;
  readonly recorded?: string;
  readonly freeze?: string;
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
    await this.writeAtomic("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  }

  append(record: object, file: string): Promise<void> {
    return appendFile(join(this.directory, file), JSON.stringify(record) + "\n");
  }

  async writeSummary(summary: unknown): Promise<void> {
    await this.writeAtomic("summary.json", JSON.stringify(summary, null, 2) + "\n");
  }

  async writeReport(text: string): Promise<void> {
    await this.writeAtomic("report.md", text);
  }

  /** Same-directory tmp + rename so a torn write never leaves a partial file. */
  private async writeAtomic(file: string, content: string): Promise<void> {
    const target = join(this.directory, file);
    const temp = join(this.directory, `.${file}.tmp`);
    await writeFile(temp, content);
    await rename(temp, target);
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

async function execute(command: "audit" | "run", values: CliOptions): Promise<void> {
  const config = await loadHybridConfig(values.config, command, values.live);
  // Preflight completes before the output directory is reserved or any record
  // is written, so a rejected run leaves no partial result.
  await enforceLivePolicy(config, values);
  let isolationVerified = true;
  if (command === "run" && requiresIsolation(config)) {
    const isolation = await checkIsolation();
    if (!isolation.available)
      throw new Error(
        `live_ready=false: ${isolation.detail}${
          isolation.checks
            ? ` (${isolation.checks
                .filter((check) => !check.passed)
                .map((check) => check.name)
                .join(", ")})`
            : ""
        }`,
      );
    isolationVerified = true;
  } else if (requiresIsolation(config)) {
    isolationVerified = false;
  }
  // A frozen run must reproduce the recorded condition exactly; any drift in
  // code, config, tasks, scoring, or prompts is a new condition, not the
  // frozen experiment.
  if (values.freeze) {
    const frozen = JSON.parse(await readFile(values.freeze, "utf8")) as FreezeRecord;
    const check = verifyFreeze(frozen, await captureFreeze(config));
    if (!check.ok) throw new Error(`frozen_condition_mismatch: ${check.mismatches.join("; ")}`);
  }
  // Task and scoring validation belongs to preflight: a rejected run must not
  // reserve or leave a partial result directory.
  const prepared =
    command === "run"
      ? await (async () => {
          const taskRoot = config.taskRoot ?? "experiments/hybrid-state/tasks";
          const tasks = await loadTasks(taskRoot);
          const scoring = await loadScoring(taskRoot, tasks);
          validateScoredTasks(tasks, scoring);
          return { taskRoot, tasks, scoring };
        })()
      : undefined;
  const writer = await ResultWriter.reserve(values.out);
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let manifest: ExperimentManifest | undefined;
  try {
    if (command === "audit") {
      const trace = await loadTrace(values);
      const labels = values.labels
        ? await loadLabels(values.labels)
        : await loadLabels("experiments/hybrid-state/labels/basic.json").catch(() => undefined);
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
    } else if (prepared) {
      const { tasks, scoring } = prepared;
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
        isolationVerified,
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
        failedStage: error instanceof PersistenceError ? "recording" : "execution",
      };
      await writer.writeManifest(failed).catch(() => undefined);
    }
    throw error;
  }
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

/** Serialized, awaited writes: a persistence failure is retained and propagated
 * so the run stops instead of continuing with a torn record set. */
export function recorderFor(writer: ResultWriter): RunRecorder {
  let queue: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  const enqueue = (file: string, record: object): Promise<void> => {
    if (failure) return Promise.reject(failure);
    const next = queue.then(() => writer.append(record, file));
    queue = next.catch(() => undefined);
    return next.catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error("record_write_failed");
      throw failure;
    });
  };
  return {
    callStart: (record) => enqueue("calls.jsonl", record),
    call: (record) => enqueue("calls.jsonl", record),
    context: (record) => enqueue("contexts.jsonl", record),
    update: (record) => enqueue("updates.jsonl", record),
    prompt: (record) => enqueue("system_prompts.jsonl", record),
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
  const summary = parseSummaryForManifest(
    JSON.parse(await readFile(join(directory, "summary.json"), "utf8")),
    manifest,
  );
  console.log(`existing result displayed: run ${manifest.runId} (${manifest.status})`);
  console.log(reportMarkdown(summary, manifest));
}

/** The summary must belong to the manifest in the same directory; a report
 * never invents a run and never mixes results across runs. */
function parseSummaryForManifest(value: unknown, manifest: ExperimentManifest): unknown {
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

const APPROVED_TASK_ROOT = resolve("experiments");
const STAGE_A_MANIFEST = resolve("experiments/hybrid-state/stage-a.approved.json");

interface ApprovedManifest {
  readonly taskRoot: string;
  readonly files: Readonly<Record<string, string>>;
}

async function loadApprovedManifest(path: string): Promise<ApprovedManifest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid approved task manifest: ${path}`);
  const record = value as Record<string, unknown>;
  if (typeof record.taskRoot !== "string" || !record.taskRoot.trim())
    throw new Error(`Invalid taskRoot in ${path}`);
  const files = record.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || !Object.keys(files).length)
    throw new Error(`Invalid files in ${path}`);
  for (const [name, hash] of Object.entries(files as Record<string, unknown>))
    if (typeof hash !== "string" || !hash.trim() || name.includes("..") || name.startsWith("/"))
      throw new Error(`Invalid files entry ${name} in ${path}`);
  return { taskRoot: record.taskRoot, files: files as Record<string, string> };
}

/** Live runs may only execute the approved Stage A fixture set: the task root
 * must be the manifest's directory and every task/scoring file must hash-match
 * the checked-in manifest, with no extra or missing files. The manifest path
 * is injectable so the hash comparison itself is testable. */
export async function verifyApprovedTasks(
  taskRoot: string,
  manifestPath: string = STAGE_A_MANIFEST,
): Promise<void> {
  const manifest = await loadApprovedManifest(manifestPath);
  const root = resolve(taskRoot);
  if (root !== resolve(manifest.taskRoot))
    throw new Error(`Live execution is limited to the approved task set at ${manifest.taskRoot}`);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const content = await readFile(join(root, name), "utf8").catch(() => {
      throw new Error(`Approved task file missing: ${name}`);
    });
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== expected)
      throw new Error(`Task file ${name} does not match the approved content hash`);
  }
  const present = new Set<string>();
  for (const entry of await readdir(root)) if (entry.endsWith(".json")) present.add(entry);
  const scoringDir = join(root, "scoring");
  for (const entry of await readdir(scoringDir).catch(() => [] as string[]))
    if (entry.endsWith(".json")) present.add(`scoring/${entry}`);
  const extras = [...present].filter((name) => !(name in manifest.files));
  if (extras.length) throw new Error(`Unapproved files in task root: ${extras.sort().join(", ")}`);
}

/** Live runs are restricted to the Stage A closed-loop shape: history/llm
 * modes only, the approved checked-in task fixtures verified by content hash,
 * required isolation, and no session, case, or recorded inputs that could
 * smuggle unapproved content. */
export async function enforceLivePolicy(config: HybridConfig, values: CliOptions): Promise<void> {
  if (config.provider.mode !== "live") return;
  if (values.live !== true) throw new Error("provider.mode=live requires --live");
  if (typeof values.session === "string")
    throw new Error("Live provider does not accept --session inputs");
  if (typeof values.case === "string")
    throw new Error("Live provider does not accept --case inputs");
  if (typeof values.recorded === "string")
    throw new Error("Live provider does not accept --recorded inputs");
  if (config.evaluation !== "closed_loop")
    throw new Error("Live execution is limited to Stage A closed_loop runs");
  const unsupported = config.modes.filter((mode) => mode !== "history" && mode !== "llm");
  if (unsupported.length)
    throw new Error(
      `Live execution is limited to Stage A modes (history, llm): ${unsupported.join(", ")}`,
    );
  if (config.provider.executionIsolation !== "required")
    throw new Error("Live execution requires provider.executionIsolation=required");
  if (!config.provider.actorModel)
    throw new Error("Live execution requires an explicit provider.actorModel");
  const taskRoot = resolve(config.taskRoot ?? "experiments/hybrid-state/tasks");
  if (!taskRoot.startsWith(`${APPROVED_TASK_ROOT}/`))
    throw new Error("Live execution requires checked-in task fixtures under experiments/");
  await verifyApprovedTasks(taskRoot);
}

/** Closed-loop comparisons require independent scoring for every task: each
 * task must have a scoring entry and each allowed test an explicit oracle; a
 * missing scoring set is a preflight error, not a silent expectedFiles
 * fallback. */
export function validateScoredTasks(
  tasks: readonly HybridTask[],
  scoring: ReadonlyMap<string, TaskScoring>,
): void {
  for (const task of tasks) {
    const scored = scoring.get(task.id);
    if (!scored) throw new Error(`task ${task.id} has no scoring file in the scoring directory`);
    for (const testId of task.allowedTests) {
      const oracle = scored.oracles?.find((candidate) => candidate.testId === testId);
      if (!oracle) throw new Error(`task ${task.id} test ${testId} has no oracle registered`);
      if (oracle.kind === "script" && !oracle.script?.trim())
        throw new Error(`task ${task.id} test ${testId} has an empty script oracle`);
      if (oracle.kind === "expected_files" && !Object.keys(scored.expectedFiles ?? {}).length)
        throw new Error(`task ${task.id} test ${testId} has an empty expected_files oracle`);
    }
  }
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

export async function loadTasks(root: string): Promise<HybridTask[]> {
  const files = (await readdir(root)).filter((file) => file.endsWith(".json")).sort();
  const tasks: HybridTask[] = [];
  for (const file of files)
    tasks.push(parseHybridTask(JSON.parse(await readFile(join(root, file), "utf8")), file));
  if (!tasks.length) throw new Error("No hybrid-state tasks found");
  return tasks;
}

export async function loadScoring(
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
    schemaVersion: RESULT_SCHEMA_VERSION,
    protocolId: PROTOCOL_ID,
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

function inputHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Hybrid experiment failed");
    process.exitCode = 1;
  });
