import { integerField, object, unknownKeys } from "./config_parsing_fields.js";
import {
  isExperimentMode,
  type EvaluationKind,
  type ExperimentMode,
  type HybridConfig,
  type ProviderMode,
} from "./types.js";

export { parseHybridTask, parseTaskScoring } from "./config_parsing_task.js";

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
const MODEL_KEYS: readonly ModelKey[] = ["jevModel", "actorModel", "repairModel", "updateModel"];
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
  const evaluation = raw.evaluation as EvaluationKind;
  const provider = object(raw.provider, "provider");
  unknownKeys(provider, PROVIDER_KEYS, "provider");
  const budgets = object(raw.budgets, "budgets");
  unknownKeys(budgets, BUDGET_KEYS, "budgets");
  const modes = parseModes(raw.modes);
  return {
    schemaVersion: 2,
    evaluation,
    provider: parseProvider(provider, evaluation, modes),
    budgets: parseBudgets(budgets),
    modes,
    seed: integerField(raw, "seed", 0),
    iterations: raw.iterations === undefined ? 1 : integerField(raw, "iterations", 1),
    recordContextText: raw.recordContextText === true,
    recordResponseText: raw.recordResponseText === true,
    candidateMaxBytes: integerField(raw, "candidateMaxBytes", 64),
    ...(typeof raw.taskRoot === "string" ? { taskRoot: raw.taskRoot } : {}),
  };
}

function parseModes(value: unknown): ExperimentMode[] {
  if (!Array.isArray(value) || !value.length || !value.every(isExperimentMode))
    throw new Error("Config modes must be a non-empty list of supported modes");
  if (new Set(value).size !== value.length)
    throw new Error("Config modes must not contain duplicates");
  return [...(value as ExperimentMode[])];
}

type ModelKey = "jevModel" | "actorModel" | "repairModel" | "updateModel";
type ProviderModels = { readonly [K in ModelKey]: string | undefined };

function parseProvider(
  provider: Record<string, unknown>,
  evaluation: EvaluationKind,
  modes: readonly ExperimentMode[],
): HybridConfig["provider"] {
  const providerMode = provider.mode;
  if (typeof providerMode !== "string" || !PROVIDER_MODES.has(providerMode))
    throw new Error("Invalid provider mode");
  const models = parseModels(provider);
  if (providerMode === "live") requireLiveModels(models, evaluation, modes);
  const maxRequests = integerField(provider, "maxRequests", 1);
  const trialMaxRequests =
    provider.trialMaxRequests === undefined
      ? maxRequests
      : integerField(provider, "trialMaxRequests", 1);
  if (trialMaxRequests > maxRequests)
    throw new Error("provider.trialMaxRequests must not exceed provider.maxRequests");
  return {
    mode: providerMode as ProviderMode,
    ...presentModels(models),
    maxRequests,
    trialMaxRequests,
    timeoutMs: integerField(provider, "timeoutMs", 1),
    ...executionIsolationField(provider.executionIsolation),
  };
}

function parseModels(provider: Record<string, unknown>): ProviderModels {
  const model = (key: ModelKey) => {
    const value = provider[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim())
      throw new Error(`Invalid provider.${key}: model IDs must be non-empty`);
    return value;
  };
  return {
    jevModel: model("jevModel"),
    actorModel: model("actorModel"),
    repairModel: model("repairModel"),
    updateModel: model("updateModel"),
  };
}

function requireLiveModels(
  models: ProviderModels,
  evaluation: EvaluationKind,
  modes: readonly ExperimentMode[],
) {
  if (evaluation === "closed_loop" && !models.actorModel)
    throw new Error("Live closed_loop config requires provider.actorModel");
  if (modes.includes("jev") && !models.jevModel)
    throw new Error("Live config with the jev mode requires provider.jevModel");
  if (
    evaluation === "trace_audit" &&
    modes.includes("llm") &&
    !models.updateModel &&
    !models.actorModel
  )
    throw new Error("Live audit with the llm mode requires provider.updateModel or actorModel");
}

function presentModels(models: ProviderModels): { readonly [K in ModelKey]?: string } {
  const present: { -readonly [K in ModelKey]?: string } = {};
  for (const key of MODEL_KEYS) if (models[key]) present[key] = models[key];
  return present;
}

function executionIsolationField(value: unknown): { readonly executionIsolation?: "required" } {
  if (value === undefined) return {};
  if (value === "required") return { executionIsolation: "required" };
  throw new Error("Invalid provider.executionIsolation");
}

function parseBudgets(budgets: Record<string, unknown>): HybridConfig["budgets"] {
  return {
    memoryBytes: integerField(budgets, "memoryBytes", 1),
    factsBytes: integerField(budgets, "factsBytes", 1),
    latestObservationBytes: integerField(budgets, "latestObservationBytes", 1),
    requestBytes: integerField(budgets, "requestBytes", 1),
    maxQuestions: integerField(budgets, "maxQuestions", 1),
    maxRepairCalls: integerField(budgets, "maxRepairCalls", 0),
    maxActions: integerField(budgets, "maxActions", 1),
  };
}
