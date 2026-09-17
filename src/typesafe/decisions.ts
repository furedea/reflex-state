import type { ReflexStateConfig } from "../core/config.js";
import { isRecord } from "../core/serialization.js";
import type { EventId, SemanticDecisions } from "../core/types.js";
import { emptyDecisions } from "../core/updater.js";
import { gateChoice, gateNoul, InvalidResponseError } from "./gating.js";
import { categories, phases } from "./questions.js";

export function decodeDecisions(
  response: unknown,
  ids: readonly string[],
  thresholds: ReflexStateConfig["thresholds"],
): SemanticDecisions {
  const result = record(response);
  const answers = record(result.answers);
  const usage = result.usage === undefined ? {} : record(result.usage);
  return {
    ...emptyDecisions(),
    ...(ids.includes("blocker_introduced")
      ? { blockerIntroduced: gateNoul(answers.blocker_introduced, thresholds) }
      : {}),
    ...(ids.includes("failure_category")
      ? { failureCategory: gateChoice(answers.failure_category, categories, thresholds) }
      : {}),
    ...(ids.includes("task_complete")
      ? { taskComplete: gateNoul(answers.task_complete, thresholds) }
      : {}),
    ...(ids.includes("phase_shadow")
      ? { phaseShadow: { ...gateChoice(answers.phase_shadow, phases, thresholds), shadow: true } }
      : {}),
    resolvedBlockers: ids
      .filter((id) => id.startsWith("resolves_"))
      .map((id) => ({
        eventId: id.slice(9) as EventId,
        decision: gateNoul(answers[id], thresholds),
      })),
    relevance: ids
      .filter((id) => id.startsWith("relevant_"))
      .map((id) => ({
        eventId: id.slice(9) as EventId,
        decision: gateNoul(answers[id], thresholds),
      })),
    telemetry: {
      questionsAsked: ids.length,
      questionIds: ids,
      ...(typeof result.model === "string" ? { model: result.model } : {}),
      ...(measured(usage.input_tokens) ? { inputTokens: usage.input_tokens } : {}),
      ...(measured(usage.output_tokens) ? { outputTokens: usage.output_tokens } : {}),
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidResponseError();
  return value as Record<string, unknown>;
}

export function errorDecisions(ids: readonly string[], error: string): SemanticDecisions {
  const decision = { value: null, gate: "error" as const };
  return {
    ...emptyDecisions(),
    ...(ids.includes("blocker_introduced") ? { blockerIntroduced: decision } : {}),
    ...(ids.includes("failure_category") ? { failureCategory: decision } : {}),
    ...(ids.includes("task_complete") ? { taskComplete: decision } : {}),
    ...(ids.includes("phase_shadow") ? { phaseShadow: { ...decision, shadow: true } } : {}),
    resolvedBlockers: ids
      .filter((id) => id.startsWith("resolves_"))
      .map((id) => ({ eventId: id.slice(9) as EventId, decision })),
    relevance: ids
      .filter((id) => id.startsWith("relevant_"))
      .map((id) => ({ eventId: id.slice(9) as EventId, decision })),
    telemetry: { questionsAsked: ids.length, questionIds: ids, error },
  };
}
function measured(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function describeResponse(
  response: unknown,
  ids: readonly string[],
): Record<string, string> {
  const root = isRecord(response) ? response : {};
  const answers = isRecord(root.answers) ? root.answers : {};
  const shape: Record<string, string> = {
    response: valueType(response),
    answers: valueType(root.answers),
    usage: valueType(root.usage),
  };
  for (const id of ids) {
    const answer = answers[id];
    shape["answers." + id] = valueType(answer);
    if (!isRecord(answer)) continue;
    for (const field of ["noul", "choice", "confidence", "probabilities"])
      if (Object.hasOwn(answer, field))
        shape["answers." + id + "." + field] = valueType(answer[field]);
  }
  return shape;
}

function valueType(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
