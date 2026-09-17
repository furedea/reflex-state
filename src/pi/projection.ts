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
    return projectionResult(messages, messages, "disabled");
  if (context.compacting) return projectionResult(messages, messages, "compacting");
  const boundary = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      message.stopReason !== "toolUse" &&
      message.stopReason !== "pending",
  );
  const run = messages.slice(boundary + 1);
  if (!containsGoal(run, context))
    return projectionResult(messages, messages, "missing_user_prompt");
  if (!completeExchanges(run)) return projectionResult(messages, messages, "incomplete_exchange");
  const placement =
    context.config.projection.placement === "run-start"
      ? run.findIndex((message) => message.role === "user")
      : run.length - 1;
  const target = run[placement];
  if (!target || (target.role !== "user" && target.role !== "toolResult"))
    return projectionResult(messages, messages, "unsupported_placement");
  const block = stateBlock(context);
  if (!block) return projectionResult(messages, messages, "state_block_budget");
  const content =
    typeof target.content === "string"
      ? [{ type: "text" as const, text: target.content }]
      : [...target.content];
  run[placement] = { ...target, content: [...content, { type: "text", text: block }] };
  return projectionResult(messages, run);
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
): { messages: Message[]; measurement: ProjectionMeasurement } {
  return {
    messages,
    measurement: {
      messagesBefore: before.length,
      messagesAfter: messages.length,
      charsBefore: JSON.stringify(before).length,
      charsAfter: JSON.stringify(messages).length,
      ...(fallback ? { fallback } : {}),
    },
  };
}
