import { admitsEvidence } from "../core/reducer.js";
import type { AgentEvent, EventId, HotState, VerificationState } from "../core/types.js";
import type { StateUpdateContext } from "../core/updater.js";

type RequestQuestionKind =
  | "blocker_introduced"
  | "failure_category"
  | "resolve"
  | "relevance"
  | "task_complete"
  | "phase_shadow";

interface RequestPlanItem {
  readonly id: string;
  readonly kind: RequestQuestionKind;
  readonly eventId?: EventId;
  readonly requiredEvidence: readonly EventId[];
}

interface RequestPlan {
  readonly items: readonly RequestPlanItem[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly evidenceIds: readonly EventId[];
}

const MAX_QUESTIONS = 8;
const MAX_INPUT_BYTES = 24_000;
const INPUT_OVERHEAD_BYTES = 6_000;

export function buildRequestPlan(context: StateUpdateContext): RequestPlan {
  const { event, facts, state, evidence, config } = context;
  if (isReadEvent(event)) return { items: [], skipped: [], evidenceIds: [] };
  const candidates: RequestPlanItem[] = [];
  const latest = event.id;
  if (event.type === "tool_result" && event.isError) {
    if (facts.verification?.status !== "failed")
      candidates.push({
        id: "blocker_introduced",
        kind: "blocker_introduced",
        requiredEvidence: [latest],
      });
    candidates.push({
      id: "failure_category",
      kind: "failure_category",
      requiredEvidence: [latest],
    });
  }
  if (event.type === "tool_result" && !event.isError) {
    for (const blocker of state.activeBlockers.filter((item) => item.origin === "tool_error")) {
      candidates.push({
        id: "resolves_" + blocker.eventId,
        kind: "resolve",
        eventId: blocker.eventId,
        requiredEvidence: [blocker.eventId, latest],
      });
    }
  }
  if (event.type === "agent_end")
    candidates.push({
      id: "task_complete",
      kind: "task_complete",
      requiredEvidence: completionEvidence(state, latest),
    });
  const remaining = state.workingSet.filter(
    (id) =>
      !facts.supersededInWorkingSet.includes(id) && !facts.deterministicallyResolved.includes(id),
  );
  if (admitsEvidence(event, facts) && remaining.length + 1 > config.limits.maxWorkingSetEvents) {
    for (const id of remaining.slice(0, 4))
      candidates.push({
        id: "relevant_" + id,
        kind: "relevance",
        eventId: id,
        requiredEvidence: [id],
      });
  }
  const items: RequestPlanItem[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const available = candidates.filter((item) => {
    const missing = item.requiredEvidence.filter((id) => !evidence.has(id) && id !== latest);
    if (!missing.length) return true;
    skipped.push({ id: item.id, reason: "evidence_unavailable" });
    return false;
  });
  if (config.shadowQuestions.includes("phase") && available.length)
    available.push({ id: "phase_shadow", kind: "phase_shadow", requiredEvidence: [latest] });
  const selected: RequestPlanItem[] = [];
  let estimatedBytes = INPUT_OVERHEAD_BYTES + Buffer.byteLength(JSON.stringify({ state, event }));
  for (const item of available) {
    const evidenceBytes = item.requiredEvidence.reduce((total, id) => {
      const source = id === latest ? event : evidence.get(id);
      return total + (source ? Buffer.byteLength(JSON.stringify(source)) : 0);
    }, 0);
    const itemBytes = Buffer.byteLength(JSON.stringify(item)) + evidenceBytes;
    if (estimatedBytes + itemBytes > MAX_INPUT_BYTES) {
      skipped.push({ id: item.id, reason: "input_budget" });
      continue;
    }
    selected.push(item);
    estimatedBytes += itemBytes;
  }
  for (const item of available) {
    if (!selected.includes(item)) continue;
    if (items.length >= MAX_QUESTIONS) {
      skipped.push({ id: item.id, reason: "question_limit" });
      continue;
    }
    items.push(item);
  }
  const evidenceIds = [...new Set(items.flatMap((item) => item.requiredEvidence))];
  return { items, skipped, evidenceIds };
}

function completionEvidence(state: HotState, latest: EventId): EventId[] {
  const verification = Object.values(state.verification).flatMap((item: VerificationState) =>
    item.evidence ? [item.evidence] : [],
  );
  return [
    ...new Set([...state.activeBlockers.map((item) => item.eventId), ...verification, latest]),
  ];
}

function isReadEvent(event: AgentEvent): boolean {
  return event.type === "tool_result" && ["read", "grep", "find", "ls"].includes(event.toolName);
}
