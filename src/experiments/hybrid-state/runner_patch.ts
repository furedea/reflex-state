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

/** Cap on the next-step update notification; counts are always exact while
 * detail entries are dropped oldest-last when the payload would exceed it. */
const UPDATE_FEEDBACK_LIMIT = 2048;

/** The state patch the actor attached to one response. The patch is optional:
 * an absent or empty patch leaves memory unchanged; the actor still commits
 * through the same validation path. */
export class ActorPatch {
  constructor(
    private readonly response: ActorResponse,
    private readonly responseId: string,
  ) {}

  applyContext(
    candidates: readonly Candidate[],
    observations: readonly TraceMessage[],
    step: number,
  ): ApplyContext {
    const { responseId, response } = this;
    return {
      candidates,
      observations,
      extraSourceIds: [responseId],
      allowGenerated: true,
      now: step,
      extraSources: response.text
        ? [{ id: responseId, role: "assistant", text: response.text, trust: "assistant" }]
        : [],
    };
  }

  evaluate(memory: WorkMemory, context: ApplyContext, memoryBytes: number): PatchEvaluation {
    const { response, responseId } = this;
    const patchInput = patchInputKind(response);
    const patch = (response.statePatch ?? []).map((operation) =>
      substituteSelf(operation, responseId),
    );
    // Invalid operations are dropped and recorded rather than killing the
    // trial: a miscited extraction never reaches memory, and the missing
    // retention shows up in the checkpoint scores instead.
    const validation = validateOperations(memory, patch, context);
    const apply = applyOperations(memory, validation.valid, context);
    if (!apply.ok) return { kind: "invalid", error: `invalid_update:${apply.reason}` };
    // The patch is tentative until the final memory render fits the shared
    // projection budget; an over-budget patch is never committed and the
    // action is never executed.
    if (Buffer.byteLength(renderMemoryProjection(apply.memory)) > memoryBytes)
      return {
        kind: "over_budget",
        patchInput,
        error: "invalid_update:memory_exceeds_budget",
      };
    // Valid operations that committed nothing (duplicates, no-op replaces)
    // are "unchanged": they were accepted but produced no state change.
    // Indices translate back through validation.validIndices to the
    // submitted patch positions.
    const appliedPatchIndices = apply.appliedIndices.map(
      (index) => validation.validIndices[index]!,
    );
    const unchanged = validation.validIndices.filter(
      (index) => !appliedPatchIndices.includes(index),
    );
    const feedback = boundedFeedback({
      patchInput,
      applied: apply.appliedIndices.map((index) => ({
        index: validation.validIndices[index]!,
        memoryId: apply.applied[index]!.itemId ?? memoryId(apply.applied[index]!),
      })),
      unchanged,
      rejected: validation.errors.map(rejectedDetail),
      appliedCount: apply.appliedIndices.length,
      unchangedCount: unchanged.length,
      rejectedCount: validation.errors.length,
      omittedDetailCount: 0,
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
}

function patchInputKind(response: ActorResponse): PatchInputKind {
  if (response.patchInput) return response.patchInput;
  if (response.statePatch === undefined) return "missing";
  return response.statePatch.length ? "present" : "empty";
}

function rejectedDetail(error: string): UpdateFeedback["rejected"][number] {
  const hash = error.lastIndexOf("#");
  const index = hash < 0 ? -1 : Number(error.slice(hash + 1));
  return {
    index: Number.isInteger(index) ? index : -1,
    reason: hash < 0 ? error : error.slice(0, hash),
  };
}

/** Least-informative details drop first; counts stay exact so the actor can
 * tell "saved nothing" apart from "saved but detail omitted". */
function boundedFeedback(full: UpdateFeedback): UpdateFeedback {
  let { applied, unchanged, rejected } = full;
  let omitted = 0;
  const build = (): UpdateFeedback => ({
    ...full,
    applied,
    unchanged,
    rejected,
    omittedDetailCount: omitted,
  });
  while (Buffer.byteLength(JSON.stringify(build())) > UPDATE_FEEDBACK_LIMIT) {
    if (unchanged.length) unchanged = unchanged.slice(0, -1);
    else if (applied.length) applied = applied.slice(0, -1);
    else if (rejected.length) rejected = rejected.slice(0, -1);
    else break;
    omitted += 1;
  }
  return build();
}

function substituteSelf(operation: PatchOperation, responseId: string): PatchOperation {
  if (!operation.sourceIds.includes("self")) return operation;
  return {
    ...operation,
    sourceIds: operation.sourceIds.map((id) => (id === "self" ? responseId : id)),
  };
}
