import { defaultConfig } from "./config.js";
import type {
  AgentEvent,
  EventId,
  Excerpt,
  HotState,
  ToolCallEvent,
  ToolResultEvent,
} from "./types.js";

function stateFixture(): HotState {
  return {
    version: 2,
    goal: null,
    phase: "unknown",
    taskStatus: "unknown",
    modifiedFiles: [],
    relevantFiles: [],
    verification: {
      build: { status: "not_run", freshness: "unknown" },
      test: { status: "not_run", freshness: "unknown" },
      lint: { status: "not_run", freshness: "unknown" },
    },
    activeBlockers: [],
    workingSet: [],
    observationGeneration: 0,
    pendingChanges: [],
    stateHealth: "valid",
    cursor: { lastEventId: null, eventCount: 0, turnIndex: 0 },
    lastUpdatedAt: "1970-01-01T00:00:00.000Z",
  };
}

export function excerptFixture(text: string): Excerpt {
  return { head: text, totalChars: text.length, sha256: "fixture", truncated: false };
}

export function callFixture(
  input: Record<string, unknown> = { command: "pnpm test" },
): ToolCallEvent {
  return {
    id: "E0001",
    timestamp: "2026-09-17T00:00:00.000Z",
    turnIndex: 1,
    source: { kind: "tool_call", timestamp: 0, toolCallId: "call-1" },
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "bash",
    input,
  };
}

export function resultFixture(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    ...callFixture(),
    id: "E0002",
    type: "tool_result",
    isError: false,
    excerpt: excerptFixture("passed"),
    ...overrides,
  };
}

export function contextFixture(event: AgentEvent) {
  return {
    state: stateFixture(),
    event,
    evidence: new Map<EventId, AgentEvent>(),
    cwd: "/workspace",
    config: defaultConfig(),
  };
}
