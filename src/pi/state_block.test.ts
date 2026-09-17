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
