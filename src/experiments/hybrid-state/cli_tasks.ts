import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseHybridTask, parseTaskScoring } from "./config_parsing.js";
import type { HybridTask, TaskScoring } from "./types.js";

export interface ScoredTasks {
  readonly tasks: readonly HybridTask[];
  readonly scoring: ReadonlyMap<string, TaskScoring>;
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
    for (const testId of task.allowedTests) validateOracle(task.id, testId, scored);
  }
}

function validateOracle(taskId: string, testId: string, scored: TaskScoring): void {
  const oracle = scored.oracles?.find((candidate) => candidate.testId === testId);
  if (!oracle) throw new Error(`task ${taskId} test ${testId} has no oracle registered`);
  if (oracle.kind === "script" && !oracle.script?.trim())
    throw new Error(`task ${taskId} test ${testId} has an empty script oracle`);
  if (oracle.kind === "expected_files" && !Object.keys(scored.expectedFiles ?? {}).length)
    throw new Error(`task ${taskId} test ${testId} has an empty expected_files oracle`);
}

export function taskInputHash(tasks: readonly HybridTask[]): string {
  return tasks.map((task) => JSON.stringify(task)).join("\n");
}
