import type { ReflexStateConfig } from "../../core/config.js";
import { blockerView } from "../../core/state_view.js";
import type { HotState } from "../../core/types.js";
import { renderMemoryProjection } from "./projection.js";
import { buildRepairRequest } from "./prompts.js";
import type { RepairProvider } from "./providers.js";
import type {
  Candidate,
  CandidateDecision,
  FactsView,
  PatchOperation,
  RepairReason,
  UpdateInput,
  UpdateProposal,
  UpdateResult,
} from "./types.js";
import { jevSelection, type JevOptions } from "./update_jev.js";
import { applyContext, applyOperations, validateOperations } from "./update_operations.js";
import type { ApplyContext } from "./update_operations.js";

export type { ApplyContext, ApplyFailure, ApplySuccess } from "./update_operations.js";
export {
  applyContext,
  applyOperations,
  deriveTrust,
  memoryId,
  memoryItems,
  validateOperations,
} from "./update_operations.js";

export function factsFromState(
  state: HotState,
  config: ReflexStateConfig,
  env?: {
    readonly verification: FactsView["verification"];
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

interface UpdateOptions extends JevOptions {
  readonly repair?: RepairProvider;
  readonly repairModel?: string;
  readonly maxRepairCalls?: number;
  readonly memoryBytes?: number;
}

interface UpdateState {
  readonly proposal: UpdateProposal;
  readonly decisions: readonly CandidateDecision[];
  readonly held: ReadonlyMap<string, Candidate>;
}

const DEFAULT_MEMORY_BYTES = 8192;

export async function updateMemory(
  input: UpdateInput,
  options: UpdateOptions = {},
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

  const base = ruleProposal(input);
  let state: UpdateState = {
    proposal: base.proposal,
    decisions: base.decisions,
    held: new Map(base.held.map((candidate) => [candidate.id, candidate])),
  };
  if (input.mode === "jev") {
    const jev = await jevSelection(input, base, options);
    state = {
      proposal: jev.proposal,
      decisions: jev.decisions,
      held: new Map([...state.held, ...jev.held.map((c): [string, Candidate] => [c.id, c])]),
    };
    if (jev.unavailable)
      return unchangedResult(input, state, { repairReasons: [], unavailable: jev.unavailable });
  }
  return repairAndApply(input, state, options);
}

function unchangedResult(
  input: UpdateInput,
  state: UpdateState,
  outcome: Pick<UpdateResult, "repairReasons" | "unavailable">,
): UpdateResult {
  return {
    memory: input.memory,
    candidates: input.candidates,
    decisions: state.decisions,
    held: [...state.held.values()],
    applied: [],
    proposal: state.proposal,
    ...outcome,
  };
}

async function repairAndApply(
  input: UpdateInput,
  state: UpdateState,
  options: UpdateOptions,
): Promise<UpdateResult> {
  const repair = options.repair;
  const reasons = needsRepair(input, state.proposal.operations, {
    memoryBytes: options.memoryBytes ?? DEFAULT_MEMORY_BYTES,
    context: applyContext(input, false),
  });
  if (!reasons.length || (options.maxRepairCalls ?? 0) <= 0 || !repair)
    return applyProposal(input, state, { reasons, repaired: false });
  const attempt = await attemptRepair(input, reasons, { ...options, repair });
  if (attempt.kind === "over_budget")
    return unchangedResult(input, state, {
      repairReasons: ["budget_exceeded"],
      unavailable: "repair_request_exceeds_budget",
    });
  if (attempt.kind === "rejected")
    return applyProposal(input, state, { reasons: attempt.reasons, repaired: false });
  return applyProposal(
    input,
    { ...state, proposal: attempt.proposal },
    { reasons: [], repaired: true },
  );
}

type RepairAttempt =
  | { readonly kind: "over_budget" }
  | { readonly kind: "rejected"; readonly reasons: readonly RepairReason[] }
  | { readonly kind: "repaired"; readonly proposal: UpdateProposal };

async function attemptRepair(
  input: UpdateInput,
  reasons: readonly RepairReason[],
  options: UpdateOptions & { readonly repair: RepairProvider },
): Promise<RepairAttempt> {
  const request = buildRepairRequest(input, reasons, options.repairModel ?? "");
  if (
    options.requestBytes !== undefined &&
    Buffer.byteLength(JSON.stringify(request)) > options.requestBytes
  )
    return { kind: "over_budget" };
  const response = await options.repair.repair(
    request,
    options.signal ? { signal: options.signal } : {},
  );
  if (response.error || !response.operations)
    return { kind: "rejected", reasons: [...reasons, "invalid_update"] };
  const repairCheck = needsRepair(input, response.operations, {
    memoryBytes: options.memoryBytes ?? DEFAULT_MEMORY_BYTES,
    context: applyContext(input, true),
  });
  if (repairCheck.length)
    return {
      kind: "rejected",
      reasons: [...new Set([...reasons, ...repairCheck, "invalid_update" as const])],
    };
  return {
    kind: "repaired",
    proposal: { operations: response.operations, source: "repair", repairReasons: reasons },
  };
}

function applyProposal(
  input: UpdateInput,
  state: UpdateState,
  outcome: { readonly reasons: readonly RepairReason[]; readonly repaired: boolean },
): UpdateResult {
  const { reasons, repaired } = outcome;
  let finalReasons = reasons;
  if (repaired || !reasons.length) {
    const applied = applyOperations(
      input.memory,
      state.proposal.operations,
      applyContext(input, repaired),
    );
    if (applied.ok)
      return {
        memory: applied.memory,
        candidates: input.candidates,
        decisions: state.decisions,
        held: [...state.held.values()],
        applied: applied.applied,
        proposal: state.proposal,
        repairReasons: state.proposal.repairReasons,
      };
    finalReasons = [...new Set([...reasons, "invalid_update" as const])];
  }
  return unchangedResult(input, state, {
    repairReasons: finalReasons,
    unavailable: "state_first_unavailable",
  });
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
  options: { readonly memoryBytes: number; readonly context?: ApplyContext },
): RepairReason[] {
  const ctx = options.context ?? applyContext(input, false);
  const validation = validateOperations(input.memory, operations, ctx);
  const reasons = reasonsFromErrors(validation.errors);
  const applied = applyOperations(input.memory, validation.valid, ctx);
  if (applied.ok) {
    if (Buffer.byteLength(renderMemoryProjection(applied.memory)) > options.memoryBytes)
      reasons.push("budget_exceeded");
  } else if (!validation.errors.length) reasons.push("invalid_update");
  return [...new Set(reasons)];
}

function reasonsFromErrors(errors: readonly string[]): RepairReason[] {
  const reasons: RepairReason[] = [];
  if (errors.some((error) => error.startsWith("missing_source"))) reasons.push("missing_evidence");
  if (errors.some((error) => error.startsWith("replace_"))) reasons.push("ambiguous_reference");
  if (errors.some((error) => !error.startsWith("missing_source") && !error.startsWith("replace_")))
    reasons.push("invalid_update");
  return reasons;
}
