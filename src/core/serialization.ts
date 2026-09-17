import type { AgentEvent, StateTransitionRecord } from "./types.js";

class InvalidTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTraceError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonLines<T>(text: string, parse: (value: unknown) => T): T[] {
  return text.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [parse(JSON.parse(line))];
    } catch {
      throw new InvalidTraceError("Invalid trace at line " + (index + 1));
    }
  });
}

export function parseEvent(value: unknown): AgentEvent {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^E\d+$/.test(value.id) ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    !Number.isSafeInteger(value.turnIndex) ||
    Number(value.turnIndex) < 0 ||
    !isRecord(value.source) ||
    !["tool_call", "user_prompt", "assistant_message"].includes(String(value.source.kind)) ||
    typeof value.source.timestamp !== "number" ||
    !Number.isFinite(value.source.timestamp)
  ) {
    throw new InvalidTraceError("Invalid event envelope");
  }
  if (value.type === "user_prompt" && typeof value.text === "string")
    return value as unknown as AgentEvent;
  if (value.type === "file_change" && strings(value.paths)) return value as unknown as AgentEvent;
  if (
    value.type === "agent_end" &&
    excerpt(value.finalText) &&
    ["stop", "length", "error", "aborted"].includes(String(value.stopReason))
  )
    return value as unknown as AgentEvent;
  if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string")
    throw new InvalidTraceError("Invalid tool event");
  if (value.type === "tool_call" && isRecord(value.input)) return value as unknown as AgentEvent;
  if (value.type === "tool_result" && typeof value.isError === "boolean" && excerpt(value.excerpt))
    return value as unknown as AgentEvent;
  throw new InvalidTraceError("Unknown or invalid event payload");
}

export function parseTransition(value: unknown): StateTransitionRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "string" ||
    typeof value.updater !== "string" ||
    typeof value.cwd !== "string" ||
    !isRecord(value.config) ||
    !strings(value.changes) ||
    !isRecord(value.after) ||
    value.after.version !== 1 ||
    !isRecord(value.after.cursor) ||
    !isRecord(value.after.verification) ||
    !strings(value.after.workingSet) ||
    !strings(value.after.modifiedFiles) ||
    !strings(value.after.relevantFiles) ||
    !Array.isArray(value.after.activeBlockers) ||
    !isRecord(value.decisions) ||
    !Array.isArray(value.decisions.resolvedBlockers) ||
    !Array.isArray(value.decisions.relevance) ||
    !isRecord(value.decisions.telemetry) ||
    !strings(value.decisions.telemetry.questionIds)
  ) {
    throw new InvalidTraceError("Invalid or unsupported ReflexState transition");
  }
  parseEvent(value.event);
  return value as unknown as StateTransitionRecord;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function excerpt(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.head === "string" &&
    typeof value.sha256 === "string" &&
    typeof value.truncated === "boolean" &&
    Number.isSafeInteger(value.totalChars) &&
    Number(value.totalChars) >= 0 &&
    (value.tail === undefined || typeof value.tail === "string")
  );
}
