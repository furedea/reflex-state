import type { ReflexStateConfig } from "../core/config.js";
import { boundedText } from "../core/events.js";
import { blockerView, workingSetView } from "../core/state_view.js";
import type {
  AgentEvent,
  EventId,
  HotState,
  ToolCallEvent,
  ToolResultEvent,
} from "../core/types.js";

export interface StateBlockContext {
  readonly state: HotState;
  readonly evidence: ReadonlyMap<EventId, AgentEvent>;
  readonly config: ReflexStateConfig;
  readonly projectionMode?: "append" | "current-run";
  readonly messagesOmitted?: number;
}

export function stateBlock(context: StateBlockContext): string | undefined {
  const { state, evidence, config } = context;
  const blockers = blockerView(state, config);
  const workingSet = workingSetView(state, config.limits.maxWorkingSetEvents);
  const requests = [...evidence.values()]
    .filter((event) => event.type === "user_prompt")
    .slice(-config.limits.maxRecentUserPrompts)
    .map((event) => ({ event: event.id, text: event.text }));
  const evidenceIds = uniqueEvidenceIds(state, blockers.blockers, workingSet.events);
  let excerptLimit = 1200;
  let blockerLimit = blockers.blockers.length;
  let workingLimit = workingSet.events.length;
  const render = () => {
    const shownBlockers = blockers.blockers.slice(-blockerLimit);
    const shownWorking = workingSet.events.slice(-workingLimit);
    const displayed = new Set([
      ...shownBlockers.map((item) => item.eventId),
      ...shownWorking,
      ...failedEvidence(state),
    ]);
    const evidenceItems = [...evidenceIds]
      .filter((id) => displayed.has(id) || shownBlockers.some((item) => item.eventId === id))
      .map((id) => [id, evidenceItem(evidence.get(id), evidence, excerptLimit)] as const);
    return (
      "<reflex-state>\n" +
      JSON.stringify(
        {
          note:
            context.projectionMode === "append"
              ? "This block augments the complete conversation history."
              : "This block describes the current execution state; older history may be omitted in current-run mode.",
          projection_mode: context.projectionMode ?? config.projection.mode,
          history_omitted: (context.messagesOmitted ?? 0) > 0,
          messages_omitted: context.messagesOmitted ?? 0,
          goal: state.goal,
          phase: state.phase,
          task_status: state.taskStatus,
          state_health: state.stateHealth ?? "valid",
          observation_generation: state.observationGeneration ?? 0,
          pending_changes: state.pendingChanges ?? [],
          modified_files: state.modifiedFiles,
          verification: state.verification,
          blockers: {
            unresolved_total: blockers.unresolvedTotal,
            shown_count: shownBlockers.length,
            omitted_count: blockers.unresolvedTotal - shownBlockers.length,
            items: shownBlockers,
          },
          working_set: {
            total: workingSet.total,
            shown_count: shownWorking.length,
            omitted_count:
              workingSet.omittedCount + (workingSet.events.length - shownWorking.length),
            items: shownWorking.map((id) => evidenceItem(evidence.get(id), evidence, excerptLimit)),
          },
          recent_user_requests: requests,
          evidence: Object.fromEntries(evidenceItems),
        },
        null,
        2,
      ) +
      "\n</reflex-state>"
    );
  };
  let block = render();
  while (block.length > config.limits.maxStateBlockChars && excerptLimit > 80) {
    excerptLimit = Math.floor(excerptLimit / 2);
    block = render();
  }
  while (block.length > config.limits.maxStateBlockChars && workingLimit > 0) {
    workingLimit--;
    block = render();
  }
  while (block.length > config.limits.maxStateBlockChars && blockerLimit > 0) {
    blockerLimit--;
    block = render();
  }
  return block.length <= config.limits.maxStateBlockChars ? block : undefined;
}

function uniqueEvidenceIds(
  state: HotState,
  blockers: readonly { readonly eventId: EventId }[],
  workingSet: readonly EventId[],
): EventId[] {
  return [
    ...new Set([...blockers.map((item) => item.eventId), ...workingSet, ...failedEvidence(state)]),
  ];
}

function failedEvidence(state: HotState): EventId[] {
  return Object.values(state.verification).flatMap((item) =>
    item.status === "failed" && item.evidence ? [item.evidence] : [],
  );
}

function evidenceItem(
  event: AgentEvent | undefined,
  evidence: ReadonlyMap<EventId, AgentEvent>,
  excerptLimit: number,
) {
  if (!event) return { available: false, reason: "evidence_unavailable" };
  const related = relatedCall(event, evidence);
  const item: Record<string, unknown> = { id: event.id, type: event.type };
  if (event.type === "tool_call") {
    item.tool = event.toolName;
    item.command =
      typeof event.input.command === "string" ? boundedText(event.input.command, 400) : undefined;
    item.path = typeof event.input.path === "string" ? event.input.path : undefined;
    item.truncated = event.commandTruncated === true;
  }
  if (event.type === "tool_result") {
    item.tool = event.toolName;
    item.error = event.isError;
    item.excerpt = excerptText(event, excerptLimit);
    item.truncated = event.excerpt.truncated;
    if (!related) item.related_call = { available: false, reason: "related_call_unavailable" };
  }
  if (event.type === "file_change") {
    item.paths = event.paths;
    item.truncated = false;
  }
  if (related && related.id !== event.id) {
    item.related_call = evidenceItem(related, evidence, Math.min(excerptLimit, 400));
  }
  return item;
}

function relatedCall(
  event: AgentEvent,
  evidence: ReadonlyMap<EventId, AgentEvent>,
): ToolCallEvent | undefined {
  if (event.type === "tool_call") return event;
  if (event.type !== "tool_result") return undefined;
  return [...evidence.values()].find(
    (candidate): candidate is ToolCallEvent =>
      candidate.type === "tool_call" &&
      candidate.toolCallId === event.toolCallId &&
      candidate.toolName === event.toolName,
  );
}

function excerptText(event: ToolResultEvent, limit: number): string {
  const text =
    event.excerpt.head + (event.excerpt.tail ? "\n[excerpt gap]\n" + event.excerpt.tail : "");
  return boundedText(text, limit);
}
