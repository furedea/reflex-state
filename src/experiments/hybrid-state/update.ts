import type { ReflexStateConfig } from "../../core/config.js";
import { blockerView } from "../../core/state_view.js";
import type { HotState } from "../../core/types.js";
import { buildRepairRequest } from "./prompts.js";
import type { JevProvider, RepairProvider } from "./providers.js";
import type {
  Candidate,
  CandidateDecision,
  FactsView,
  PatchOperation,
  RepairReason,
  UpdateInput,
  UpdateResult,
} from "./types.js";
import { UpdateDraft } from "./update_draft.js";
import { exceedsRequestBudget, jevSelection, type JevSelection } from "./update_jev.js";
import { applyContext } from "./update_operations.js";
import { RepairCheck, requestRepair } from "./update_repair.js";
import type { CandidateSelection } from "./update_selection.js";

export type { ApplyContext, ApplyFailure, ApplySuccess } from "./update_operations.js";
export { needsRepair, RepairCheck } from "./update_repair.js";
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

const DEFAULT_MEMORY_BYTES = 8192;

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

  const base = ruleProposal(input);
  const jev = input.mode === "jev" ? await jevSelection(input, base, options) : undefined;
  const draft = new UpdateDraft(input, selectionAfterJev(base, jev));
  if (jev?.unavailable) return draft.unchanged({ repairReasons: [], unavailable: jev.unavailable });

  const check = new RepairCheck(input, options.memoryBytes ?? DEFAULT_MEMORY_BYTES);
  const reasons = check.reasonsFor(draft.proposal.operations, applyContext(input, false));
  const repair = repairProvider(reasons, options.maxRepairCalls, options.repair);
  if (!repair) return draft.apply(reasons, false);
  const request = buildRepairRequest(input, reasons, options.repairModel ?? "");
  if (exceedsRequestBudget(request, options.requestBytes))
    return draft.unchanged({
      repairReasons: ["budget_exceeded"],
      unavailable: "repair_request_exceeds_budget",
    });
  return draft.applyRepair(reasons, await requestRepair(repair, request, options.signal), check);
}

/** The judge's selection replaces the rules' one, but candidates either held back stay held. */
function selectionAfterJev(
  base: CandidateSelection,
  jev: JevSelection | undefined,
): CandidateSelection {
  return jev ? { ...jev, held: [...base.held, ...jev.held] } : base;
}

/** The provider to ask for a repair, or undefined when none is needed or allowed. */
function repairProvider(
  reasons: readonly RepairReason[],
  maxRepairCalls: number | undefined,
  provider: RepairProvider | undefined,
): RepairProvider | undefined {
  return reasons.length && (maxRepairCalls ?? 0) > 0 ? provider : undefined;
}

export function ruleProposal(input: UpdateInput): CandidateSelection {
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
