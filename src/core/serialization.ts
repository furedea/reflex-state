import type { AgentEvent, StateTransitionRecord } from "./types.js";

export class InvalidTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTraceError";
  }
}

export class LegacyTraceError extends Error {
  constructor(message = "Legacy ReflexState state requires reset") {
    super(message);
    this.name = "LegacyTraceError";
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
  if (value.type === "session_resume" && ["resume", "branch_switch"].includes(String(value.reason)))
    return value as unknown as AgentEvent;
  if (
    value.type === "agent_end" &&
    excerpt(value.finalText) &&
    ["stop", "length", "error", "aborted"].includes(String(value.stopReason))
  )
    return value as unknown as AgentEvent;
  if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string")
    throw new InvalidTraceError("Invalid tool event");
  if (
    value.type === "tool_call" &&
    isRecord(value.input) &&
    (value.commandTruncated === undefined || typeof value.commandTruncated === "boolean") &&
    (value.cwd === undefined || typeof value.cwd === "string")
  )
    return value as unknown as AgentEvent;
  if (value.type === "tool_result" && typeof value.isError === "boolean" && excerpt(value.excerpt))
    return value as unknown as AgentEvent;
  throw new InvalidTraceError("Unknown or invalid event payload");
}

export function parseTransition(value: unknown): StateTransitionRecord {
  if (isRecord(value) && isRecord(value.after) && value.after.version === 1)
    throw new LegacyTraceError();
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^T\d+$/.test(value.id) ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.updater !== "string" ||
    typeof value.cwd !== "string" ||
    !isRecord(value.config) ||
    !strings(value.changes) ||
    !isRecord(value.after) ||
    !Number.isSafeInteger(value.after.version) ||
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
  if (value.after.version !== 2)
    throw new InvalidTraceError("Unsupported ReflexState state version");
  if (
    !Number.isSafeInteger(value.after.observationGeneration) ||
    Number(value.after.observationGeneration) < 0 ||
    !strings(value.after.pendingChanges) ||
    !value.after.pendingChanges.every((id) => /^E\d+$/.test(id)) ||
    !["valid", "legacy_state_requires_reset", "invalid"].includes(String(value.after.stateHealth))
  )
    throw new InvalidTraceError("Invalid ReflexState state metadata");
  if (!validCursor(value.after.cursor)) throw new InvalidTraceError("Invalid state cursor");
  if (!validBlockers(value.after.activeBlockers)) throw new InvalidTraceError("Invalid blockers");
  if (!validVerification(value.after.verification))
    throw new InvalidTraceError("Invalid verification freshness");
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

function validCursor(value: Record<string, unknown>): boolean {
  return (
    (value.lastEventId === null ||
      (typeof value.lastEventId === "string" && /^E\d+$/.test(value.lastEventId))) &&
    Number.isSafeInteger(value.eventCount) &&
    Number(value.eventCount) >= 0 &&
    Number.isSafeInteger(value.turnIndex) &&
    Number(value.turnIndex) >= 0
  );
}

function validBlockers(value: unknown[]): boolean {
  const categories = new Set([
    "implementation",
    "environment",
    "dependency",
    "test",
    "permissions",
    "network",
    "unknown",
  ]);
  return value.every(
    (item) =>
      isRecord(item) &&
      typeof item.eventId === "string" &&
      /^E\d+$/.test(item.eventId) &&
      typeof item.origin === "string" &&
      (item.origin === "tool_error"
        ? !Object.hasOwn(item, "kind")
        : item.origin === "verification" &&
          ["build", "test", "lint"].includes(String(item.kind)) &&
          typeof item.checkKey === "string") &&
      categories.has(String(item.category)),
  );
}

function validVerification(value: Record<string, unknown>): boolean {
  return (["build", "test", "lint"] as const).every((kind) => {
    const item = value[kind];
    return (
      isRecord(item) &&
      ["not_run", "running", "passed", "failed", "unknown"].includes(String(item.status)) &&
      ["current", "stale", "unknown"].includes(String(item.freshness)) &&
      (item.evidence === undefined ||
        (typeof item.evidence === "string" && /^E\d+$/.test(item.evidence))) &&
      (item.checkKey === undefined || typeof item.checkKey === "string") &&
      (item.command === undefined || typeof item.command === "string") &&
      (item.cwd === undefined || typeof item.cwd === "string")
    );
  });
}
