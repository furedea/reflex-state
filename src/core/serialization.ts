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
  if (!isEventEnvelope(value)) throw new InvalidTraceError("Invalid event envelope");
  if (simpleEventValidators.get(value.type)?.(value) === true)
    return value as unknown as AgentEvent;
  if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string")
    throw new InvalidTraceError("Invalid tool event");
  if (isToolEventPayload(value)) return value as unknown as AgentEvent;
  throw new InvalidTraceError("Unknown or invalid event payload");
}

export function parseTransition(value: unknown): StateTransitionRecord {
  assertNotLegacy(value);
  if (!isTransitionShape(value))
    throw new InvalidTraceError("Invalid or unsupported ReflexState transition");
  assertSupportedState(value.after);
  parseEvent(value.event);
  return value as unknown as StateTransitionRecord;
}

const EVENT_ID_PATTERN = /^E\d+$/;
const VERIFICATION_KINDS = ["build", "test", "lint"] as const;
const BLOCKER_CATEGORIES = new Set([
  "implementation",
  "environment",
  "dependency",
  "test",
  "permissions",
  "network",
  "unknown",
]);

const simpleEventValidators = new Map<unknown, (value: Record<string, unknown>) => boolean>([
  ["user_prompt", (value) => typeof value.text === "string"],
  ["file_change", (value) => strings(value.paths)],
  ["session_resume", (value) => ["resume", "branch_switch"].includes(String(value.reason))],
  [
    "agent_end",
    (value) =>
      excerpt(value.finalText) &&
      ["stop", "length", "error", "aborted"].includes(String(value.stopReason)),
  ],
]);

function isEventEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    isEventIdString(value.id) &&
    isTimestamp(value.timestamp) &&
    isNonNegativeInteger(value.turnIndex) &&
    isEventSource(value.source)
  );
}

function isEventSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["tool_call", "user_prompt", "assistant_message"].includes(String(value.kind)) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp)
  );
}

function isToolEventPayload(value: Record<string, unknown>): boolean {
  if (value.type === "tool_call")
    return (
      isRecord(value.input) &&
      isOptionalType(value.commandTruncated, "boolean") &&
      isOptionalType(value.cwd, "string")
    );
  return (
    value.type === "tool_result" && typeof value.isError === "boolean" && excerpt(value.excerpt)
  );
}

type TransitionShape = Record<string, unknown> & { after: Record<string, unknown> };

function assertNotLegacy(value: unknown): void {
  if (isRecord(value) && isRecord(value.after) && value.after.version === 1)
    throw new LegacyTraceError();
}

function isTransitionShape(value: unknown): value is TransitionShape {
  return (
    isRecord(value) &&
    isTransitionHeader(value) &&
    isRecord(value.after) &&
    isStateShape(value.after) &&
    isRecord(value.decisions) &&
    isDecisionsShape(value.decisions)
  );
}

function isTransitionHeader(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    /^T\d+$/.test(value.id) &&
    isTimestamp(value.timestamp) &&
    typeof value.updater === "string" &&
    typeof value.cwd === "string" &&
    isRecord(value.config) &&
    strings(value.changes)
  );
}

function isStateShape(after: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(after.version) &&
    isRecord(after.cursor) &&
    isRecord(after.verification) &&
    strings(after.workingSet) &&
    strings(after.modifiedFiles) &&
    strings(after.relevantFiles) &&
    Array.isArray(after.activeBlockers)
  );
}

function isDecisionsShape(decisions: Record<string, unknown>): boolean {
  return (
    Array.isArray(decisions.resolvedBlockers) &&
    Array.isArray(decisions.relevance) &&
    isRecord(decisions.telemetry) &&
    strings(decisions.telemetry.questionIds)
  );
}

function assertSupportedState(after: Record<string, unknown>): void {
  if (after.version !== 2) throw new InvalidTraceError("Unsupported ReflexState state version");
  if (!hasStateMetadata(after)) throw new InvalidTraceError("Invalid ReflexState state metadata");
  if (!isRecord(after.cursor) || !validCursor(after.cursor))
    throw new InvalidTraceError("Invalid state cursor");
  if (!Array.isArray(after.activeBlockers) || !validBlockers(after.activeBlockers))
    throw new InvalidTraceError("Invalid blockers");
  if (!isRecord(after.verification) || !validVerification(after.verification))
    throw new InvalidTraceError("Invalid verification freshness");
}

function hasStateMetadata(after: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(after.observationGeneration) &&
    strings(after.pendingChanges) &&
    after.pendingChanges.every(isEventIdString) &&
    ["valid", "legacy_state_requires_reset", "invalid"].includes(String(after.stateHealth))
  );
}

function isEventIdString(value: unknown): boolean {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOptionalType(value: unknown, type: "string" | "boolean"): boolean {
  return value === undefined || typeof value === type;
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
    isNonNegativeInteger(value.totalChars) &&
    isOptionalType(value.tail, "string")
  );
}

function validCursor(value: Record<string, unknown>): boolean {
  return (
    (value.lastEventId === null || isEventIdString(value.lastEventId)) &&
    isNonNegativeInteger(value.eventCount) &&
    isNonNegativeInteger(value.turnIndex)
  );
}

function validBlockers(value: unknown[]): boolean {
  return value.every(isValidBlocker);
}

function isValidBlocker(item: unknown): boolean {
  return (
    isRecord(item) &&
    isEventIdString(item.eventId) &&
    isBlockerOrigin(item) &&
    BLOCKER_CATEGORIES.has(String(item.category))
  );
}

function isBlockerOrigin(item: Record<string, unknown>): boolean {
  if (item.origin === "tool_error") return !Object.hasOwn(item, "kind");
  return (
    item.origin === "verification" &&
    VERIFICATION_KINDS.some((kind) => kind === String(item.kind)) &&
    typeof item.checkKey === "string"
  );
}

function validVerification(value: Record<string, unknown>): boolean {
  return VERIFICATION_KINDS.every((kind) => isVerificationEntry(value[kind]));
}

function isVerificationEntry(item: unknown): boolean {
  return (
    isRecord(item) &&
    ["not_run", "running", "passed", "failed", "unknown"].includes(String(item.status)) &&
    ["current", "stale", "unknown"].includes(String(item.freshness)) &&
    (item.evidence === undefined || isEventIdString(item.evidence)) &&
    isOptionalType(item.checkKey, "string") &&
    isOptionalType(item.command, "string") &&
    isOptionalType(item.cwd, "string")
  );
}
