import {
  isExperimentMode,
  type EvaluationKind,
  type ExperimentMode,
  type HybridConfig,
  type HybridTask,
  type ProviderMode,
  type RequirementKind,
  type TaskScoring,
  type TaskStep,
} from "./types.js";

const PROVIDER_MODES = new Set(["fake", "recorded", "live"]);
const EVALUATIONS = new Set(["trace_audit", "closed_loop"]);
const PROVIDER_KEYS = new Set([
  "mode",
  "jevModel",
  "actorModel",
  "repairModel",
  "updateModel",
  "maxRequests",
  "trialMaxRequests",
  "timeoutMs",
  "executionIsolation",
]);
const BUDGET_KEYS = new Set([
  "memoryBytes",
  "factsBytes",
  "latestObservationBytes",
  "requestBytes",
  "maxQuestions",
  "maxRepairCalls",
  "maxActions",
]);
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "evaluation",
  "provider",
  "budgets",
  "modes",
  "seed",
  "iterations",
  "recordContextText",
  "recordResponseText",
  "candidateMaxBytes",
  "taskRoot",
]);

export function parseHybridConfig(value: unknown): HybridConfig {
  const raw = object(value, "config");
  unknownKeys(raw, CONFIG_KEYS, "config");
  if (raw.schemaVersion !== 2)
    throw new Error("Unsupported hybrid-state config version (expected 2)");
  if (typeof raw.evaluation !== "string" || !EVALUATIONS.has(raw.evaluation))
    throw new Error("Invalid hybrid-state evaluation");
  const provider = object(raw.provider, "provider");
  unknownKeys(provider, PROVIDER_KEYS, "provider");
  const budgets = object(raw.budgets, "budgets");
  unknownKeys(budgets, BUDGET_KEYS, "budgets");
  if (!Array.isArray(raw.modes) || !raw.modes.length || !raw.modes.every(isExperimentMode))
    throw new Error("Config modes must be a non-empty list of supported modes");
  if (new Set(raw.modes).size !== raw.modes.length)
    throw new Error("Config modes must not contain duplicates");
  const providerMode = provider.mode;
  if (typeof providerMode !== "string" || !PROVIDER_MODES.has(providerMode))
    throw new Error("Invalid provider mode");
  const model = (key: "jevModel" | "actorModel" | "repairModel" | "updateModel") => {
    const value = provider[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim())
      throw new Error(`Invalid provider.${key}: model IDs must be non-empty`);
    return value;
  };
  const models = {
    jevModel: model("jevModel"),
    actorModel: model("actorModel"),
    repairModel: model("repairModel"),
    updateModel: model("updateModel"),
  };
  if (providerMode === "live") {
    const needsActor = raw.evaluation === "closed_loop";
    const needsJev = (raw.modes as ExperimentMode[]).includes("jev");
    const needsUpdate = raw.evaluation === "trace_audit" && raw.modes.includes("llm");
    if (needsActor && !models.actorModel)
      throw new Error("Live closed_loop config requires provider.actorModel");
    if (needsJev && !models.jevModel)
      throw new Error("Live config with the jev mode requires provider.jevModel");
    if (needsUpdate && !models.updateModel && !models.actorModel)
      throw new Error("Live audit with the llm mode requires provider.updateModel or actorModel");
    if (
      !needsJev &&
      models.jevModel &&
      !(raw.modes as ExperimentMode[]).includes("jev") &&
      providerMode === "live"
    ) {
      // An unused Jev model is permitted but must never be instantiated silently.
    }
  }
  const integer = (obj: Record<string, unknown>, key: string, min: number) => {
    const number = obj[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < min)
      throw new Error(`Invalid config ${key}: expected an integer >= ${min}`);
    return number;
  };
  const maxRequests = integer(provider, "maxRequests", 1);
  const trialMaxRequests =
    provider.trialMaxRequests === undefined
      ? maxRequests
      : integer(provider, "trialMaxRequests", 1);
  if (trialMaxRequests > maxRequests)
    throw new Error("provider.trialMaxRequests must not exceed provider.maxRequests");
  return {
    schemaVersion: 2,
    evaluation: raw.evaluation as EvaluationKind,
    provider: {
      mode: providerMode as ProviderMode,
      ...(models.jevModel ? { jevModel: models.jevModel } : {}),
      ...(models.actorModel ? { actorModel: models.actorModel } : {}),
      ...(models.repairModel ? { repairModel: models.repairModel } : {}),
      ...(models.updateModel ? { updateModel: models.updateModel } : {}),
      maxRequests,
      trialMaxRequests,
      timeoutMs: integer(provider, "timeoutMs", 1),
      ...(provider.executionIsolation === "required"
        ? { executionIsolation: "required" as const }
        : provider.executionIsolation === undefined
          ? {}
          : (() => {
              throw new Error("Invalid provider.executionIsolation");
            })()),
    },
    budgets: {
      memoryBytes: integer(budgets, "memoryBytes", 1),
      factsBytes: integer(budgets, "factsBytes", 1),
      latestObservationBytes: integer(budgets, "latestObservationBytes", 1),
      requestBytes: integer(budgets, "requestBytes", 1),
      maxQuestions: integer(budgets, "maxQuestions", 1),
      maxRepairCalls: integer(budgets, "maxRepairCalls", 0),
      maxActions: integer(budgets, "maxActions", 1),
    },
    modes: [...(raw.modes as ExperimentMode[])],
    seed: integer(raw, "seed", 0),
    iterations: raw.iterations === undefined ? 1 : integer(raw, "iterations", 1),
    recordContextText: raw.recordContextText === true,
    recordResponseText: raw.recordResponseText === true,
    candidateMaxBytes: integer(raw, "candidateMaxBytes", 64),
    ...(typeof raw.taskRoot === "string" ? { taskRoot: raw.taskRoot } : {}),
  };
}

export function parseHybridTask(value: unknown, file: string): HybridTask {
  const raw = object(value, `task ${file}`);
  if (typeof raw.id !== "string" || !raw.id.trim()) throw new Error(`Invalid task id in ${file}`);
  if (typeof raw.instruction !== "string" || !raw.instruction.trim())
    throw new Error(`Invalid task instruction in ${file}`);
  const files = object(raw.files, `task ${file} files`);
  for (const [path, content] of Object.entries(files))
    if (typeof content !== "string") throw new Error(`Invalid file ${path} in ${file}`);
  const allowedTests = raw.allowedTests ?? raw.tests;
  if (!Array.isArray(allowedTests) || allowedTests.some((test) => typeof test !== "string"))
    throw new Error(`Invalid allowedTests in ${file}`);
  const injections = raw.injections ?? [];
  if (!Array.isArray(injections)) throw new Error(`Invalid injections in ${file}`);
  for (const injection of injections) {
    const record = object(injection, `injection in ${file}`);
    if (
      !Number.isInteger(record.step) ||
      (record.step as number) < 0 ||
      typeof record.text !== "string" ||
      !record.text.trim()
    )
      throw new Error(`Invalid injection in ${file}`);
  }
  const steps = raw.steps === undefined ? undefined : raw.steps;
  if (steps !== undefined && !Array.isArray(steps)) throw new Error(`Invalid steps in ${file}`);
  const expectedFiles =
    raw.expectedFiles === undefined ? undefined : object(raw.expectedFiles, "expectedFiles");
  if (expectedFiles)
    for (const content of Object.values(expectedFiles))
      if (typeof content !== "string") throw new Error(`Invalid expectedFiles in ${file}`);
  return {
    id: raw.id,
    instruction: raw.instruction,
    files: files as Record<string, string>,
    allowedTests: [...(allowedTests as string[])],
    injections: injections.map((injection) => ({
      step: (injection as Record<string, unknown>).step as number,
      text: (injection as Record<string, unknown>).text as string,
    })),
    ...(expectedFiles ? { expectedFiles: expectedFiles as Record<string, string> } : {}),
    ...(steps ? { steps: steps as TaskStep[] } : {}),
  };
}

export function parseTaskScoring(value: unknown, file: string): TaskScoring {
  const raw = object(value, `scoring ${file}`);
  if (typeof raw.taskId !== "string" || !raw.taskId.trim())
    throw new Error(`Invalid taskId in ${file}`);
  const oracles = raw.oracles === undefined ? [] : raw.oracles;
  if (!Array.isArray(oracles)) throw new Error(`Invalid oracles in ${file}`);
  const parsedOracles = oracles.map((oracle) => {
    const record = object(oracle, `oracle in ${file}`);
    if (typeof record.testId !== "string" || !record.testId.trim())
      throw new Error(`Invalid oracle testId in ${file}`);
    if (record.kind === "script") {
      if (typeof record.script !== "string" || !record.script.trim())
        throw new Error(`Script oracle ${record.testId} in ${file} needs a script`);
      return { testId: record.testId, kind: "script" as const, script: record.script };
    }
    if (record.kind === "expected_files")
      return { testId: record.testId, kind: "expected_files" as const };
    throw new Error(`Invalid oracle kind in ${file}`);
  });
  const checkpoints = raw.checkpoints === undefined ? [] : raw.checkpoints;
  if (!Array.isArray(checkpoints)) throw new Error(`Invalid checkpoints in ${file}`);
  const parsedCheckpoints = checkpoints.map((checkpoint) => {
    const record = object(checkpoint, `checkpoint in ${file}`);
    if (typeof record.id !== "string" || !record.id.trim())
      throw new Error(`Invalid checkpoint id in ${file}`);
    if (!(record.at === "final" || (Number.isInteger(record.at) && (record.at as number) >= 0)))
      throw new Error(`Invalid checkpoint position in ${file}`);
    const required = record.required;
    if (!Array.isArray(required)) throw new Error(`Invalid required in ${file}`);
    const items = required.map((item) => {
      const entry = object(item, `required item in ${file}`);
      if (typeof entry.id !== "string" || !entry.id.trim())
        throw new Error(`Invalid required item id in ${file}`);
      const id = entry.id;
      const kind = entry.kind === undefined ? "verbatim" : entry.kind;
      if (kind !== "verbatim" && kind !== "exact_value" && kind !== "verification")
        throw new Error(`Invalid kind for required item ${id} in ${file}`);
      const strings = (key: string) => {
        const value = entry[key];
        if (value === undefined) return undefined;
        if (
          !Array.isArray(value) ||
          !value.every((item) => typeof item === "string" && item.trim())
        )
          throw new Error(`Invalid ${key} for required item ${id} in ${file}`);
        return [...(value as string[])];
      };
      const anyOf =
        entry.anyOf === undefined
          ? undefined
          : (() => {
              if (
                !Array.isArray(entry.anyOf) ||
                !entry.anyOf.length ||
                !entry.anyOf.every(
                  (group) =>
                    Array.isArray(group) &&
                    group.length > 0 &&
                    group.every((phrase) => typeof phrase === "string" && phrase.trim()),
                )
              )
                throw new Error(`Invalid anyOf for required item ${id} in ${file}`);
              return (entry.anyOf as string[][]).map((group) => [...group]);
            })();
      if (kind === "verbatim" && !anyOf)
        throw new Error(`verbatim required item ${id} in ${file} needs anyOf`);
      if (kind === "exact_value" && (typeof entry.value !== "string" || !entry.value.trim()))
        throw new Error(`exact_value required item ${id} in ${file} needs a value`);
      if (kind === "verification" && (typeof entry.testId !== "string" || !entry.testId.trim()))
        throw new Error(`verification required item ${id} in ${file} needs a testId`);
      if (entry.condition !== undefined && typeof entry.condition !== "string")
        throw new Error(`Invalid condition for required item ${id} in ${file}`);
      if (entry.status !== undefined && entry.status !== "passed" && entry.status !== "failed")
        throw new Error(`Invalid status for required item ${id} in ${file}`);
      if (entry.fresh !== undefined && typeof entry.fresh !== "boolean")
        throw new Error(`Invalid fresh for required item ${id} in ${file}`);
      const scope = (() => {
        if (entry.scope === undefined) return undefined;
        const record = object(entry.scope, `scope of ${id} in ${file}`);
        const clause = (key: string) => {
          const value = record[key];
          if (value === undefined) return undefined;
          if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim()))
            throw new Error(`Invalid scope.${key} for required item ${id} in ${file}`);
          return [...(value as string[])];
        };
        return {
          ...(clause("memoryKinds") ? { memoryKinds: clause("memoryKinds")! } : {}),
          ...(clause("trusts") ? { trusts: clause("trusts")! } : {}),
          ...(clause("roles") ? { roles: clause("roles")! } : {}),
        };
      })();
      return {
        id,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        kind: kind as RequirementKind,
        ...(anyOf ? { anyOf } : {}),
        ...(strings("inverted") ? { inverted: strings("inverted")! } : {}),
        ...(typeof entry.condition === "string" ? { condition: entry.condition } : {}),
        ...(scope ? { scope } : {}),
        ...(typeof entry.value === "string" ? { value: entry.value } : {}),
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        ...(typeof entry.testId === "string" ? { testId: entry.testId } : {}),
        ...(entry.status !== undefined ? { status: entry.status as "passed" | "failed" } : {}),
        ...(entry.fresh !== undefined ? { fresh: entry.fresh as boolean } : {}),
        ...(strings("markers") ? { markers: strings("markers")! } : {}),
        ...(strings("sections") ? { sections: strings("sections")! } : {}),
      };
    });
    if (
      record.appliesWhen !== undefined &&
      record.appliesWhen !== "always" &&
      record.appliesWhen !== "failure_observed"
    )
      throw new Error(`Invalid appliesWhen in ${file}`);
    return {
      id: record.id,
      at: record.at as number | "final",
      ...(typeof record.appliesWhen === "string"
        ? { appliesWhen: record.appliesWhen as "always" | "failure_observed" }
        : {}),
      required: items,
    };
  });
  const expectedFiles =
    raw.expectedFiles === undefined ? undefined : object(raw.expectedFiles, "expectedFiles");
  if (expectedFiles)
    for (const content of Object.values(expectedFiles))
      if (typeof content !== "string") throw new Error(`Invalid expectedFiles in ${file}`);
  return {
    taskId: raw.taskId,
    oracles: parsedOracles,
    checkpoints: parsedCheckpoints,
    ...(expectedFiles ? { expectedFiles: expectedFiles as Record<string, string> } : {}),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function unknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, name: string) {
  for (const key of Object.keys(raw))
    if (!allowed.has(key)) throw new Error(`Unknown ${name} key: ${key}`);
}
