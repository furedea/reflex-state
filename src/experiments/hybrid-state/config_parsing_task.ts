import {
  arrayField,
  isNonBlankString,
  object,
  optionalField,
  optionalFileMap,
  optionalStringList,
  stringOf,
} from "./config_parsing_fields.js";
import type {
  CheckpointRequirement,
  HybridTask,
  RequirementKind,
  RequirementScope,
  TaskCheckpoint,
  TaskInjection,
  TaskOracle,
  TaskScoring,
  TaskStep,
} from "./types.js";

export function parseHybridTask(value: unknown, file: string): HybridTask {
  const raw = object(value, `task ${file}`);
  if (!isNonBlankString(raw.id)) throw new Error(`Invalid task id in ${file}`);
  if (!isNonBlankString(raw.instruction)) throw new Error(`Invalid task instruction in ${file}`);
  const files = parseTaskFiles(raw.files, file);
  const allowedTests = parseAllowedTests(raw.allowedTests ?? raw.tests, file);
  const injections = parseInjections(raw.injections ?? [], file);
  const steps = raw.steps;
  if (steps !== undefined && !Array.isArray(steps)) throw new Error(`Invalid steps in ${file}`);
  const expectedFiles = optionalFileMap(raw, file);
  return {
    id: raw.id,
    instruction: raw.instruction,
    files,
    allowedTests,
    injections,
    ...(expectedFiles ? { expectedFiles } : {}),
    ...(steps ? { steps: steps as TaskStep[] } : {}),
  };
}

function parseTaskFiles(value: unknown, file: string): Record<string, string> {
  const files = object(value, `task ${file} files`);
  for (const [path, content] of Object.entries(files))
    if (typeof content !== "string") throw new Error(`Invalid file ${path} in ${file}`);
  return files as Record<string, string>;
}

function parseAllowedTests(value: unknown, file: string): string[] {
  if (!Array.isArray(value) || value.some((test) => typeof test !== "string"))
    throw new Error(`Invalid allowedTests in ${file}`);
  return [...(value as string[])];
}

function parseInjections(injections: unknown, file: string): TaskInjection[] {
  if (!Array.isArray(injections)) throw new Error(`Invalid injections in ${file}`);
  for (const injection of injections) {
    const record = object(injection, `injection in ${file}`);
    if (!isValidInjectionStep(record.step) || !isNonBlankString(record.text))
      throw new Error(`Invalid injection in ${file}`);
  }
  return injections.map((injection) => ({
    step: (injection as Record<string, unknown>).step as number,
    text: (injection as Record<string, unknown>).text as string,
  }));
}

function isValidInjectionStep(step: unknown): step is number {
  return Number.isInteger(step) && (step as number) >= 0;
}

export function parseTaskScoring(value: unknown, file: string): TaskScoring {
  const raw = object(value, `scoring ${file}`);
  if (!isNonBlankString(raw.taskId)) throw new Error(`Invalid taskId in ${file}`);
  const oracles = arrayField(raw, "oracles", `Invalid oracles in ${file}`);
  const parsedOracles = oracles.map((oracle) => parseOracle(oracle, file));
  const checkpoints = arrayField(raw, "checkpoints", `Invalid checkpoints in ${file}`);
  const parsedCheckpoints = checkpoints.map((checkpoint) => parseCheckpoint(checkpoint, file));
  const expectedFiles = optionalFileMap(raw, file);
  return {
    taskId: raw.taskId,
    oracles: parsedOracles,
    checkpoints: parsedCheckpoints,
    ...(expectedFiles ? { expectedFiles } : {}),
  };
}

function parseOracle(oracle: unknown, file: string): TaskOracle {
  const record = object(oracle, `oracle in ${file}`);
  if (!isNonBlankString(record.testId)) throw new Error(`Invalid oracle testId in ${file}`);
  if (record.kind === "script") {
    if (!isNonBlankString(record.script))
      throw new Error(`Script oracle ${record.testId} in ${file} needs a script`);
    return { testId: record.testId, kind: "script", script: record.script };
  }
  if (record.kind === "expected_files") return { testId: record.testId, kind: "expected_files" };
  throw new Error(`Invalid oracle kind in ${file}`);
}

function parseCheckpoint(checkpoint: unknown, file: string): TaskCheckpoint {
  const record = object(checkpoint, `checkpoint in ${file}`);
  if (!isNonBlankString(record.id)) throw new Error(`Invalid checkpoint id in ${file}`);
  if (!isValidCheckpointPosition(record.at))
    throw new Error(`Invalid checkpoint position in ${file}`);
  const required = record.required;
  if (!Array.isArray(required)) throw new Error(`Invalid required in ${file}`);
  const items = required.map((item) => parseRequirement(item, file));
  const appliesWhen = record.appliesWhen;
  if (appliesWhen !== undefined && appliesWhen !== "always" && appliesWhen !== "failure_observed")
    throw new Error(`Invalid appliesWhen in ${file}`);
  return {
    id: record.id,
    at: record.at as number | "final",
    ...(typeof appliesWhen === "string" ? { appliesWhen } : {}),
    required: items,
  };
}

function isValidCheckpointPosition(position: unknown): boolean {
  return position === "final" || (Number.isInteger(position) && (position as number) >= 0);
}

function parseRequirement(item: unknown, file: string): CheckpointRequirement {
  const entry = object(item, `required item in ${file}`);
  if (!isNonBlankString(entry.id)) throw new Error(`Invalid required item id in ${file}`);
  const kind = requirementKind(entry, file);
  const anyOf = parseAnyOf(entry, file);
  checkKindFields(entry, kind, file);
  checkOptionalTypes(entry, file);
  const scope = parseScope(entry, file);
  const lists = listFields(entry, file);
  return {
    id: entry.id,
    ...optionalField("description", stringOf(entry.description)),
    kind,
    ...optionalField("anyOf", anyOf),
    ...optionalField("inverted", lists.inverted),
    ...optionalField("condition", stringOf(entry.condition)),
    ...optionalField("scope", scope),
    ...optionalField("value", stringOf(entry.value)),
    ...optionalField("name", stringOf(entry.name)),
    ...optionalField("testId", stringOf(entry.testId)),
    ...optionalField("status", entry.status as "passed" | "failed" | undefined),
    ...optionalField("fresh", entry.fresh as boolean | undefined),
    ...optionalField("markers", lists.markers),
    ...optionalField("sections", lists.sections),
  };
}

/** The id of a required item that has already passed the non-blank check. */
function requirementId(entry: Record<string, unknown>): string {
  return entry.id as string;
}

function requirementKind(entry: Record<string, unknown>, file: string): RequirementKind {
  const kind = entry.kind === undefined ? "verbatim" : entry.kind;
  if (kind !== "verbatim" && kind !== "exact_value" && kind !== "verification")
    throw new Error(`Invalid kind for required item ${requirementId(entry)} in ${file}`);
  return kind;
}

function parseAnyOf(entry: Record<string, unknown>, file: string): string[][] | undefined {
  const anyOf = entry.anyOf;
  if (anyOf === undefined) return undefined;
  if (!Array.isArray(anyOf) || !anyOf.length || !anyOf.every(isPhraseGroup))
    throw new Error(`Invalid anyOf for required item ${requirementId(entry)} in ${file}`);
  return (anyOf as string[][]).map((group) => [...group]);
}

function isPhraseGroup(group: unknown): boolean {
  return Array.isArray(group) && group.length > 0 && group.every(isNonBlankString);
}

function checkKindFields(entry: Record<string, unknown>, kind: RequirementKind, file: string) {
  const id = requirementId(entry);
  if (kind === "verbatim" && entry.anyOf === undefined)
    throw new Error(`verbatim required item ${id} in ${file} needs anyOf`);
  if (kind === "exact_value" && !isNonBlankString(entry.value))
    throw new Error(`exact_value required item ${id} in ${file} needs a value`);
  if (kind === "verification" && !isNonBlankString(entry.testId))
    throw new Error(`verification required item ${id} in ${file} needs a testId`);
}

function checkOptionalTypes(entry: Record<string, unknown>, file: string) {
  const id = requirementId(entry);
  if (entry.condition !== undefined && typeof entry.condition !== "string")
    throw new Error(`Invalid condition for required item ${id} in ${file}`);
  if (entry.status !== undefined && entry.status !== "passed" && entry.status !== "failed")
    throw new Error(`Invalid status for required item ${id} in ${file}`);
  if (entry.fresh !== undefined && typeof entry.fresh !== "boolean")
    throw new Error(`Invalid fresh for required item ${id} in ${file}`);
}

function parseScope(entry: Record<string, unknown>, file: string): RequirementScope | undefined {
  const id = requirementId(entry);
  if (entry.scope === undefined) return undefined;
  const record = object(entry.scope, `scope of ${id} in ${file}`);
  const clause = (key: string) =>
    optionalStringList(record, key, `Invalid scope.${key} for required item ${id} in ${file}`);
  const memoryKinds = clause("memoryKinds");
  const trusts = clause("trusts");
  const roles = clause("roles");
  return {
    ...optionalField("memoryKinds", memoryKinds),
    ...optionalField("trusts", trusts),
    ...optionalField("roles", roles),
  };
}

function listFields(entry: Record<string, unknown>, file: string) {
  const id = requirementId(entry);
  const list = (key: string) =>
    optionalStringList(entry, key, `Invalid ${key} for required item ${id} in ${file}`);
  return { inverted: list("inverted"), markers: list("markers"), sections: list("sections") };
}
