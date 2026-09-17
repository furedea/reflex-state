import type { StateUpdateContext } from "../core/updater.js";
import type { Question } from "./client.js";
import { buildRequestPlan } from "./request_plan.js";

export const phases = [
  "planning",
  "exploring",
  "editing",
  "testing",
  "debugging",
  "done",
  "unknown",
] as const;
export const categories = [
  "implementation",
  "environment",
  "dependency",
  "test",
  "permissions",
  "network",
  "unknown",
] as const;

export function buildQuestions(context: StateUpdateContext): Record<string, Question> {
  const questions: Record<string, Question> = {};
  const plan = buildRequestPlan(context);
  for (const item of plan.items) {
    if (item.kind === "blocker_introduced")
      questions[item.id] = noul(
        "Does this observation introduce a currently unresolved blocker to the user's goal?",
      );
    if (item.kind === "failure_category")
      questions[item.id] = choice(
        "Classify the cause of this failure using the evidence. Choose unknown when it does not establish a cause.",
        categories,
      );
    if (item.kind === "resolve")
      questions[item.id] = noul(
        "Does the latest observation resolve or supersede blocker " +
          item.eventId +
          "? Success alone is insufficient without evidence of a relationship.",
      );
    if (item.kind === "relevance")
      questions[item.id] = noul(
        "Is evidence " + item.eventId + " still relevant to the current user goal?",
      );
    if (item.kind === "task_complete")
      questions[item.id] = noul(
        "Does the final response and verification evidence establish that the current user goal is fully completed? An aborted or failed run is not completion.",
      );
    if (item.kind === "phase_shadow")
      questions[item.id] = choice(
        "What phase is the coding task currently in? This answer is recorded for comparison only.",
        phases,
      );
  }
  return questions;
}

function noul(instructions: string): Question {
  return { type: "noul", instructions };
}
function choice(instructions: string, values: readonly string[]): Question {
  return {
    type: "choice",
    instructions,
    criteria: Object.fromEntries(values.map((value) => [value, value.replaceAll("_", " ")])),
  };
}
