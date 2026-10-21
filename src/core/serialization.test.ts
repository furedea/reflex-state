import { defaultConfig } from "./config.js";
import { initialState } from "./reducer.js";
import {
  InvalidTraceError,
  LegacyTraceError,
  parseEvent,
  parseTransition,
} from "./serialization.js";
import { callFixture } from "./test_fixtures.js";
import { emptyDecisions } from "./updater.js";

test("v2 transitions require freshness and observation metadata", () => {
  const state = initialState();
  const event = callFixture();
  const record = {
    id: "T0001",
    timestamp: event.timestamp,
    event,
    after: state,
    changes: [],
    decisions: emptyDecisions(),
    updater: "noop",
    config: defaultConfig(),
    cwd: "/workspace",
  };
  expect(parseTransition(record)).toEqual(record);
  expect(() => parseTransition({ ...record, after: { ...state, version: 1 } })).toThrow(
    LegacyTraceError,
  );
  expect(() =>
    parseTransition({ ...record, after: { ...state, pendingChanges: undefined } }),
  ).toThrow(InvalidTraceError);
});

test("session resume events are valid core events", () => {
  const event = {
    ...callFixture(),
    type: "session_resume" as const,
    reason: "resume" as const,
  };
  expect(parseEvent(event)).toEqual(event);
});

test("malformed v2 blocker and cursor data are rejected", () => {
  const state = initialState();
  const event = callFixture();
  const record = {
    id: "T0001",
    timestamp: event.timestamp,
    event,
    after: state,
    changes: [],
    decisions: emptyDecisions(),
    updater: "noop",
    config: defaultConfig(),
    cwd: "/workspace",
  };
  expect(() =>
    parseTransition({
      ...record,
      after: { ...state, cursor: { ...state.cursor, eventCount: -1 } },
    }),
  ).toThrow(InvalidTraceError);
  expect(() =>
    parseTransition({
      ...record,
      after: {
        ...state,
        activeBlockers: [
          { eventId: "E0001", origin: "verification", kind: "test", category: "unknown" },
        ],
      },
    }),
  ).toThrow(InvalidTraceError);
});

test("parseEvent accepts each event payload shape and rejects malformed ones", () => {
  const base = { ...callFixture() };
  const excerpt = { head: "h", sha256: "s", truncated: false, totalChars: 1 };
  const accepted = [
    { ...base, type: "user_prompt", text: "hi" },
    { ...base, type: "file_change", paths: ["a.ts"] },
    { ...base, type: "agent_end", finalText: excerpt, stopReason: "stop" },
    { ...base, type: "tool_result", isError: false, excerpt },
    base,
  ];
  for (const event of accepted) expect(parseEvent(event)).toEqual(event);
  const rejected = [
    { ...base, type: "user_prompt", text: 1 },
    { ...base, type: "file_change", paths: [1] },
    { ...base, type: "agent_end", finalText: excerpt, stopReason: "other" },
    { ...base, type: "tool_result", isError: false, excerpt: { ...excerpt, totalChars: -1 } },
    { ...base, type: "tool_call", input: null },
    { ...base, id: "X1" },
    { ...base, source: { kind: "tool_call", timestamp: Number.NaN } },
  ];
  for (const event of rejected) expect(() => parseEvent(event)).toThrow(InvalidTraceError);
  expect(() => parseEvent({ ...base, type: "constructor", toolCallId: undefined })).toThrow(
    "Invalid tool event",
  );
});
