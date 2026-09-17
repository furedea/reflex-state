import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { boundedText, textContent } from "../core/events.js";
import type { ProjectionMeasurement } from "../core/types.js";
import { stateBlock } from "./state_block.js";
import type { StateBlockContext } from "./state_block.js";

type Message = ContextEvent["messages"][number];

export function projectContext(
  messages: Message[],
  context: StateBlockContext & { compacting?: boolean },
) {
  if (!context.config.enabled || !context.config.projection.enabled)
    return projectionResult(messages, messages, "disabled", "disabled");
  if (context.state.stateHealth && context.state.stateHealth !== "valid")
    return projectionResult(
      messages,
      messages,
      context.state.stateHealth,
      context.config.projection.mode,
    );
  if (context.compacting) return projectionResult(messages, messages, "compacting", "disabled");
  const runs = splitRuns(messages);
  const current = runs.at(-1);
  if (!current || !containsGoal(current.messages, context))
    return projectionResult(
      messages,
      messages,
      "missing_user_prompt",
      context.config.projection.mode,
    );
  if (!completeExchanges(current.messages))
    return projectionResult(
      messages,
      messages,
      "incomplete_exchange",
      context.config.projection.mode,
    );
  const retained =
    context.config.projection.mode === "append"
      ? messages
      : retainRecentRuns(messages, runs, context);
  if (!retained) return projectionResult(messages, messages, "unsafe_boundary", "current-run");
  const target = placementTarget(retained, current, context);
  if (!target)
    return projectionResult(
      messages,
      messages,
      "unsupported_placement",
      context.config.projection.mode,
    );
  const block = stateBlock({
    ...context,
    projectionMode: context.config.projection.mode,
    messagesOmitted: messages.length - retained.length,
  });
  if (!block)
    return projectionResult(
      messages,
      messages,
      "state_block_budget",
      context.config.projection.mode,
    );
  const projected = addBlock(retained, target, block);
  return projectionResult(
    messages,
    projected,
    undefined,
    context.config.projection.mode,
    block.length,
  );
}

interface Run {
  readonly start: number;
  readonly end: number;
  readonly messages: Message[];
}

function splitRuns(messages: readonly Message[]): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user" && start < 0) start = index;
    if (start >= 0 && isTerminalAssistant(message)) {
      runs.push({ start, end: index + 1, messages: messages.slice(start, index + 1) });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start, end: messages.length, messages: messages.slice(start) });
  return runs;
}

function retainRecentRuns(
  messages: Message[],
  runs: readonly Run[],
  context: StateBlockContext,
): Message[] | undefined {
  if (runs.length <= 2)
    return runs.every((run) => completeExchanges(run.messages)) ? messages : undefined;
  const first = runs.at(-2);
  const last = runs.at(-1);
  if (!first || !last) return undefined;
  if (runs[0]?.start !== 0) return undefined;
  const omitted = messages.slice(0, first.start);
  if (omitted.some((message) => !isSafeToOmit(message))) return undefined;
  if (runs.slice(0, -2).some((run) => !completeExchanges(run.messages))) return undefined;
  if (messages.slice(last.end).length > 0) return undefined;
  if (!completeExchanges(first.messages) || !completeExchanges(last.messages)) return undefined;
  if (!containsGoal(last.messages, context)) return undefined;
  return messages.slice(first.start, last.end);
}

function isSafeToOmit(message: Message): boolean {
  return ["user", "assistant", "toolResult", "bashExecution"].includes(message.role);
}

function placementTarget(
  retained: Message[],
  current: Run,
  context: StateBlockContext,
):
  | {
      readonly index: number;
      readonly message: Message;
    }
  | undefined {
  const first = current.messages.find((message) => message.role === "user");
  const last = current.messages.at(-1);
  const index =
    context.config.projection.placement === "run-start"
      ? first
        ? retained.indexOf(first)
        : -1
      : last
        ? retained.indexOf(last)
        : -1;
  const message = retained[index];
  return message && (message.role === "user" || message.role === "toolResult")
    ? { index, message }
    : undefined;
}

function isTerminalAssistant(message: Message): boolean {
  return (
    message.role === "assistant" &&
    "stopReason" in message &&
    message.stopReason !== "toolUse" &&
    message.stopReason !== "pending"
  );
}

function addBlock(
  messages: Message[],
  target: { index: number; message: Message },
  block: string,
): Message[] {
  if (target.message.role !== "user" && target.message.role !== "toolResult") return messages;
  const content =
    typeof target.message.content === "string"
      ? [{ type: "text" as const, text: target.message.content }]
      : [...target.message.content];
  const result = messages.slice();
  result[target.index] = {
    ...target.message,
    content: [...content, { type: "text", text: block }],
  };
  return result;
}

function containsGoal(messages: readonly Message[], context: StateBlockContext): boolean {
  const goal = context.state.goal ? context.evidence.get(context.state.goal) : undefined;
  if (context.state.goal && goal?.type !== "user_prompt") return false;
  return messages.some(
    (message) =>
      message.role === "user" &&
      (!goal ||
        (goal.type === "user_prompt" &&
          boundedText(textContent(message.content), context.config.limits.maxPromptChars) ===
            goal.text)),
  );
}

function completeExchanges(messages: readonly Message[]): boolean {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      if (pending.size) return false;
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (seen.has(block.id)) return false;
        seen.add(block.id);
        pending.set(block.id, block.name);
      }
    }
    if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName) return false;
      pending.delete(message.toolCallId);
    }
  }
  return pending.size === 0;
}

function projectionResult(
  before: Message[],
  messages: Message[],
  fallback?: string,
  mode: ProjectionMeasurement["mode"] = "current-run",
  stateBlockChars?: number,
): { messages: Message[]; measurement: ProjectionMeasurement } {
  return {
    messages,
    measurement: {
      mode,
      messagesBefore: before.length,
      messagesAfter: messages.length,
      messagesOmitted: before.length - messages.length,
      charsBefore: JSON.stringify(before).length,
      charsAfter: JSON.stringify(messages).length,
      ...(stateBlockChars === undefined ? {} : { stateBlockChars }),
      ...(fallback ? { fallback } : {}),
    },
  };
}
