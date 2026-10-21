import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CliOptions } from "./cli_options.js";
import type { HybridConfig } from "./types.js";

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
  return { taskRoot: record.taskRoot, files: parseApprovedFiles(record.files, path) };
}

function parseApprovedFiles(files: unknown, path: string): Record<string, string> {
  if (!files || typeof files !== "object" || Array.isArray(files) || !Object.keys(files).length)
    throw new Error(`Invalid files in ${path}`);
  for (const [name, hash] of Object.entries(files))
    if (!isApprovedEntry(name, hash)) throw new Error(`Invalid files entry ${name} in ${path}`);
  return files as Record<string, string>;
}

function isApprovedEntry(name: string, hash: unknown): boolean {
  return (
    typeof hash === "string" &&
    Boolean(hash.trim()) &&
    !name.includes("..") &&
    !name.startsWith("/")
  );
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
  rejectLiveInputs(values);
  requireStageAShape(config);
  const taskRoot = resolve(config.taskRoot ?? "experiments/hybrid-state/tasks");
  if (!taskRoot.startsWith(`${APPROVED_TASK_ROOT}/`))
    throw new Error("Live execution requires checked-in task fixtures under experiments/");
  await verifyApprovedTasks(taskRoot);
}

function rejectLiveInputs(values: CliOptions): void {
  for (const input of ["session", "case", "recorded"] as const)
    if (typeof values[input] === "string")
      throw new Error(`Live provider does not accept --${input} inputs`);
}

function requireStageAShape(config: HybridConfig): void {
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
}
