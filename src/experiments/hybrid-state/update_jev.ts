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
  UpdateInput,
  UpdateProposal,
} from "./types.js";

export interface JevOptions {
  readonly jev?: JevProvider;
  readonly jevModel?: string;
  readonly maxQuestions?: number;
  readonly requestBytes?: number;
  readonly signal?: AbortSignal;
}

export interface JevSelection {
  readonly decisions: readonly CandidateDecision[];
  readonly proposal: UpdateProposal;
  readonly held: readonly Candidate[];
  readonly unavailable?: string;
}

interface JevBase {
  readonly proposal: UpdateProposal;
  readonly decisions: readonly CandidateDecision[];
}

export async function jevSelection(
  input: UpdateInput,
  base: JevBase,
  options: JevOptions,
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

function exceedsRequestBudget(request: JevRequest, requestBytes: number | undefined): boolean {
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

interface JevOutcome {
  readonly candidates: Candidate[];
  readonly decisions: CandidateDecision[];
  readonly held: Candidate[];
}

interface JevSubject {
  readonly candidateId: string;
  readonly candidate: Candidate | undefined;
  readonly answer: JevAnswer | undefined;
}

type JevVerdict =
  | { readonly kind: "hold"; readonly reason: string }
  | { readonly kind: "drop" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "select" };

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
  const outcome: JevOutcome = { candidates: [], decisions: [], held: [] };
  for (const question of questions) {
    const candidateId = question.candidateIds[0] ?? "unknown";
    const subject = {
      candidateId,
      candidate: candidateMap.get(candidateId),
      answer: byQuestion.get(question.id),
    };
    recordVerdict(outcome, subject, judgeAnswer(subject, question));
  }
  return outcome;
}

function judgeAnswer(subject: JevSubject, question: JevQuestion): JevVerdict {
  const { answer, candidate } = subject;
  if (!answer) return { kind: "hold", reason: "jev_missing" };
  if (answer.invalid) return { kind: "hold", reason: `jev_invalid:${answer.invalid}` };
  if (answer.confidence !== undefined && answer.confidence < 0.65)
    return { kind: "hold", reason: "jev_low_confidence" };
  const heldReason = HELD_CHOICES.get(answer.choice);
  if (heldReason) return { kind: "hold", reason: heldReason };
  if (answer.choice === "drop") return { kind: "drop" };
  if (!candidate || !(answer.choice in question.options)) return { kind: "unavailable" };
  return { kind: "select" };
}

function recordVerdict(outcome: JevOutcome, subject: JevSubject, verdict: JevVerdict) {
  const { candidateId, candidate, answer } = subject;
  if (verdict.kind === "hold") {
    if (candidate) outcome.held.push(candidate);
    outcome.decisions.push({ candidateId, disposition: "held", reason: verdict.reason });
  } else if (verdict.kind === "drop") {
    outcome.decisions.push({ candidateId, disposition: "rejected", reason: "jev_drop" });
  } else if (verdict.kind === "unavailable") {
    outcome.decisions.push({
      candidateId,
      disposition: "unclassified",
      reason: "candidate_unavailable",
    });
    if (candidate) outcome.held.push(candidate);
  } else {
    outcome.candidates.push(candidate!);
    outcome.decisions.push(selectedDecision(candidateId, answer!));
  }
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
