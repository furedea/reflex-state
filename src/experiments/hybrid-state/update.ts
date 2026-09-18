import { createHash } from "node:crypto";

import type { ReflexStateConfig } from "../../core/config.js";
import { blockerView } from "../../core/state_view.js";
import type { HotState } from "../../core/types.js";
import { renderMemoryProjection } from "./projection.js";
import { buildJevQuestions, buildJevRequest, buildRepairRequest } from "./prompts.js";
import type { JevProvider, RepairProvider } from "./providers.js";
import type {
  Candidate,
  CandidateDecision,
  FactsView,
  JevResponse,
  MemoryItem,
  MemoryKind,
  PatchOperation,
  RepairReason,
  SourceRef,
  SourceTrust,
  TraceMessage,
  UpdateInput,
  UpdateProposal,
  UpdateResult,
  WorkMemory,
} from "./types.js";

const MEMORY_KINDS = new Set<MemoryKind>([
  "constraints",
  "decisions",
  "findings",
  "attempts",
  "open_questions",
]);

export function factsFromState(
  state: HotState,
  config: ReflexStateConfig,
  env?: {
    readonly verification: HotState["verification"];
    readonly blockers: readonly HotState["activeBlockers"][number][];
  },
): FactsView {
  const view = blockerView(state, config);
  const blockers = env
    ? [...view.blockers.filter((blocker) => blocker.origin !== "verification"), ...env.blockers]
    : view.blockers;
  return {
    version: 2,
    phase: state.phase,
    taskStatus: state.taskStatus,
    observationGeneration: state.observationGeneration ?? 0,
    verification: env?.verification ?? state.verification,
    unresolvedTotal: blockers.length + view.omittedCount,
    blockers,
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

export interface ApplyContext {
  readonly candidates: readonly Candidate[];
  readonly observations: readonly TraceMessage[];
  readonly extraSourceIds?: readonly string[];
  readonly extraSources?: readonly SourceRef[];
  readonly allowGenerated: boolean;
  readonly now: number;
}

export interface ApplySuccess {
  readonly ok: true;
  readonly memory: WorkMemory;
  readonly applied: readonly PatchOperation[];
}

export interface ApplyFailure {
  readonly ok: false;
  readonly reason: string;
  readonly errors: readonly string[];
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
    readonly signal?: AbortSignal;
  } = {},
): Promise<UpdateResult> {
  if (input.mode === "history")
    return {
      memory: input.memory,
      candidates: input.candidates,
      decisions: [],
      held: [],
      applied: [],
      repairReasons: [],
    };

  const context = applyContext(input, false);
  const base = ruleProposal(input);
  let proposal: UpdateProposal = base.proposal;
  let decisions = base.decisions;
  const held = new Map<string, Candidate>(base.held.map((candidate) => [candidate.id, candidate]));

  if (input.mode === "jev") {
    const jev = await jevSelection(input, base, decisions, options);
    decisions = jev.decisions;
    proposal = jev.proposal;
    for (const candidate of jev.held) held.set(candidate.id, candidate);
    if (jev.unavailable)
      return {
        memory: input.memory,
        candidates: input.candidates,
        decisions,
        held: [...held.values()],
        applied: [],
        proposal,
        repairReasons: [],
        unavailable: jev.unavailable,
      };
  }

  let reasons = needsRepair(input, proposal.operations, options.memoryBytes ?? 8192, context);
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
        held: [...held.values()],
        applied: [],
        proposal,
        repairReasons: ["budget_exceeded"],
        unavailable: "repair_request_exceeds_budget",
      };
    const response = await options.repair.repair(
      request,
      options.signal ? { signal: options.signal } : {},
    );
    if (response.error) reasons = [...reasons, "invalid_update"];
    else if (!response.operations) reasons = [...reasons, "invalid_update"];
    else {
      const repairCheck = needsRepair(
        input,
        response.operations,
        options.memoryBytes ?? 8192,
        applyContext(input, true),
      );
      if (!repairCheck.length) {
        proposal = {
          operations: response.operations,
          source: "repair",
          repairReasons: reasons,
        };
        reasons = [];
        repaired = true;
      } else reasons = [...new Set([...reasons, ...repairCheck, "invalid_update" as const])];
    }
  }
  if (repaired || !reasons.length) {
    const applied = applyOperations(
      input.memory,
      proposal.operations,
      applyContext(input, repaired),
    );
    if (applied.ok)
      return {
        memory: applied.memory,
        candidates: input.candidates,
        decisions,
        held: [...held.values()],
        applied: applied.applied,
        proposal,
        repairReasons: proposal.repairReasons,
      };
    reasons = [...new Set([...reasons, "invalid_update" as const])];
  }
  return {
    memory: input.memory,
    candidates: input.candidates,
    decisions,
    held: [...held.values()],
    applied: [],
    proposal,
    repairReasons: reasons,
    unavailable: "state_first_unavailable",
  };
}

export function ruleProposal(input: UpdateInput): {
  readonly proposal: UpdateProposal;
  readonly decisions: readonly CandidateDecision[];
  readonly held: readonly Candidate[];
} {
  const decisions: CandidateDecision[] = [];
  const operations: PatchOperation[] = [];
  const held: Candidate[] = [];
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
      held.push(candidate);
      continue;
    }
    operations.push({
      operation: "add",
      kind: candidate.category,
      text: candidate.text,
      sourceIds: candidate.sourceIds,
      trust: candidate.trust,
      origin: "extracted",
    });
    decisions.push({
      candidateId: candidate.id,
      disposition: "selected",
      reason: "rule_candidate",
    });
  }
  return {
    proposal: { operations, source: "rules", repairReasons: [] },
    decisions,
    held,
  };
}

export function needsRepair(
  input: UpdateInput,
  operations: readonly PatchOperation[],
  memoryBytes: number,
  context?: ApplyContext,
): RepairReason[] {
  const reasons: RepairReason[] = [];
  const ctx = context ?? applyContext(input, false);
  const validation = validateOperations(input.memory, operations, ctx);
  if (validation.errors.some((error) => error.startsWith("missing_source")))
    reasons.push("missing_evidence");
  if (validation.errors.some((error) => error.startsWith("replace_")))
    reasons.push("ambiguous_reference");
  if (
    validation.errors.some(
      (error) => !error.startsWith("missing_source") && !error.startsWith("replace_"),
    )
  )
    reasons.push("invalid_update");
  const applied = applyOperations(input.memory, validation.valid, ctx);
  if (applied.ok) {
    if (Buffer.byteLength(renderMemoryProjection(applied.memory)) > memoryBytes)
      reasons.push("budget_exceeded");
  } else if (!validation.errors.length) reasons.push("invalid_update");
  return [...new Set(reasons)];
}

export function applyOperations(
  memory: WorkMemory,
  operations: readonly PatchOperation[],
  context: ApplyContext,
): ApplySuccess | ApplyFailure {
  const validation = validateOperations(memory, operations, context);
  if (validation.errors.length)
    return {
      ok: false,
      reason: validation.errors[0] ?? "invalid_update",
      errors: validation.errors,
    };
  const next: Record<MemoryKind, MemoryItem[]> = Object.fromEntries(
    Object.entries(memory).map(([kind, items]) => [kind as MemoryKind, [...items]]),
  ) as Record<MemoryKind, MemoryItem[]>;
  const applied: PatchOperation[] = [];
  for (const operation of validation.valid) {
    const bucket = next[operation.kind];
    const id = operation.itemId ?? memoryId(operation);
    const item: MemoryItem = {
      id,
      kind: operation.kind,
      text: operation.text,
      sourceIds: [...operation.sourceIds],
      origin: operation.origin,
      trust: operation.trust,
      status: "active",
      updatedAt: context.now,
      ...(operation.replaces ? { replaces: operation.replaces } : {}),
    };
    if (operation.operation === "replace") {
      const index = bucket.findIndex((existing) => existing.id === operation.itemId);
      if (!sameItem(bucket[index]!, item)) {
        bucket[index] = item;
        applied.push(operation);
      }
    } else if (!bucket.some((existing) => existing.text === item.text)) {
      bucket.push(item);
      applied.push(operation);
    }
  }
  return { ok: true, memory: next, applied };
}

function sameItem(existing: MemoryItem, next: MemoryItem): boolean {
  return (
    existing.text === next.text &&
    existing.origin === next.origin &&
    existing.trust === next.trust &&
    existing.sourceIds.length === next.sourceIds.length &&
    existing.sourceIds.every((id, index) => id === next.sourceIds[index])
  );
}

export function validateOperations(
  memory: WorkMemory,
  operations: readonly PatchOperation[],
  context: ApplyContext,
): { readonly valid: readonly PatchOperation[]; readonly errors: readonly string[] } {
  const sources = validSources(context, memory);
  const errors: string[] = [];
  const valid: PatchOperation[] = [];
  const candidates = context.candidates;
  const items = Object.values(memory).flat();
  const claimedIds = new Set(items.map((item) => item.id));
  const replacedTargets = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    const fail = (reason: string) => errors.push(`${reason}#${index}`);
    if (!MEMORY_KINDS.has(operation.kind)) {
      fail("invalid_kind");
      continue;
    }
    if (operation.operation !== "add" && operation.operation !== "replace") {
      fail("invalid_operation");
      continue;
    }
    if (!operation.text.trim()) {
      fail("empty_text");
      continue;
    }
    if (!operation.sourceIds.length) {
      fail("missing_source:empty");
      continue;
    }
    const missing = operation.sourceIds.filter((id) => !sources.has(id));
    if (missing.length) {
      fail(`missing_source:${missing.join(",")}`);
      continue;
    }
    const cited = citedSources(operation, candidates, memory, context.extraSources ?? []);
    if (operation.origin === "generated") {
      if (!context.allowGenerated) {
        fail("generated_not_allowed");
        continue;
      }
    } else if (operation.origin !== "extracted") {
      fail("invalid_origin");
      continue;
    } else if (!cited.some((source) => source.text === operation.text)) {
      fail("extracted_text_mismatch");
      continue;
    }
    if (
      operation.itemId !== undefined &&
      operation.replaces !== undefined &&
      operation.itemId !== operation.replaces
    ) {
      fail("replace_id_mismatch");
      continue;
    }
    const trust = deriveTrust(operation, cited);
    let itemId = operation.itemId;
    let replaces = operation.replaces;
    if (operation.operation === "replace") {
      const targetId = itemId ?? replaces;
      const target = targetId ? items.find((item) => item.id === targetId) : undefined;
      if (!target) {
        fail("replace_unknown_target");
        continue;
      }
      if (target.kind !== operation.kind) {
        fail("replace_kind_mismatch");
        continue;
      }
      if (target.kind === "constraints" && target.trust === "user") {
        fail("protected_constraint");
        continue;
      }
      if (replacedTargets.has(target.id)) {
        fail("replace_duplicate_target");
        continue;
      }
      replacedTargets.add(target.id);
      itemId = target.id;
      replaces = target.id;
    }
    const normalized: PatchOperation = {
      operation: operation.operation,
      ...(itemId ? { itemId } : {}),
      kind: operation.kind,
      text: operation.text,
      sourceIds: [...operation.sourceIds],
      trust,
      origin: operation.origin,
      ...(replaces ? { replaces } : {}),
    };
    if (operation.operation === "add") {
      const effectiveId = normalized.itemId ?? memoryId(normalized);
      if (claimedIds.has(effectiveId)) {
        fail("duplicate_id");
        continue;
      }
      claimedIds.add(effectiveId);
    }
    valid.push(normalized);
  }
  return { valid, errors };
}

export function deriveTrust(
  operation: PatchOperation,
  cited: readonly { readonly text: string; readonly trust: SourceTrust }[],
): SourceTrust {
  if (operation.origin === "extracted") {
    const match = cited.find((source) => source.text === operation.text) ?? cited[0];
    return match?.trust ?? "unknown";
  }
  const trusts = new Set(cited.map((source) => source.trust));
  if (trusts.size === 1 && trusts.has("tool_result")) return "tool_result";
  if (trusts.size === 1 && trusts.has("unknown")) return "unknown";
  return "assistant";
}

export function applyContext(
  input: UpdateInput,
  allowGenerated: boolean,
  extraSourceIds: readonly string[] = [],
): ApplyContext {
  return {
    candidates: input.candidates,
    observations: [...input.observations, ...input.latest],
    extraSourceIds,
    allowGenerated,
    now: input.now,
  };
}

function validSources(context: ApplyContext, memory: WorkMemory): Set<string> {
  const sources = new Set<string>();
  for (const candidate of context.candidates) {
    sources.add(candidate.id);
    for (const id of candidate.sourceIds) sources.add(id);
  }
  for (const message of context.observations) {
    sources.add(message.id);
    sources.add(message.sourceId);
  }
  for (const item of Object.values(memory).flat()) {
    sources.add(item.id);
    for (const id of item.sourceIds) sources.add(id);
  }
  for (const id of context.extraSourceIds ?? []) sources.add(id);
  for (const source of context.extraSources ?? []) sources.add(source.id);
  return sources;
}

function citedSources(
  operation: PatchOperation,
  candidates: readonly Candidate[],
  memory: WorkMemory,
  extraSources: readonly SourceRef[] = [],
): readonly { readonly text: string; readonly trust: SourceTrust }[] {
  const ids = new Set(operation.sourceIds);
  const fromCandidates = candidates.filter(
    (candidate) => ids.has(candidate.id) || candidate.sourceIds.some((id) => ids.has(id)),
  );
  const fromMemory = Object.values(memory)
    .flat()
    .filter((item) => ids.has(item.id) || item.sourceIds.some((id) => ids.has(id)));
  const fromExtra = extraSources.filter((source) => ids.has(source.id));
  return [...fromCandidates, ...fromMemory, ...fromExtra];
}

async function jevSelection(
  input: UpdateInput,
  base: ReturnType<typeof ruleProposal>,
  decisions: readonly CandidateDecision[],
  options: {
    readonly jev?: JevProvider;
    readonly jevModel?: string;
    readonly maxQuestions?: number;
    readonly requestBytes?: number;
    readonly signal?: AbortSignal;
  },
): Promise<{
  readonly decisions: readonly CandidateDecision[];
  readonly proposal: UpdateProposal;
  readonly held: readonly Candidate[];
  readonly unavailable?: string;
}> {
  const held = new Map<string, Candidate>();
  const { questions, unasked } = buildJevQuestions(
    input.candidates,
    input.memory,
    options.maxQuestions ?? 8,
  );
  for (const candidate of unasked) held.set(candidate.id, candidate);
  const unaskedDecisions = unasked.map((candidate) => ({
    candidateId: candidate.id,
    disposition: "held" as const,
    reason: "question_budget",
  }));
  const duplicateDecisions = decisions.filter((decision) => decision.disposition === "omitted");
  if (!questions.length)
    return {
      decisions: [...decisions, ...unaskedDecisions],
      proposal: base.proposal,
      held: [...held.values()],
    };
  if (!options.jev)
    return {
      decisions: [
        ...decisions,
        ...unaskedDecisions,
        ...questions.map((question) => ({
          candidateId: question.candidateIds[0] ?? "unknown",
          disposition: "held" as const,
          reason: "jev_unavailable",
        })),
      ],
      proposal: { ...base.proposal, operations: [], source: "jev" },
      held: [...held.values(), ...askedCandidates(questions, input.candidates)],
    };
  const request = buildJevRequest(input, questions, options.jevModel ?? "jev-latest");
  if (
    options.requestBytes !== undefined &&
    Buffer.byteLength(JSON.stringify(request)) > options.requestBytes
  )
    return {
      decisions: [...decisions, ...unaskedDecisions],
      proposal: { ...base.proposal, operations: [], source: "jev" },
      held: [...held.values()],
      unavailable: "jev_request_exceeds_budget",
    };
  const response = await options.jev.choose(
    request,
    options.signal ? { signal: options.signal } : {},
  );
  if (response.error)
    return {
      decisions: [
        ...decisions,
        ...unaskedDecisions,
        ...questions.map((question) => ({
          candidateId: question.candidateIds[0] ?? "unknown",
          disposition: "held" as const,
          reason: `jev_${response.error}`,
        })),
      ],
      proposal: { ...base.proposal, operations: [], source: "jev" },
      held: [...held.values(), ...askedCandidates(questions, input.candidates)],
      unavailable: `jev_${response.error}`,
    };
  const chosen = selectedFromJev(questions, response, input.candidates);
  for (const candidate of chosen.held) held.set(candidate.id, candidate);
  return {
    decisions: [
      ...duplicateDecisions,
      ...unaskedDecisions,
      ...decisions.filter(
        (decision) =>
          decision.disposition === "held" &&
          !questions.some((question) => question.candidateIds.includes(decision.candidateId)),
      ),
      ...chosen.decisions,
    ],
    proposal: { operations: chosen.candidates.map(toOperation), source: "jev", repairReasons: [] },
    held: [...held.values()],
  };
}

function askedCandidates(
  questions: readonly { readonly candidateIds: readonly string[] }[],
  candidates: readonly Candidate[],
): Candidate[] {
  const map = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return questions.flatMap((question) =>
    question.candidateIds.flatMap((id) => {
      const candidate = map.get(id);
      return candidate ? [candidate] : [];
    }),
  );
}

function selectedFromJev(
  questions: readonly {
    readonly id: string;
    readonly candidateIds: readonly string[];
    readonly options: Readonly<Record<string, string>>;
  }[],
  response: JevResponse,
  inputCandidates: readonly Candidate[],
): {
  readonly candidates: readonly Candidate[];
  readonly decisions: readonly CandidateDecision[];
  readonly held: readonly Candidate[];
} {
  const byQuestion = new Map(response.answers.map((answer) => [answer.questionId, answer]));
  const candidateMap = new Map(inputCandidates.map((candidate) => [candidate.id, candidate]));
  const selected: Candidate[] = [];
  const held: Candidate[] = [];
  const decisions: CandidateDecision[] = [];
  for (const question of questions) {
    const answer = byQuestion.get(question.id);
    const candidateId = question.candidateIds[0] ?? "unknown";
    const candidate = candidateMap.get(candidateId);
    const hold = (reason: string) => {
      if (candidate) held.push(candidate);
      decisions.push({ candidateId, disposition: "held", reason });
    };
    if (!answer) {
      hold("jev_missing");
      continue;
    }
    if (answer.invalid) {
      hold(`jev_invalid:${answer.invalid}`);
      continue;
    }
    if (answer.confidence !== undefined && answer.confidence < 0.65) {
      hold("jev_low_confidence");
      continue;
    }
    if (answer.choice === "none") {
      hold("jev_not_selected");
      continue;
    }
    if (answer.choice === "unknown") {
      hold("jev_unknown");
      continue;
    }
    if (answer.choice === "drop") {
      decisions.push({ candidateId, disposition: "rejected", reason: "jev_drop" });
      continue;
    }
    if (!candidate || !(answer.choice in question.options)) {
      decisions.push({ candidateId, disposition: "unclassified", reason: "candidate_unavailable" });
      if (candidate) held.push(candidate);
      continue;
    }
    selected.push(candidate);
    decisions.push({
      candidateId,
      disposition: "selected",
      reason: "jev_choice",
      ...(answer.probability === undefined ? {} : { probability: answer.probability }),
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
    });
  }
  return { candidates: selected, decisions, held };
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

function memoryId(operation: PatchOperation): string {
  return `memory-${createHash("sha256").update(JSON.stringify(operation)).digest("hex").slice(0, 12)}`;
}

export function memoryItems(memory: WorkMemory): readonly MemoryItem[] {
  return Object.values(memory).flat();
}
