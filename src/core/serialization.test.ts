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
