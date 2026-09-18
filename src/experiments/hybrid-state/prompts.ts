import { createHash } from "node:crypto";

import type {
  ActorRequest,
  Candidate,
  FactsView,
  InputBundle,
  JevQuestion,
  JevRequest,
  MemoryItem,
  RepairRequest,
  UpdateInput,
  WorkMemory,
} from "./types.js";
import { PROMPT_VERSION } from "./types.js";

export function buildJevQuestions(
  candidates: readonly Candidate[],
  memory: WorkMemory,
  maxQuestions: number,
): JevQuestion[] {
  const known = new Set(
    Object.values(memory)
      .flat()
      .map((item) => item.text),
  );
  return candidates
    .filter((candidate) => !known.has(candidate.text))
    .slice(0, maxQuestions)
    .map((candidate, index) => ({
      id: `candidate-selection-${index + 1}`,
      kind: "choice" as const,
      prompt: `Choose the candidate's role in the current work. Candidate ${candidate.id} is shown with its source and trust: ${candidate.text}`,
      options: {
        [`keep-${candidate.id}`]: "keep this existing candidate in working memory",
        none: "do not select it yet",
        unknown: "insufficient evidence to decide",
      },
      candidateIds: [candidate.id],
      evidence: candidate.sourceIds,
    }));
}

export function buildJevRequest(input: UpdateInput, questions: readonly JevQuestion[]): JevRequest {
  return {
    questions,
    state: JSON.stringify({
      facts: input.facts,
      currentMemory: input.memory,
      candidates: questions.map((question) =>
        question.candidateIds.map((id) =>
          input.candidates.find((candidate) => candidate.id === id),
        ),
      ),
    }),
    model: "jev-latest",
    promptVersion: promptHash("jev", JSON.stringify(questions)),
  };
}

export function buildRepairRequest(
  input: UpdateInput,
  reasons: readonly RepairRequest["reasons"][number][],
  candidates: readonly Candidate[],
  model: string,
): RepairRequest {
  return {
    state: serializeState(input.facts, input.memory),
    observations: candidates,
    reasons,
    model,
    promptVersion: promptHash("repair", JSON.stringify(reasons)),
  };
}

export function buildActorRequest(
  mode: ActorRequest["mode"],
  taskId: string,
  instruction: string,
  input: InputBundle,
  model: string,
): ActorRequest {
  return {
    mode,
    taskId,
    instruction,
    input,
    allowedTools: ["read", "write", "edit", "test", "finish"],
    model,
    promptVersion: promptHash("actor", input.instruction),
  };
}

export function repairSystemPrompt(): string {
  return [
    "Return JSON only.",
    "Create only add or replace operations backed by sourceIds in the supplied observations.",
    "Never change facts, verification, or unresolved blockers.",
    "Do not invent missing text.",
  ].join(" ");
}

export function actorSystemPrompt(mode: ActorRequest["mode"]): string {
  return [
    "Return one JSON object with action and optional statePatch.",
    "Use only the allowed tools and paths inside the experiment workspace.",
    "For statePatch, use existing sourceIds only; never invent a conclusion.",
    `Comparison condition: ${mode}.`,
  ].join(" ");
}

export function serializeState(facts: FactsView, memory: WorkMemory): string {
  return JSON.stringify({ facts, memory });
}

export function renderMemory(memory: WorkMemory): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(memory).map(([kind, items]) => [
        kind,
        items.map((item) => ({
          id: item.id,
          text: item.text,
          sources: item.sourceIds,
          origin: item.origin,
          trust: item.trust,
          status: item.status,
        })),
      ]),
    ),
  );
}

export function renderItem(item: MemoryItem): string {
  return `${item.kind}:${item.id} [${item.origin}; ${item.trust}; sources=${item.sourceIds.join(",")}] ${item.text}`;
}

export function promptHash(kind: string, text: string): string {
  return `${PROMPT_VERSION}:${kind}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}
