import type { StateEngine } from "../../core/engine.js";
import type { PiEventNormalizer } from "../../pi/normalization.js";
import type { TaskEnvironment } from "./task_environment.js";
import type { ActorAction, TraceMessage } from "./types.js";

export interface ExchangeRig {
  readonly normalizer: PiEventNormalizer;
  readonly engine: StateEngine;
  readonly history: TraceMessage[];
}

export interface ToolExchange {
  readonly action: ActorAction;
  readonly evidenceId: string;
  readonly execution: Awaited<ReturnType<TaskEnvironment["execute"]>>;
}

function actionInput(action: ActorAction): Record<string, unknown> {
  return { ...action };
}

export function operationKey(action: ActorAction): string {
  return JSON.stringify(actionInput(action));
}

/** Feeds the executed tool call and its result through the state engine and
 * appends both to the trial history. */
export async function recordToolExchange(rig: ExchangeRig, exchange: ToolExchange): Promise<void> {
  const { normalizer, engine, history } = rig;
  const { action, evidenceId, execution } = exchange;
  const callEvent = normalizer.call({
    type: "tool_call",
    toolCallId: evidenceId,
    toolName: action.tool,
    input: actionInput(action),
  });
  const resultEvent = normalizer.result({
    type: "tool_result",
    toolCallId: callEvent.toolCallId,
    toolName: action.tool,
    input: actionInput(action),
    content: [{ type: "text", text: execution.text }],
    isError: !execution.passed,
    details: undefined,
  });
  await engine.process(callEvent);
  await engine.process(resultEvent);
  history.push({
    id: callEvent.id,
    role: "tool_call",
    text: JSON.stringify(actionInput(action)),
    sequence: history.length,
    sourceId: callEvent.id,
    toolName: action.tool,
    toolCallId: callEvent.toolCallId,
    truncated: false,
  });
  history.push({
    id: resultEvent.id,
    role: "tool_result",
    text: execution.text,
    sequence: history.length,
    sourceId: resultEvent.id,
    toolName: action.tool,
    toolCallId: callEvent.toolCallId,
    isError: !execution.passed,
    truncated: false,
  });
}
