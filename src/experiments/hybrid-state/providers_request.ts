import { createHash } from "node:crypto";

import { repairSystemPrompt, updateSystemPrompt } from "./prompts.js";
import type { ActorRequest, GenerativeUpdateRequest, JevRequest, RepairRequest } from "./types.js";

/**
 * The exact body handed to the transport for a call. Request bytes and the
 * recorded-response hash are both derived from this single serialization so
 * they can never disagree about what was sent. Local metadata (runId, trialId,
 * step) is never part of these bodies.
 */
export function sentRequestBody(kind: string, request: unknown): unknown {
  if (kind === "actor") {
    const actor = request as ActorRequest;
    return { system: actor.system, messages: [{ role: "user", content: actor.user }] };
  }
  if (kind === "repair") {
    const body = repairCompletionBody(request as RepairRequest);
    return { system: body.system, messages: [{ role: "user", content: body.user }] };
  }
  if (kind === "update") {
    const body = updateCompletionBody(request as GenerativeUpdateRequest);
    return { system: body.system, messages: [{ role: "user", content: body.user }] };
  }
  if (kind === "jev") {
    const jev = request as JevRequest;
    return {
      state: jev.state,
      model: jev.model,
      questions: Object.fromEntries(
        jev.questions.map((question) => [
          question.id,
          { type: "choice", instructions: question.prompt, criteria: question.options },
        ]),
      ),
    };
  }
  return request;
}

/** Shared serialization for repair completions: the provider call and the
 * measurement path must use the same body. */
export function repairCompletionBody(request: RepairRequest): {
  readonly system: string;
  readonly user: string;
} {
  return { system: repairSystemPrompt(), user: JSON.stringify(request) };
}

export function updateCompletionBody(request: GenerativeUpdateRequest): {
  readonly system: string;
  readonly user: string;
} {
  return { system: updateSystemPrompt(), user: JSON.stringify(request) };
}

export function requestHash(kind: string, request: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sentRequestBody(kind, request)))
    .digest("hex");
}
