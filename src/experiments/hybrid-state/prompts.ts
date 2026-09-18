import { createHash } from "node:crypto";

import type {
  ActorRequest,
  Candidate,
  ExperimentMode,
  FactsView,
  JevQuestion,
  JevRequest,
  MemoryItem,
  RepairRequest,
  UpdateInput,
  WorkMemory,
} from "./types.js";
import { PROMPT_VERSION } from "./types.js";

export interface JevQuestionPlan {
  readonly questions: readonly JevQuestion[];
  readonly unasked: readonly Candidate[];
}

export function buildJevQuestions(
  candidates: readonly Candidate[],
  memory: WorkMemory,
  maxQuestions: number,
): JevQuestionPlan {
  const known = new Set(
    Object.values(memory)
      .flat()
      .map((item) => item.text),
  );
  const fresh = candidates.filter((candidate) => !known.has(candidate.text));
  const asked = fresh.slice(0, maxQuestions);
  const unasked = fresh.slice(maxQuestions);
  return {
    questions: asked.map((candidate, index) => ({
      id: `candidate-selection-${index + 1}-${candidate.id}`,
      kind: "choice" as const,
      prompt: `Choose the candidate's role in the current work. Candidate ${candidate.id} is shown with its source and trust: ${candidate.text}`,
      options: {
        [`keep-${candidate.id}`]: "keep this existing candidate in working memory",
        none: "do not select it yet",
        unknown: "insufficient evidence to decide",
        drop: "the candidate is not useful for the current goal",
      },
      candidateIds: [candidate.id],
      evidence: candidate.sourceIds,
    })),
    unasked,
  };
}

export function buildJevRequest(
  input: UpdateInput,
  questions: readonly JevQuestion[],
  model: string,
): JevRequest {
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
    model,
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

const ACTION_CONTRACT = [
  '"action" is one of:',
  '  {"tool":"read","path":"<workspace path>"}',
  '  {"tool":"write","path":"<workspace path>","content":"<complete new file content>"}',
  '  {"tool":"edit","path":"<workspace path>","old":"<exact existing text>","new":"<replacement text>"}',
  '  {"tool":"test","command":"<one of the allowed test ids>"}',
  '  {"tool":"finish"}',
].join("\n");

const PATCH_CONTRACT = [
  '"statePatch" is an array of memory operations (an empty array is valid):',
  '  {"operation":"add","kind":"<constraints|decisions|findings|attempts|open_questions>","text":"...","sourceIds":["<source id>"],"origin":"extracted|generated"}',
  '  {"operation":"replace","itemId":"<existing memory id>","kind":"...","text":"...","sourceIds":["..."],"origin":"extracted|generated"}',
  'sourceIds must cite ids from the latest observation, existing memory items, or the string "self" for this response\'s visible text.',
  "An extracted operation's text must equal the cited source text. A generated operation records a judgment; distinguish evidence from inference and never fabricate observations.",
  "The patch reflects the latest observation and your current judgment. Do not record the action's result before it happens.",
].join("\n");

export function actorSystemPrompt(mode: ExperimentMode): string {
  const shape =
    mode === "llm"
      ? 'Return one JSON object: {"action": ..., "statePatch": [...], "text"?: "visible explanation"}'
      : 'Return one JSON object: {"action": ..., "text"?: "visible explanation"}';
  const lines = [
    "You are the actor in a controlled coding experiment. Return JSON only, no markdown fences.",
    shape,
    ACTION_CONTRACT,
    "Use only the allowed tools, workspace paths, and test ids.",
    '"text" is an optional visible explanation; it must not contain the JSON action or patch.',
  ];
  if (mode === "llm") lines.push(PATCH_CONTRACT);
  return lines.join("\n");
}

export function repairSystemPrompt(): string {
  return [
    'Return JSON only: {"operations": [<memory operations>]}.',
    "Create only add or replace operations backed by sourceIds in the supplied observations.",
    "Never change facts, verification, or unresolved blockers.",
    "Distinguish evidence from inference; do not invent missing text.",
  ].join("\n");
}

export function updateSystemPrompt(): string {
  return [
    'Return JSON only: {"operations": [<memory operations>]}.',
    "Update the supplied working memory for the latest observation using add or replace operations.",
    "Cite sourceIds from the latest observation or existing memory; extracted text must equal the cited source.",
    "You may record grounded conclusions as generated operations; distinguish evidence from inference.",
    "Never change facts, verification, or unresolved blockers.",
  ].join("\n");
}

export function buildActorRequest(options: {
  readonly mode: ExperimentMode;
  readonly taskId: string;
  readonly trialId: string;
  readonly step: number;
  readonly userText: string;
  readonly allowedTests: readonly string[];
  readonly model: string;
}): ActorRequest {
  return {
    mode: options.mode,
    taskId: options.taskId,
    trialId: options.trialId,
    step: options.step,
    system: actorSystemPrompt(options.mode),
    user: options.userText,
    allowedTools: ["read", "write", "edit", "test", "finish"],
    allowedTests: options.allowedTests,
    model: options.model,
  };
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

export function requestBytes(system: string, user: string): number {
  return Buffer.byteLength(
    JSON.stringify({ system, messages: [{ role: "user", content: user }] }),
    "utf8",
  );
}
