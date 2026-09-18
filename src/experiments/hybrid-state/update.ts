import { createHash } from "node:crypto";

import type { ReflexStateConfig } from "../../core/config.js";
import { blockerView } from "../../core/state_view.js";
import type { HotState } from "../../core/types.js";
import { buildJevQuestions, buildJevRequest, buildRepairRequest } from "./prompts.js";
import type { JevProvider, RepairProvider } from "./providers.js";
import type {
  Candidate,
  CandidateDecision,
  FactsView,
  JevResponse,
  MemoryItem,
  PatchOperation,
  RepairReason,
  UpdateInput,
  UpdateProposal,
  UpdateResult,
  WorkMemory,
} from "./types.js";
import { emptyMemory } from "./types.js";

export function factsFromState(state: HotState, config: ReflexStateConfig): FactsView {
  const view = blockerView(state, config);
  return {
    version: 2,
    phase: state.phase,
    taskStatus: state.taskStatus,
    observationGeneration: state.observationGeneration ?? 0,
    verification: state.verification,
    unresolvedTotal: view.unresolvedTotal,
    blockers: view.blockers,
    blockersOmitted: view.omittedCount,
    modifiedFiles: state.modifiedFiles,
    pendingChanges: state.pendingChanges ?? [],
  };
}

export function initialFacts(): FactsView {
  return {
    version: 2,
    phase: "unknown",
    taskStatus: "unknown",
    observationGeneration: 0,
    verification: {
      build: { status: "not_run", freshness: "unknown" },
      test: { status: "not_run", freshness: "unknown" },
      lint: { status: "not_run", freshness: "unknown" },
    },
    unresolvedTotal: 0,
    blockers: [],
    blockersOmitted: 0,
    modifiedFiles: [],
    pendingChanges: [],
  };
}

export async function updateMemory(
  input: UpdateInput,
  options: {
    readonly jev?: JevProvider;
    readonly repair?: RepairProvider;
    readonly jevModel?: string;
    readonly repairModel?: string;
    readonly maxQuestions?: number;
    readonly maxRepairCalls?: number;
    readonly memoryBytes?: number;
    readonly requestBytes?: number;
  } = {},
): Promise<UpdateResult> {
  if (input.mode === "history")
    return {
      memory: emptyMemory(),
      candidates: input.candidates,
      decisions: [],
      repairReasons: [],
    };

  const base = ruleProposal(input);
  let proposal: UpdateProposal = base.proposal;
  let decisions = base.decisions;
  let providerUnavailable: string | undefined;
  if (input.mode === "jev") {
    const questions = buildJevQuestions(input.candidates, input.memory, options.maxQuestions ?? 8);
    if (questions.length && options.jev) {
      const request = buildJevRequest(input, questions);
      if (
        options.requestBytes !== undefined &&
        Buffer.byteLength(JSON.stringify(request)) > options.requestBytes
      )
        return {
          memory: input.memory,
          candidates: input.candidates,
          decisions,
          proposal: { ...base.proposal, operations: [], source: "jev" },
          repairReasons: ["budget_exceeded"],
          unavailable: "jev_request_exceeds_budget",
        };
      const response = await options.jev.choose(request);
      if (response.error) providerUnavailable = `jev_${response.error}`;
      const chosen = selectedFromJev(questions, response, input.candidates);
      decisions = [...decisions, ...chosen.decisions];
      proposal = {
        ...base.proposal,
        operations: chosen.candidates.map(toOperation),
        source: "jev",
      };
    } else if (questions.length) {
      decisions = [
        ...decisions,
        ...questions.map((question) => ({
          candidateId: question.candidateIds[0] ?? "unknown",
          disposition: "unclassified" as const,
          reason: "jev_unavailable",
        })),
      ];
      proposal = { ...base.proposal, operations: [], source: "jev" };
    }
  }

  if (providerUnavailable)
    return {
      memory: input.memory,
      candidates: input.candidates,
      decisions,
      proposal,
      repairReasons: [],
      unavailable: providerUnavailable,
    };

  let reasons = needsRepair(input, proposal.operations, options.memoryBytes ?? 8192);
  let repaired = false;
  if (reasons.length && (options.maxRepairCalls ?? 0) > 0 && options.repair) {
    const request = buildRepairRequest(
      input,
      reasons,
      input.candidates.filter((candidate) => candidate.contextComplete),
      options.repairModel ?? "",
    );
    if (
      options.requestBytes !== undefined &&
      Buffer.byteLength(JSON.stringify(request)) > options.requestBytes
    )
      return {
        memory: input.memory,
        candidates: input.candidates,
        decisions,
        proposal,
        repairReasons: ["budget_exceeded"],
        unavailable: "repair_request_exceeds_budget",
      };
    const response = await options.repair.repair(request);
    if (!response.error) {
      const repairReasons = needsRepair(input, response.operations, options.memoryBytes ?? 8192);
      if (!repairReasons.length) {
        proposal = { operations: response.operations, source: "repair", repairReasons: reasons };
        reasons = [];
        repaired = true;
      } else reasons = [...reasons, "invalid_update"];
    }
  }
  if (repaired || !reasons.length) {
    const applied = applyOperations(input.memory, proposal.operations, input.candidates, input.now);
    if (applied.ok)
      return {
        memory: applied.memory,
        candidates: input.candidates,
        decisions,
        proposal,
        repairReasons: proposal.repairReasons,
      };
    reasons = [...new Set([...reasons, "invalid_update" as const])];
  }
  return {
    memory: input.memory,
    candidates: input.candidates,
    decisions,
    proposal,
    repairReasons: reasons,
    unavailable: "state_first_unavailable",
  };
}

export function ruleProposal(input: UpdateInput): {
  readonly proposal: UpdateProposal;
  readonly decisions: readonly CandidateDecision[];
} {
  const decisions: CandidateDecision[] = [];
  const operations: PatchOperation[] = [];
  const seen = new Set(
    Object.values(input.memory)
      .flat()
      .map((item) => item.text),
  );
  for (const candidate of input.candidates) {
    if (seen.has(candidate.text)) {
      decisions.push({ candidateId: candidate.id, disposition: "omitted", reason: "duplicate" });
      continue;
    }
    if (!candidate.contextComplete) {
      decisions.push({
        candidateId: candidate.id,
        disposition: "held",
        reason: "incomplete_context",
      });
      continue;
    }
    const replaces = replacementTarget(candidate, input.memory);
    operations.push({
      operation: replaces ? "replace" : "add",
      ...(replaces ? { itemId: replaces, replaces } : {}),
      kind: candidate.category,
      text: candidate.text,
      sourceIds: candidate.sourceIds,
      trust: candidate.trust,
      origin: "extracted",
    });
    decisions.push({
      candidateId: candidate.id,
      disposition: "selected",
      reason: replaces ? "explicit_replacement" : "rule_candidate",
    });
  }
  return {
    proposal: { operations, source: "rules", repairReasons: [] },
    decisions,
  };
}

export function needsRepair(
  input: UpdateInput,
  operations: readonly PatchOperation[],
  memoryBytes: number,
): RepairReason[] {
  const reasons: RepairReason[] = [];
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  if (Buffer.byteLength(JSON.stringify(operations)) > memoryBytes) reasons.push("budget_exceeded");
  const targets = new Set<string>();
  for (const operation of operations) {
    if (!operation.text.trim() || operation.sourceIds.some((id) => !hasSource(id, candidateById)))
      reasons.push("missing_evidence");
    if (operation.operation === "replace" && (!operation.itemId || targets.has(operation.itemId)))
      reasons.push("ambiguous_reference");
    if (operation.itemId) targets.add(operation.itemId);
    if (
      operation.sourceIds.some((id) =>
        [...candidateById.values()].some(
          (candidate) => candidate.sourceIds.includes(id) && candidate.truncated,
        ),
      )
    )
      reasons.push("missing_evidence");
  }
  const replacements = operations.filter((operation) => operation.operation === "replace");
  if (new Set(replacements.map((operation) => operation.itemId)).size !== replacements.length)
    reasons.push("ambiguous_reference");
  return [...new Set(reasons)];
}

export function applyOperations(
  memory: WorkMemory,
  operations: readonly PatchOperation[],
  candidates: readonly Candidate[],
  now: number,
):
  | { readonly ok: true; readonly memory: WorkMemory }
  | { readonly ok: false; readonly reason: string } {
  const sources = new Set(
    candidates.flatMap((candidate) => [candidate.id, ...candidate.sourceIds]),
  );
  const next: Record<string, MemoryItem[]> = Object.fromEntries(
    Object.entries(memory).map(([kind, items]) => [kind, [...items]]),
  );
  for (const operation of operations) {
    if (operation.sourceIds.some((sourceId) => !sources.has(sourceId)))
      return { ok: false, reason: "missing_source" };
    const bucket = next[operation.kind];
    if (!bucket) return { ok: false, reason: "unknown_memory_kind" };
    const id = operation.itemId ?? memoryId(operation);
    const item: MemoryItem = {
      id,
      kind: operation.kind,
      text: operation.text,
      sourceIds: [...operation.sourceIds],
      origin: operation.origin,
      trust: operation.trust,
      status: "active",
      updatedAt: now,
      ...(operation.replaces ? { replaces: operation.replaces } : {}),
    };
    if (operation.operation === "replace") {
      const index = bucket.findIndex((existing) => existing.id === operation.itemId);
      if (index < 0) return { ok: false, reason: "unknown_target" };
      bucket[index] = item;
    } else if (!bucket.some((existing) => existing.text === item.text)) bucket.push(item);
  }
  return { ok: true, memory: next as unknown as WorkMemory };
}

function selectedFromJev(
  questions: readonly {
    readonly id: string;
    readonly candidateIds: readonly string[];
    readonly options: Readonly<Record<string, string>>;
  }[],
  response: JevResponse,
  inputCandidates: readonly Candidate[],
) {
  const byQuestion = new Map(response.answers.map((answer) => [answer.questionId, answer]));
  const candidateMap = new Map(inputCandidates.map((candidate) => [candidate.id, candidate]));
  const selected: Candidate[] = [];
  const decisions: CandidateDecision[] = [];
  for (const question of questions) {
    const answer = byQuestion.get(question.id);
    const candidateId = question.candidateIds[0] ?? "unknown";
    if (
      !answer ||
      !(answer.choice in question.options) ||
      answer.choice === "none" ||
      answer.choice === "unknown"
    ) {
      decisions.push({
        candidateId,
        disposition: "unclassified",
        reason: answer ? "jev_not_selectable" : "jev_missing",
      });
      continue;
    }
    const candidate = candidateMap.get(candidateId);
    if (!candidate) {
      decisions.push({ candidateId, disposition: "unclassified", reason: "candidate_unavailable" });
      continue;
    }
    selected.push(candidate);
    decisions.push({
      candidateId,
      disposition: "selected",
      reason: "jev_choice",
      ...(answer.probability === undefined ? {} : { probability: answer.probability }),
    });
  }
  return { candidates: selected, decisions };
}

function toOperation(candidate: Candidate): PatchOperation {
  return {
    operation: "add",
    kind: candidate.category,
    text: candidate.text,
    sourceIds: candidate.sourceIds,
    trust: candidate.trust,
    origin: "extracted",
  };
}

function replacementTarget(candidate: Candidate, memory: WorkMemory): string | undefined {
  if (
    candidate.trust !== "user" ||
    !/\b(instead|replace|rather|use)\b|(?:代わり|置換|ではなく)/i.test(candidate.text)
  )
    return undefined;
  return memory[candidate.category].at(-1)?.id;
}

function hasSource(id: string, candidates: ReadonlyMap<string, Candidate>): boolean {
  return (
    candidates.has(id) ||
    [...candidates.values()].some((candidate) => candidate.sourceIds.includes(id))
  );
}

function memoryId(operation: PatchOperation): string {
  return `memory-${createHash("sha256").update(JSON.stringify(operation)).digest("hex").slice(0, 12)}`;
}
