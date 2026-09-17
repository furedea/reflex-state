import { defaultConfig } from "../core/config.js";
import { initialState } from "../core/reducer.js";
import { callFixture, excerptFixture, resultFixture } from "../core/test_fixtures.js";
import type { AgentEvent, EventId } from "../core/types.js";
import { stateBlock } from "./state_block.js";

test("state blocks expose bounded verbatim requests and failure evidence without probabilities", () => {
  const prompt: AgentEvent = {
    ...callFixture(),
    type: "user_prompt",
    text: "Fix the failing test",
  };
  const failure = resultFixture({
    isError: true,
    excerpt: excerptFixture("AssertionError: expected 2, received 3"),
  });
  const state = {
    ...initialState(),
    goal: prompt.id,
    verification: {
      ...initialState().verification,
      test: { status: "failed" as const, evidence: failure.id, command: "pnpm test" },
    },
  };
  const evidence = new Map<EventId, AgentEvent>([
    [prompt.id, prompt],
    [failure.id, failure],
  ]);
  const config = defaultConfig();
  const block = stateBlock({ state, evidence, config });
  expect(block).toContain(prompt.text);
  expect(block).toContain(failure.excerpt.head);
  expect(block).not.toContain("probability");
  expect(block?.length).toBeLessThanOrEqual(config.limits.maxStateBlockChars);
  expect(
    stateBlock({
      state,
      evidence,
      config: { ...config, limits: { ...config.limits, maxStateBlockChars: 100 } },
    }),
  ).toBeUndefined();
});

test("working-set errors are projected with their recorded content even without a blocker", () => {
  const result = resultFixture({ excerpt: excerptFixture("TypeError: cannot read property x") });
  const state = { ...initialState(), workingSet: [result.id] };
  const block = stateBlock({
    state,
    evidence: new Map<EventId, AgentEvent>([[result.id, result]]),
    config: defaultConfig(),
    projectionMode: "append",
  });
  expect(block).toContain("TypeError: cannot read property x");
  expect(block).toContain('"working_set"');
});

test("state block reports omitted blockers and unavailable evidence", () => {
  const blockers = Array.from({ length: 9 }, (_, index) => ({
    eventId: ("E" + (index + 1)) as EventId,
    origin: "tool_error" as const,
    category: "unknown" as const,
  }));
  const block = stateBlock({
    state: { ...initialState(), activeBlockers: blockers },
    evidence: new Map(),
    config: defaultConfig(),
  });
  expect(block).toContain('"unresolved_total": 9');
  expect(block).toContain('"omitted_count": 1');
  expect(block).toContain("evidence_unavailable");
});
