import { defaultConfig } from "./config.js";
import { StateEngine } from "./engine.js";
import { Metrics } from "./metrics.js";
import { callFixture, excerptFixture, resultFixture } from "./test_fixtures.js";
import { emptyDecisions } from "./updater.js";

test("shadow agreement compares the rule-based phase before semantic completion", async () => {
  const metrics = new Metrics();
  const engine = new StateEngine({
    cwd: "/workspace",
    config: defaultConfig(),
    onTransition: (record) => metrics.transition(record),
    updater: {
      name: "fixture",
      evaluate: async ({ event }) =>
        event.type === "agent_end"
          ? {
              ...emptyDecisions(),
              taskComplete: { value: true, gate: "applied", probability: 0.99 },
              phaseShadow: { value: "testing", gate: "applied", shadow: true, confidence: 0.9 },
            }
          : emptyDecisions(),
    },
  });
  await engine.process(callFixture());
  await engine.process(resultFixture());
  await engine.process({
    ...callFixture(),
    id: "E0003",
    type: "agent_end",
    stopReason: "stop",
    finalText: excerptFixture("Complete"),
  });
  expect(engine.state.phase).toBe("done");
  expect(metrics.snapshot().shadowAgreement).toBe(1);
  expect(metrics.snapshot().jevInputTokens).toBeUndefined();
});

test("projection metrics leave unavailable block sizes unset", () => {
  const metrics = new Metrics();
  metrics.projection({
    mode: "disabled",
    messagesBefore: 2,
    messagesAfter: 2,
    messagesOmitted: 0,
    charsBefore: 20,
    charsAfter: 20,
    fallback: "disabled",
  });
  expect(metrics.snapshot().projection.meanStateBlockChars).toBeUndefined();
});
