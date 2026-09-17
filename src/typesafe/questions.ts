import { admitsEvidence } from "../core/reducer.js";
import type { StateUpdateContext } from "../core/updater.js";
import type { Question } from "./client.js";

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

export function buildQuestions({
  event,
  facts,
  state,
  config,
}: StateUpdateContext): Record<string, Question> {
  const questions: Record<string, Question> = {};
  if (event.type === "tool_result" && ["read", "grep", "find", "ls"].includes(event.toolName))
    return questions;
  if (event.type === "tool_result" && event.isError) {
    if (facts.verification?.status !== "failed")
      questions.blocker_introduced = noul(
        "Does this observation introduce a currently unresolved blocker to the user's goal?",
      );
    questions.failure_category = choice(
      "Classify the cause of this failure using the evidence. Choose unknown when it does not establish a cause.",
      categories,
    );
  }
  if (event.type === "tool_result" && !event.isError) {
    for (const blocker of state.activeBlockers
      .filter((candidate) => candidate.origin === "tool_error")
      .slice(0, 8)) {
      questions["resolves_" + blocker.eventId] = noul(
        "Does the latest observation resolve or supersede blocker " +
          blocker.eventId +
          "? Success alone is insufficient without evidence of a relationship.",
      );
    }
  }
  if (event.type === "agent_end")
    questions.task_complete = noul(
      "Does the final response and verification evidence establish that the current user goal is fully completed? An aborted or failed run is not completion.",
    );
  const remaining = state.workingSet.filter(
    (id) =>
      !facts.supersededInWorkingSet.includes(id) && !facts.deterministicallyResolved.includes(id),
  );
  if (admitsEvidence(event, facts) && remaining.length + 1 > config.limits.maxWorkingSetEvents) {
    for (const id of remaining.slice(0, 4))
      questions["relevant_" + id] = noul(
        "Is evidence " + id + " still relevant to the current user goal?",
      );
  }
  if (Object.keys(questions).length && config.shadowQuestions.includes("phase"))
    questions.phase_shadow = choice(
      "What phase is the coding task currently in? This answer is recorded for comparison only.",
      phases,
    );
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
