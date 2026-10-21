import type { Candidate, CandidateDecision, UpdateProposal } from "./types.js";

/** What selecting candidates (by rules or by the jev judge) decided: the
 * proposed operations, a decision per candidate, and the candidates held back. */
export interface CandidateSelection {
  readonly proposal: UpdateProposal;
  readonly decisions: readonly CandidateDecision[];
  readonly held: readonly Candidate[];
}
