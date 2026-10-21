import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { boundedText, textContent } from "../core/events.js";
import type { ProjectionMeasurement } from "../core/types.js";
import { stateBlock } from "./state_block.js";
import type { StateBlockContext } from "./state_block.js";

type Message = ContextEvent["messages"][number];

type ProjectionMode = NonNullable<ProjectionMeasurement["mode"]>;

interface Fallback {
  readonly reason: string;
  readonly mode: ProjectionMode;
}

interface PlacementTarget {
  readonly index: number;
  readonly message: Message;
}

type ProjectionPlan =
  | { readonly retained: Message[]; readonly target: PlacementTarget }
  | { readonly fallback: Fallback };

interface Projection {
  messages: Message[];
  measurement: ProjectionMeasurement;
}

export function projectContext(
  messages: Message[],
  context: StateBlockContext & { compacting?: boolean },
): Projection {
  const preflight = preflightFallback(context);
  if (preflight) return fallbackResult(messages, preflight);
  const plan = planProjection(messages, context);
  if ("fallback" in plan) return fallbackResult(messages, plan.fallback);
  const { retained, target } = plan;
  const mode = context.config.projection.mode;
  const block = stateBlock({
    ...context,
    projectionMode: mode,
    messagesOmitted: messages.length - retained.length,
  });
  if (!block) return fallbackResult(messages, { reason: "state_block_budget", mode });
  const projected = addBlock(retained, target, block);
  return {
    messages: projected,
    measurement: { ...measureProjection(messages, projected, mode), stateBlockChars: block.length },
  };
}

function preflightFallback(
  context: StateBlockContext & { compacting?: boolean },
): Fallback | undefined {
  const { config, state } = context;
  if (!config.enabled || !config.projection.enabled)
    return { reason: "disabled", mode: "disabled" };
  if (state.stateHealth && state.stateHealth !== "valid")
    return { reason: state.stateHealth, mode: config.projection.mode };
  if (context.compacting) return { reason: "compacting", mode: "disabled" };
  return undefined;
}

function planProjection(messages: Message[], context: StateBlockContext): ProjectionPlan {
  const mode = context.config.projection.mode;
  const runs = splitRuns(messages);
  const current = runs.at(-1);
  if (!current || !containsGoal(current.messages, context))
    return { fallback: { reason: "missing_user_prompt", mode } };
  if (!completeExchanges(current.messages))
    return { fallback: { reason: "incomplete_exchange", mode } };
  const retained = mode === "append" ? messages : retainRecentRuns(messages, runs, context);
  if (!retained) return { fallback: { reason: "unsafe_boundary", mode: "current-run" } };
  const target = placementTarget(retained, current, context);
  if (!target) return { fallback: { reason: "unsupported_placement", mode } };
  return { retained, target };
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
  if (!hasSafeOmittedPrefix(messages, runs, first)) return undefined;
  if (messages.slice(last.end).length > 0) return undefined;
  if (![first, last].every((run) => completeExchanges(run.messages))) return undefined;
  return containsGoal(last.messages, context) ? messages.slice(first.start, last.end) : undefined;
}

function hasSafeOmittedPrefix(messages: Message[], runs: readonly Run[], first: Run): boolean {
  return (
    runs[0]?.start === 0 &&
    messages.slice(0, first.start).every(isSafeToOmit) &&
    runs.slice(0, -2).every((run) => completeExchanges(run.messages))
  );
}

function isSafeToOmit(message: Message): boolean {
  return ["user", "assistant", "toolResult", "bashExecution"].includes(message.role);
}

function placementTarget(
  retained: Message[],
  current: Run,
  context: StateBlockContext,
): PlacementTarget | undefined {
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
    if (message.role === "assistant" && !openToolCalls(message, pending, seen)) return false;
    if (message.role === "toolResult" && !closeToolCall(message, pending)) return false;
  }
  return pending.size === 0;
}

function openToolCalls(
  message: Extract<Message, { role: "assistant" }>,
  pending: Map<string, string>,
  seen: Set<string>,
): boolean {
  if (pending.size) return false;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    if (seen.has(block.id)) return false;
    seen.add(block.id);
    pending.set(block.id, block.name);
  }
  return true;
}

function closeToolCall(
  message: Extract<Message, { role: "toolResult" }>,
  pending: Map<string, string>,
): boolean {
  if (pending.get(message.toolCallId) !== message.toolName) return false;
  pending.delete(message.toolCallId);
  return true;
}

function fallbackResult(messages: Message[], { reason, mode }: Fallback): Projection {
  return {
    messages,
    measurement: { ...measureProjection(messages, messages, mode), fallback: reason },
  };
}

function measureProjection(
  before: Message[],
  messages: Message[],
  mode: ProjectionMode,
): ProjectionMeasurement {
  return {
    mode,
    messagesBefore: before.length,
    messagesAfter: messages.length,
    messagesOmitted: before.length - messages.length,
    charsBefore: JSON.stringify(before).length,
    charsAfter: JSON.stringify(messages).length,
  };
}
