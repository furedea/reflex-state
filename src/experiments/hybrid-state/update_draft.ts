import type {
  Candidate,
  CandidateDecision,
  RepairReason,
  RepairResponse,
  UpdateInput,
  UpdateProposal,
  UpdateResult,
} from "./types.js";
import { applyContext, applyOperations } from "./update_operations.js";
import type { RepairCheck } from "./update_repair.js";
import type { CandidateSelection } from "./update_selection.js";

/** An update whose candidates are selected but whose proposal is not yet applied to memory. */
export class UpdateDraft {
  readonly proposal: UpdateProposal;
  private readonly decisions: readonly CandidateDecision[];
  private readonly held: readonly Candidate[];

  constructor(
    private readonly input: UpdateInput,
    selection: CandidateSelection,
  ) {
    this.proposal = selection.proposal;
    this.decisions = selection.decisions;
    this.held = [...new Map(selection.held.map((candidate) => [candidate.id, candidate])).values()];
  }

  unchanged(outcome: Pick<UpdateResult, "repairReasons" | "unavailable">): UpdateResult {
    return {
      memory: this.input.memory,
      candidates: this.input.candidates,
      decisions: this.decisions,
      held: this.held,
      applied: [],
      proposal: this.proposal,
      ...outcome,
    };
  }

  apply(reasons: readonly RepairReason[], repaired: boolean): UpdateResult {
    let finalReasons = reasons;
    if (repaired || !reasons.length) {
      const applied = applyOperations(
        this.input.memory,
        this.proposal.operations,
        applyContext(this.input, repaired),
      );
      if (applied.ok)
        return {
          memory: applied.memory,
          candidates: this.input.candidates,
          decisions: this.decisions,
          held: this.held,
          applied: applied.applied,
          proposal: this.proposal,
          repairReasons: this.proposal.repairReasons,
        };
      finalReasons = [...new Set([...reasons, "invalid_update" as const])];
    }
    return this.unchanged({ repairReasons: finalReasons, unavailable: "state_first_unavailable" });
  }

  applyRepair(
    reasons: readonly RepairReason[],
    response: RepairResponse,
    check: RepairCheck,
  ): UpdateResult {
    if (response.error || !response.operations)
      return this.apply([...reasons, "invalid_update"], false);
    const repairCheck = check.reasonsFor(response.operations, applyContext(this.input, true));
    if (repairCheck.length)
      return this.apply(
        [...new Set([...reasons, ...repairCheck, "invalid_update" as const])],
        false,
      );
    const repairedProposal: UpdateProposal = {
      operations: response.operations,
      source: "repair",
      repairReasons: reasons,
    };
    return new UpdateDraft(this.input, {
      proposal: repairedProposal,
      decisions: this.decisions,
      held: this.held,
    }).apply([], true);
  }
}
