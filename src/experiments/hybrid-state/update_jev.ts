import { buildJevQuestions, buildJevRequest } from "./prompts.js";
import type { JevProvider } from "./providers.js";
import type {
  Candidate,
  CandidateDecision,
  JevAnswer,
  JevQuestion,
  JevRequest,
  JevResponse,
  PatchOperation,
  RepairRequest,
  UpdateInput,
  UpdateProposal,
} from "./types.js";
import type { CandidateSelection } from "./update_selection.js";

export interface JevSelection extends CandidateSelection {
  readonly unavailable?: string;
}

export async function jevSelection(
  input: UpdateInput,
  base: CandidateSelection,
  options: {
    readonly jev?: JevProvider;
    readonly jevModel?: string;
    readonly maxQuestions?: number;
    readonly requestBytes?: number;
    readonly signal?: AbortSignal;
  },
): Promise<JevSelection> {
  const { questions, unasked } = buildJevQuestions(
    input.candidates,
    input.memory,
    options.maxQuestions ?? 8,
  );
  const held = new Map<string, Candidate>();
  for (const candidate of unasked) held.set(candidate.id, candidate);
  const unaskedDecisions = unasked.map((candidate) => ({
    candidateId: candidate.id,
    disposition: "held" as const,
    reason: "question_budget",
  }));
  if (!questions.length)
    return {
      decisions: [...base.decisions, ...unaskedDecisions],
      proposal: base.proposal,
      held: [...held.values()],
    };
  const withoutOperations: UpdateProposal = { ...base.proposal, operations: [], source: "jev" };
  const askedHeld = [...held.values(), ...askedCandidates(questions, input.candidates)];
  if (!options.jev)
    return {
      decisions: [
        ...base.decisions,
        ...unaskedDecisions,
        ...heldQuestionDecisions(questions, "jev_unavailable"),
      ],
      proposal: withoutOperations,
      held: askedHeld,
    };
  const request = buildJevRequest(input, questions, options.jevModel ?? "jev-latest");
  if (exceedsRequestBudget(request, options.requestBytes))
    return {
      decisions: [...base.decisions, ...unaskedDecisions],
      proposal: withoutOperations,
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
        ...base.decisions,
        ...unaskedDecisions,
        ...heldQuestionDecisions(questions, `jev_${response.error}`),
      ],
      proposal: withoutOperations,
      held: askedHeld,
      unavailable: `jev_${response.error}`,
    };
  const chosen = selectedFromJev(questions, response, input.candidates);
  for (const candidate of chosen.held) held.set(candidate.id, candidate);
  return {
    decisions: [
      ...base.decisions.filter((decision) => decision.disposition === "omitted"),
      ...unaskedDecisions,
      ...base.decisions.filter((decision) => isHeldOutsideQuestions(decision, questions)),
      ...chosen.decisions,
    ],
    proposal: { operations: chosen.candidates.map(toOperation), source: "jev", repairReasons: [] },
    held: [...held.values()],
  };
}

export function exceedsRequestBudget(
  request: JevRequest | RepairRequest,
  requestBytes: number | undefined,
): boolean {
  return requestBytes !== undefined && Buffer.byteLength(JSON.stringify(request)) > requestBytes;
}

function heldQuestionDecisions(
  questions: readonly JevQuestion[],
  reason: string,
): CandidateDecision[] {
  return questions.map((question) => ({
    candidateId: question.candidateIds[0] ?? "unknown",
    disposition: "held" as const,
    reason,
  }));
}

function isHeldOutsideQuestions(
  decision: CandidateDecision,
  questions: readonly JevQuestion[],
): boolean {
  return (
    decision.disposition === "held" &&
    !questions.some((question) => question.candidateIds.includes(decision.candidateId))
  );
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

type JevVerdict =
  | { readonly kind: "hold"; readonly reason: string }
  | { readonly kind: "drop" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "select"; readonly candidate: Candidate; readonly answer: JevAnswer };

/** Accumulates what the judge's verdicts decided for each asked candidate. */
class JevOutcome {
  readonly candidates: Candidate[] = [];
  readonly decisions: CandidateDecision[] = [];
  readonly held: Candidate[] = [];

  record(verdict: JevVerdict, candidateId: string, candidate: Candidate | undefined): void {
    if (verdict.kind === "hold") {
      if (candidate) this.held.push(candidate);
      this.decisions.push({ candidateId, disposition: "held", reason: verdict.reason });
    } else if (verdict.kind === "drop") {
      this.decisions.push({ candidateId, disposition: "rejected", reason: "jev_drop" });
    } else if (verdict.kind === "unavailable") {
      this.decisions.push({
        candidateId,
        disposition: "unclassified",
        reason: "candidate_unavailable",
      });
      if (candidate) this.held.push(candidate);
    } else {
      this.candidates.push(verdict.candidate);
      this.decisions.push(selectedDecision(candidateId, verdict.answer));
    }
  }
}

const HELD_CHOICES: ReadonlyMap<string, string> = new Map([
  ["none", "jev_not_selected"],
  ["unknown", "jev_unknown"],
]);

function selectedFromJev(
  questions: readonly JevQuestion[],
  response: JevResponse,
  inputCandidates: readonly Candidate[],
): JevOutcome {
  const byQuestion = new Map(response.answers.map((answer) => [answer.questionId, answer]));
  const candidateMap = new Map(inputCandidates.map((candidate) => [candidate.id, candidate]));
  const outcome = new JevOutcome();
  for (const question of questions) {
    const candidateId = question.candidateIds[0] ?? "unknown";
    const candidate = candidateMap.get(candidateId);
    const answer = byQuestion.get(question.id);
    outcome.record(judgeAnswer(answer, candidate, question), candidateId, candidate);
  }
  return outcome;
}

function judgeAnswer(
  answer: JevAnswer | undefined,
  candidate: Candidate | undefined,
  question: JevQuestion,
): JevVerdict {
  if (!answer) return { kind: "hold", reason: "jev_missing" };
  if (answer.invalid) return { kind: "hold", reason: `jev_invalid:${answer.invalid}` };
  if (answer.confidence !== undefined && answer.confidence < 0.65)
    return { kind: "hold", reason: "jev_low_confidence" };
  const heldReason = HELD_CHOICES.get(answer.choice);
  if (heldReason) return { kind: "hold", reason: heldReason };
  if (answer.choice === "drop") return { kind: "drop" };
  if (!candidate || !(answer.choice in question.options)) return { kind: "unavailable" };
  return { kind: "select", candidate, answer };
}

function selectedDecision(candidateId: string, answer: JevAnswer): CandidateDecision {
  return {
    candidateId,
    disposition: "selected",
    reason: "jev_choice",
    ...(answer.probability === undefined ? {} : { probability: answer.probability }),
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
  };
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
