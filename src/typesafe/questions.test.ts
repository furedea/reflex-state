import { extractFacts } from "../core/extraction.js";
import {
  callFixture,
  contextFixture,
  excerptFixture,
  resultFixture,
} from "../core/test_fixtures.js";
import type { AgentEvent, EventId } from "../core/types.js";
import { buildQuestions } from "./questions.js";

test.each(["read", "grep", "find", "ls"])(
  "%s results never ask Jev, even on errors with active blockers",
  (toolName) => {
    const context = contextFixture(resultFixture({ toolName, isError: true }));
    context.state = {
      ...context.state,
      activeBlockers: [{ eventId: "E0099", origin: "tool_error", category: "unknown" }],
    };
    expect(buildQuestions({ ...context, facts: extractFacts(context) })).toEqual({});
  },
);

test("tool errors ask introduction and category in one batch, with phase only in shadow", () => {
  const context = contextFixture(resultFixture({ isError: true }));
  expect(Object.keys(buildQuestions({ ...context, facts: extractFacts(context) })).sort()).toEqual([
    "blocker_introduced",
    "failure_category",
    "phase_shadow",
  ]);
  context.evidence.set("E0001", callFixture());
  context.event = resultFixture({
    isError: true,
    excerpt: excerptFixture("Command exited with code 1"),
  });
  expect(Object.keys(buildQuestions({ ...context, facts: extractFacts(context) })).sort()).toEqual([
    "failure_category",
    "phase_shadow",
  ]);
});

test("successful results only ask to resolve tool-origin blockers", () => {
  const context = contextFixture(resultFixture());
  expect(buildQuestions({ ...context, facts: extractFacts(context) })).toEqual({});
  context.state = {
    ...context.state,
    activeBlockers: [
      { eventId: "E0098", origin: "verification", kind: "test", category: "test" },
      { eventId: "E0099", origin: "tool_error", category: "network" },
    ],
  };
  expect(Object.keys(buildQuestions({ ...context, facts: extractFacts(context) })).sort()).toEqual([
    "phase_shadow",
    "resolves_E0099",
  ]);
});

test("run end asks task completion and capacity pressure asks at most four oldest candidates", () => {
  const event: AgentEvent = {
    ...callFixture(),
    type: "agent_end",
    finalText: excerptFixture("done"),
    stopReason: "stop",
  };
  const context = contextFixture(event);
  expect(Object.keys(buildQuestions({ ...context, facts: extractFacts(context) })).sort()).toEqual([
    "phase_shadow",
    "task_complete",
  ]);
  context.event = resultFixture({ id: "E0020", isError: true });
  context.state = {
    ...context.state,
    workingSet: Array.from({ length: 16 }, (_, i) => ("E" + i) as EventId),
  };
  expect(
    Object.keys(buildQuestions({ ...context, facts: extractFacts(context) })).filter((key) =>
      key.startsWith("relevant_"),
    ),
  ).toEqual(["relevant_E0", "relevant_E1", "relevant_E2", "relevant_E3"]);
});
