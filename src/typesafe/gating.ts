import type { ReflexStateConfig } from "../core/config.js";
import type { GatedDecision } from "../core/types.js";

export class InvalidResponseError extends Error {
  constructor() {
    super("Invalid response shape from TypeSafe");
    this.name = "InvalidResponseError";
  }
}

export function gateNoul(
  answer: unknown,
  thresholds: ReflexStateConfig["thresholds"],
): GatedDecision<boolean> {
  const probability = object(answer).noul;
  if (!isProbability(probability)) throw new InvalidResponseError();
  if (probability >= thresholds.noulAccept) return { value: true, gate: "applied", probability };
  if (probability <= thresholds.noulReject) return { value: false, gate: "applied", probability };
  return { value: null, gate: "uncertain", probability };
}

export function gateChoice<T extends string>(
  answer: unknown,
  choices: readonly T[],
  thresholds: ReflexStateConfig["thresholds"],
): GatedDecision<T> {
  const response = object(answer);
  const choice = choices.find((value) => value === response.choice);
  const confidence = response.confidence;
  const distribution = object(response.probabilities);
  if (!choice || !isProbability(confidence)) throw new InvalidResponseError();
  const probabilities: Record<string, number> = {};
  for (const label of choices) {
    const probability = distribution[label];
    if (!isProbability(probability)) throw new InvalidResponseError();
    probabilities[label] = probability;
  }
  const margin =
    (probabilities[choice] ?? 0) -
    Math.max(
      0,
      ...choices.filter((label) => label !== choice).map((label) => probabilities[label] ?? 0),
    );
  const applied =
    confidence >= thresholds.minChoiceConfidence && margin >= thresholds.minChoiceMargin;
  return {
    value: applied ? choice : null,
    gate: applied ? "applied" : "uncertain",
    confidence,
    probabilities,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidResponseError();
  return value as Record<string, unknown>;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
