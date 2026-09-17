import type { ReflexStateConfig } from "../core/config.js";
import { boundedText } from "../core/events.js";
import type { AgentEvent, EventId, HotState } from "../core/types.js";

export interface StateBlockContext {
  readonly state: HotState;
  readonly evidence: ReadonlyMap<EventId, AgentEvent>;
  readonly config: ReflexStateConfig;
}

export function stateBlock({ state, evidence, config }: StateBlockContext): string | undefined {
  const limits = config.limits;
  const requests = [...evidence.values()]
    .filter((event) => event.type === "user_prompt")
    .slice(-limits.maxRecentUserPrompts)
    .map((event) => ({ event: event.id, text: event.text }));
  const evidenceIds = new Set(state.activeBlockers.map((blocker) => blocker.eventId));
  for (const verification of Object.values(state.verification)) {
    if (verification.status === "failed" && verification.evidence)
      evidenceIds.add(verification.evidence);
  }
  const files = [...state.modifiedFiles];
  let excerptLimit = 1800;
  const render = () =>
    "<reflex-state>\n" +
    JSON.stringify(
      {
        note: "Earlier conversation history is not included. This block is the current execution state.",
        goal: state.goal,
        phase: state.phase,
        task_status: state.taskStatus,
        modified_files: files,
        modified_files_omitted: state.modifiedFiles.length - files.length,
        verification: Object.fromEntries(
          Object.entries(state.verification).map(([kind, verification]) => [
            kind,
            {
              ...verification,
              ...(verification.command ? { command: boundedText(verification.command, 300) } : {}),
            },
          ]),
        ),
        active_blockers: state.activeBlockers,
        working_set: state.workingSet,
        recent_user_requests: requests,
        evidence_excerpts: Object.fromEntries(
          [...evidenceIds].flatMap((id) => {
            const event = evidence.get(id);
            if (event?.type !== "tool_result" || !excerptLimit) return [];
            const excerpt = event.excerpt;
            const text = excerpt.head + (excerpt.tail ? "\n[excerpt gap]\n" + excerpt.tail : "");
            return [[id, boundedText(text, excerptLimit)]];
          }),
        ),
      },
      null,
      2,
    ) +
    "\n</reflex-state>";
  let block = render();
  while (block.length > limits.maxStateBlockChars && excerptLimit > 100) {
    excerptLimit = Math.floor(excerptLimit / 2);
    block = render();
  }
  while (block.length > limits.maxStateBlockChars && requests.length > 1) {
    requests.shift();
    block = render();
  }
  while (block.length > limits.maxStateBlockChars && files.length) {
    files.pop();
    block = render();
  }
  if (block.length > limits.maxStateBlockChars) {
    excerptLimit = 0;
    block = render();
  }
  return block.length <= limits.maxStateBlockChars ? block : undefined;
}
