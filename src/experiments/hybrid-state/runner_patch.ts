import { renderMemoryProjection } from "./projection.js";
import type {
  ActorResponse,
  Candidate,
  PatchInputKind,
  PatchOperation,
  TraceMessage,
  UpdateFeedback,
  WorkMemory,
} from "./types.js";
import { applyOperations, memoryId, validateOperations, type ApplyContext } from "./update.js";

export interface PatchSubmission {
  readonly memory: WorkMemory;
  readonly response: ActorResponse;
  readonly responseId: string;
  readonly candidates: readonly Candidate[];
  readonly observations: readonly TraceMessage[];
  readonly step: number;
  readonly memoryBytes: number;
}

export interface CommittedPatch {
  readonly kind: "committed";
  readonly patchInput: PatchInputKind;
  readonly memory: WorkMemory;
  readonly proposed: number;
  readonly applied: readonly PatchOperation[];
  readonly unchanged: readonly number[];
  readonly errors: readonly string[];
  readonly feedback: UpdateFeedback;
}

export type PatchEvaluation =
  | { readonly kind: "invalid"; readonly error: string }
  | {
      readonly kind: "over_budget";
      readonly patchInput: PatchInputKind;
      readonly error: string;
    }
  | CommittedPatch;

interface FeedbackDetails {
  readonly patchInput: PatchInputKind;
  readonly applied: readonly { readonly index: number; readonly memoryId: string }[];
  readonly unchanged: readonly number[];
  readonly errors: readonly string[];
}

/** Cap on the next-step update notification; counts are always exact while
 * detail entries are dropped oldest-last when the payload would exceed it. */
const UPDATE_FEEDBACK_LIMIT = 2048;

/** The state patch is optional: an absent or empty patch leaves memory
 * unchanged; the actor still commits through the same validation path. */
export function evaluateActorPatch(submission: PatchSubmission): PatchEvaluation {
  const { memory, response, responseId } = submission;
  const patchInput = patchInputKind(response);
  const patch = (response.statePatch ?? []).map((operation) =>
    substituteSelf(operation, responseId),
  );
  // Invalid operations are dropped and recorded rather than killing the
  // trial: a miscited extraction never reaches memory, and the missing
  // retention shows up in the checkpoint scores instead.
  const patchContext = actorPatchContext(submission);
  const validation = validateOperations(memory, patch, patchContext);
  const apply = applyOperations(memory, validation.valid, patchContext);
  if (!apply.ok) return { kind: "invalid", error: `invalid_update:${apply.reason}` };
  // The patch is tentative until the final memory render fits the shared
  // projection budget; an over-budget patch is never committed and the
  // action is never executed.
  if (Buffer.byteLength(renderMemoryProjection(apply.memory)) > submission.memoryBytes)
    return {
      kind: "over_budget",
      patchInput,
      error: "invalid_update:memory_exceeds_budget",
    };
  // Valid operations that committed nothing (duplicates, no-op replaces)
  // are "unchanged": they were accepted but produced no state change.
  // Indices translate back through validation.validIndices to the
  // submitted patch positions.
  const appliedPatchIndices = apply.appliedIndices.map((index) => validation.validIndices[index]!);
  const unchanged = validation.validIndices.filter((index) => !appliedPatchIndices.includes(index));
  const feedback = updateFeedback({
    patchInput,
    applied: apply.appliedIndices.map((index) => ({
      index: validation.validIndices[index]!,
      memoryId: apply.applied[index]!.itemId ?? memoryId(apply.applied[index]!),
    })),
    unchanged,
    errors: validation.errors,
  });
  return {
    kind: "committed",
    patchInput,
    memory: apply.memory,
    proposed: patch.length,
    applied: apply.applied,
    unchanged,
    errors: validation.errors,
    feedback,
  };
}

function patchInputKind(response: ActorResponse): PatchInputKind {
  if (response.patchInput) return response.patchInput;
  if (response.statePatch === undefined) return "missing";
  return response.statePatch.length ? "present" : "empty";
}

function updateFeedback(details: FeedbackDetails): UpdateFeedback {
  const { patchInput, unchanged } = details;
  const appliedDetails = details.applied;
  const rejectedDetails = details.errors.map((error) => {
    const hash = error.lastIndexOf("#");
    const index = hash < 0 ? -1 : Number(error.slice(hash + 1));
    return {
      index: Number.isInteger(index) ? index : -1,
      reason: hash < 0 ? error : error.slice(0, hash),
    };
  });
  let appliedList = appliedDetails;
  let unchangedList = [...unchanged];
  let rejectedList = rejectedDetails;
  let omitted = 0;
  const build = (): UpdateFeedback => ({
    patchInput,
    applied: appliedList,
    unchanged: unchangedList,
    rejected: rejectedList,
    appliedCount: appliedDetails.length,
    unchangedCount: unchanged.length,
    rejectedCount: rejectedDetails.length,
    omittedDetailCount: omitted,
  });
  // Least-informative details drop first; counts stay exact so the actor can
  // tell "saved nothing" apart from "saved but detail omitted".
  while (Buffer.byteLength(JSON.stringify(build())) > UPDATE_FEEDBACK_LIMIT) {
    if (unchangedList.length) unchangedList = unchangedList.slice(0, -1);
    else if (appliedList.length) appliedList = appliedList.slice(0, -1);
    else if (rejectedList.length) rejectedList = rejectedList.slice(0, -1);
    else break;
    omitted += 1;
  }
  return build();
}

function actorPatchContext(submission: PatchSubmission): ApplyContext {
  const { responseId, response } = submission;
  return {
    candidates: submission.candidates,
    observations: submission.observations,
    extraSourceIds: [responseId],
    allowGenerated: true,
    now: submission.step,
    extraSources: response.text
      ? [{ id: responseId, role: "assistant", text: response.text, trust: "assistant" }]
      : [],
  };
}

function substituteSelf(operation: PatchOperation, responseId: string): PatchOperation {
  if (!operation.sourceIds.includes("self")) return operation;
  return {
    ...operation,
    sourceIds: operation.sourceIds.map((id) => (id === "self" ? responseId : id)),
  };
}
