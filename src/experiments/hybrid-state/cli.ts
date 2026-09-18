#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { reportMarkdown, loadLabels } from "./evaluation.js";
import { createLiveProviders, readRecordedProviders } from "./providers.js";
import { runAudit, runClosedLoop, type ExperimentRun } from "./runner.js";
import { parseTraceEntries } from "./trace.js";
import { parseHybridConfig, type HybridConfig, type HybridTask } from "./types.js";

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
  if (command === "audit") await audit(values);
  else if (command === "run") await run(values);
  else if (command === "report") await report(values);
  else throw new Error("Usage: experiment:hybrid audit|run|report [options]");
}

async function audit(values: Record<string, string | boolean | undefined>): Promise<void> {
  const config = await loadHybridConfig(values.config, "trace_audit", values.live === true);
  const session = typeof values.session === "string" ? values.session : undefined;
  const casePath =
    session ??
    (typeof values.case === "string" ? values.case : "experiments/hybrid-state/cases/basic.jsonl");
  const leaf = typeof values.leaf === "string" ? values.leaf : undefined;
  const trace = session
    ? await parseSession(session, leaf)
    : parseTraceEntries(await readJsonLines(casePath), {
        synthetic: true,
        ...(leaf ? { leaf } : {}),
      });
  const labelsPath =
    typeof values.labels === "string"
      ? values.labels
      : "experiments/hybrid-state/labels/basic.json";
  const labels = await loadLabels(labelsPath);
  const providers = await providerSet(config, values);
  const result = await runAudit({ config, trace, labels, providers });
  await writeRun(values.out as string, result);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function run(values: Record<string, string | boolean | undefined>): Promise<void> {
  const config = await loadHybridConfig(values.config, "closed_loop", values.live === true);
  const taskRoot = config.taskRoot ?? "experiments/hybrid-state/tasks";
  const tasks = await loadTasks(taskRoot);
  const providers = await providerSet(config, values, tasks);
  const result = await runClosedLoop({ config, tasks, providers });
  await writeRun(values.out as string, result);
  console.log(JSON.stringify(result.summary, null, 2));
}

async function report(values: Record<string, string | boolean | undefined>): Promise<void> {
  const input = values.input ?? values.out;
  if (!input) throw new Error("report requires --input <result directory>");
  const summary = JSON.parse(await readFile(join(input as string, "summary.json"), "utf8"));
  const text = reportMarkdown(summary);
  console.log(text);
}

async function loadHybridConfig(
  path: string | boolean | undefined,
  evaluation: HybridConfig["evaluation"],
  live: boolean,
): Promise<HybridConfig> {
  const configPath =
    typeof path === "string"
      ? path
      : evaluation === "trace_audit"
        ? "experiments/hybrid-state/config.offline.json"
        : "experiments/hybrid-state/config.offline.json";
  const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const config = parseHybridConfig(raw);
  if (config.evaluation !== evaluation) return { ...config, evaluation };
  if (live && config.provider.mode !== "live")
    throw new Error("--live requires provider.mode=live");
  if (config.provider.mode === "live" && !live) throw new Error("Live provider requires --live");
  return config;
}

async function providerSet(
  config: HybridConfig,
  values: Record<string, string | boolean | undefined>,
  tasks: readonly HybridTask[] = [],
) {
  if (config.provider.mode === "fake") {
    const { FakeActorProvider, FakeJevProvider, FakeRepairProvider } =
      await import("./providers.js");
    return {
      jev: new FakeJevProvider(),
      repair: new FakeRepairProvider(),
      actor: new FakeActorProvider(tasks),
    };
  }
  if (config.provider.mode === "recorded") {
    if (typeof values.recorded !== "string")
      throw new Error("Recorded provider requires --recorded");
    return readRecordedProviders(values.recorded);
  }
  if (!config.provider.jevModel || !config.provider.actorModel)
    throw new Error("Live provider models are required");
  return createLiveProviders({
    jevModel: config.provider.jevModel,
    actorModel: config.provider.actorModel,
    ...(config.provider.repairModel ? { repairModel: config.provider.repairModel } : {}),
  });
}

async function parseSession(path: string, leaf: string | boolean | undefined) {
  return parseTraceEntries(await readJsonLines(path), {
    session: path,
    ...(typeof leaf === "string" ? { leaf } : {}),
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
  for (const file of files) {
    const value: unknown = JSON.parse(await readFile(join(root, file), "utf8"));
    if (!value || typeof value !== "object") throw new Error(`Invalid task: ${file}`);
    tasks.push(value as HybridTask);
  }
  if (!tasks.length) throw new Error("No hybrid-state tasks found");
  return tasks;
}

async function writeRun(directory: string, result: ExperimentRun): Promise<void> {
  const target = resolve(directory);
  try {
    await access(target, constants.F_OK);
    const files = await readdir(target);
    if (files.length) throw new Error(`Output exists and is not empty: ${directory}`);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      )
    )
      throw error;
  }
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "manifest.json"), JSON.stringify(result.manifest, null, 2) + "\n");
  await writeFile(join(target, "updates.jsonl"), jsonLines(result.updates));
  await writeFile(join(target, "calls.jsonl"), jsonLines(result.calls));
  await writeFile(join(target, "contexts.jsonl"), jsonLines(result.contexts));
  await writeFile(join(target, "summary.json"), JSON.stringify(result.summary, null, 2) + "\n");
  await writeFile(join(target, "report.md"), reportMarkdown(result.summary));
}

function jsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Hybrid experiment failed");
  process.exitCode = 1;
});
