import { defaultConfig } from "../core/config.js";
import { callFixture, excerptFixture, resultFixture } from "../core/test_fixtures.js";
import type { AgentEvent } from "../core/types.js";
import { emptyDecisions, NoopStateUpdater, RecordedDecisionsUpdater } from "../core/updater.js";
import { replay } from "./runner.js";

test("recorded decisions reproduce the live final state and retain raw probabilities", async () => {
  const events: AgentEvent[] = [
    callFixture(),
    resultFixture(),
    {
      ...callFixture(),
      id: "E0003",
      type: "agent_end",
      finalText: excerptFixture("finished"),
      stopReason: "stop",
    },
  ];
  const original = await replay(events, {
    cwd: "/workspace",
    config: defaultConfig(),
    updater: {
      name: "fixture",
      evaluate: () =>
        Promise.resolve({
          ...emptyDecisions(),
          taskComplete: { gate: "applied", value: true, probability: 0.97 },
        }),
    },
  });
  const recorded = await replay(events, {
    cwd: "/different",
    config: defaultConfig(),
    updater: new RecordedDecisionsUpdater(original.transitions),
    recording: original.transitions,
  });
  expect(recorded.state).toEqual(original.state);
  expect(recorded.state.taskStatus).toBe("completed");
  expect(recorded.transitions[2]?.decisions.taskComplete?.probability).toBe(0.97);
  expect(recorded.metrics.jevInputTokens).toBeUndefined();
});

test("replay rejects duplicate event IDs instead of silently changing the trace", async () => {
  await expect(
    replay([callFixture(), callFixture()], {
      cwd: "/workspace",
      config: defaultConfig(),
      updater: new NoopStateUpdater(),
    }),
  ).rejects.toThrow("Duplicate event ID");
});

test("recorded replay rejects changed events even if their IDs match", async () => {
  const options = { cwd: "/workspace", config: defaultConfig(), updater: new NoopStateUpdater() };
  const original = await replay([callFixture()], options);
  await expect(
    replay([callFixture({ command: "pnpm build" })], {
      ...options,
      updater: new RecordedDecisionsUpdater(original.transitions),
    }),
  ).rejects.toThrow("Recorded event differs");
});
