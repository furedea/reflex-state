import type { AgentEvent, Excerpt } from "../core/types.js";
import type { StateUpdateContext } from "../core/updater.js";

export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----\s*|$)/g,
      "[REDACTED]",
    )
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=).*$/gm, "$1[REDACTED]");
}

export function buildInput(context: StateUpdateContext): string {
  let excerptLimit = 1800;
  while (true) {
    const input = JSON.stringify(sanitize(inputObject(context, excerptLimit)));
    if (Buffer.byteLength(input) <= 24_000) return input;
    if (excerptLimit === 0) throw new Error("input_budget_exceeded");
    excerptLimit = Math.floor(excerptLimit / 2);
  }
}

function inputObject(
  { state, event, facts, evidence, config }: StateUpdateContext,
  excerptLimit: number,
) {
  const goal = state.goal ? evidence.get(state.goal) : undefined;
  const ids = new Set([
    ...state.activeBlockers.map((blocker) => blocker.eventId),
    ...state.workingSet,
  ]);
  const related = [...ids].flatMap((id) => {
    const source = evidence.get(id);
    return source && !isReadResult(source) ? [[id, inputEvent(source, excerptLimit)]] : [];
  });
  const call =
    event.type === "tool_result"
      ? [...evidence.values()].find(
          (source) => source.type === "tool_call" && source.toolCallId === event.toolCallId,
        )
      : undefined;
  return {
    schema: {
      phase: "Current activity; done means the user's goal is complete.",
      blocker:
        "An unresolved obstacle backed by an event. Verification-origin blockers are resolved by code.",
      verification:
        "Observed overall command outcome; compound commands do not prove every segment ran.",
    },
    goal:
      goal?.type === "user_prompt"
        ? { id: goal.id, text: redact(goal.text).slice(0, config.limits.maxPromptChars) }
        : null,
    current_state: {
      phase: state.phase,
      taskStatus: state.taskStatus,
      verification: state.verification,
      activeBlockers: state.activeBlockers,
      modifiedFiles: state.modifiedFiles,
    },
    latest_event: {
      ...inputEvent(event, excerptLimit),
      verification: facts.verification,
      exitCode: facts.exitCode,
      command:
        call?.type === "tool_call" && typeof call.input.command === "string"
          ? redact(call.input.command).slice(0, 2000)
          : undefined,
    },
    evidence: Object.fromEntries(related),
  };
}

function inputEvent(event: AgentEvent, excerptLimit: number) {
  if (event.type === "tool_result")
    return {
      id: event.id,
      type: event.type,
      toolName: event.toolName,
      isError: event.isError,
      excerpt: ["bash", "edit", "write"].includes(event.toolName)
        ? excerptText(event.excerpt, excerptLimit)
        : undefined,
    };
  if (event.type === "agent_end")
    return {
      id: event.id,
      type: event.type,
      stopReason: event.stopReason,
      finalText: excerptText(event.finalText, excerptLimit),
    };
  if (event.type === "user_prompt")
    return { id: event.id, type: event.type, text: redact(event.text).slice(0, excerptLimit) };
  if (event.type === "file_change") return { id: event.id, type: event.type, paths: event.paths };
  return { id: event.id, type: event.type, toolName: event.toolName };
}

function excerptText(excerpt: Excerpt, limit: number): string {
  const text = redact(excerpt.head + (excerpt.tail ? "\n[excerpt gap]\n" + excerpt.tail : ""));
  return boundedText(text, limit);
}

function isReadResult(event: AgentEvent): boolean {
  return event.type === "tool_result" && ["read", "grep", "find", "ls"].includes(event.toolName);
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}
import { boundedText } from "../core/events.js";
