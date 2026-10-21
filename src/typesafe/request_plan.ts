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

type SkippedItem = { id: string; reason: string };

export function buildRequestPlan(context: StateUpdateContext): RequestPlan {
  const { event, evidence, config } = context;
  if (isReadEvent(event)) return { items: [], skipped: [], evidenceIds: [] };
  const latest = event.id;
  const skipped: SkippedItem[] = [];
  const available = candidateItems(context).filter((item) => {
    const missing = item.requiredEvidence.filter((id) => !evidence.has(id) && id !== latest);
    if (!missing.length) return true;
    skipped.push({ id: item.id, reason: "evidence_unavailable" });
    return false;
  });
  if (config.shadowQuestions.includes("phase") && available.length)
    available.push({ id: "phase_shadow", kind: "phase_shadow", requiredEvidence: [latest] });
  const selected = withinInputBudget(available, context, skipped);
  const items = withinQuestionLimit(available, selected, skipped);
  const evidenceIds = [...new Set(items.flatMap((item) => item.requiredEvidence))];
  return { items, skipped, evidenceIds };
}

function candidateItems(context: StateUpdateContext): RequestPlanItem[] {
  return [
    ...toolResultCandidates(context),
    ...completionCandidates(context),
    ...relevanceCandidates(context),
  ];
}

function toolResultCandidates({ event, facts, state }: StateUpdateContext): RequestPlanItem[] {
  if (event.type !== "tool_result") return [];
  const latest = event.id;
  if (!event.isError) {
    return state.activeBlockers
      .filter((item) => item.origin === "tool_error")
      .map((blocker) => ({
        id: "resolves_" + blocker.eventId,
        kind: "resolve",
        eventId: blocker.eventId,
        requiredEvidence: [blocker.eventId, latest],
      }));
  }
  const candidates: RequestPlanItem[] = [];
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
  return candidates;
}

function completionCandidates({ event, state }: StateUpdateContext): RequestPlanItem[] {
  if (event.type !== "agent_end") return [];
  return [
    {
      id: "task_complete",
      kind: "task_complete",
      requiredEvidence: completionEvidence(state, event.id),
    },
  ];
}

function relevanceCandidates({ event, facts, state, config }: StateUpdateContext) {
  const remaining = state.workingSet.filter(
    (id) =>
      !facts.supersededInWorkingSet.includes(id) && !facts.deterministicallyResolved.includes(id),
  );
  if (!admitsEvidence(event, facts) || remaining.length + 1 <= config.limits.maxWorkingSetEvents)
    return [];
  return remaining.slice(0, 4).map(
    (id): RequestPlanItem => ({
      id: "relevant_" + id,
      kind: "relevance",
      eventId: id,
      requiredEvidence: [id],
    }),
  );
}

function withinInputBudget(
  available: readonly RequestPlanItem[],
  { event, state, evidence }: StateUpdateContext,
  skipped: SkippedItem[],
): RequestPlanItem[] {
  const selected: RequestPlanItem[] = [];
  let estimatedBytes = INPUT_OVERHEAD_BYTES + Buffer.byteLength(JSON.stringify({ state, event }));
  for (const item of available) {
    const evidenceBytes = item.requiredEvidence.reduce((total, id) => {
      const source = id === event.id ? event : evidence.get(id);
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
  return selected;
}

function withinQuestionLimit(
  available: readonly RequestPlanItem[],
  selected: readonly RequestPlanItem[],
  skipped: SkippedItem[],
): RequestPlanItem[] {
  const items: RequestPlanItem[] = [];
  for (const item of available) {
    if (!selected.includes(item)) continue;
    if (items.length >= MAX_QUESTIONS) {
      skipped.push({ id: item.id, reason: "question_limit" });
      continue;
    }
    items.push(item);
  }
  return items;
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
