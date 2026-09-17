import { defaultConfig } from "../core/config.js";
import { StateEngine } from "../core/engine.js";
import { initialState } from "../core/reducer.js";
import { callFixture, excerptFixture, resultFixture } from "../core/test_fixtures.js";
import { emptyDecisions, NoopStateUpdater } from "../core/updater.js";
import { highestEventOrdinal, reconstruct } from "./persistence.js";

test("restoration uses only the selected root-to-leaf branch and respects the last reset", async () => {
  const engine = new StateEngine({
    cwd: "/workspace",
    config: defaultConfig(),
    updater: new NoopStateUpdater(),
  });
  const call = await engine.process(callFixture());
  const failed = await engine.process(
    resultFixture({ isError: true, excerpt: excerptFixture("Command exited with code 1") }),
  );
  const passed = await engine.process(resultFixture({ id: "E0003" }));
  const entry = (data: unknown) => ({
    type: "custom",
    customType: "reflex-state.transition",
    data,
  });
  const branchA = [entry(call), entry(failed)];
  const branchB = [entry(call), entry(passed)];
  expect(reconstruct(branchA).state.verification.test.status).toBe("failed");
  expect(reconstruct(branchB).state.verification.test.status).toBe("passed");
  const reset = [
    ...branchA,
    { type: "custom", customType: "reflex-state.reset", data: { reason: "user" } },
  ];
  expect(reconstruct(reset).state).toEqual(initialState());
  expect(reconstruct(reset).events.size).toBe(0);
  expect(highestEventOrdinal([...reset, entry(passed)])).toBe(3);
  expect(branchA).toHaveLength(2);
  expect(reconstruct(branchA).events.get("E0002")).toEqual(failed.event);
});

test("legacy state pauses updates until an explicit reset while preserving event ordinals", () => {
  const legacy = {
    id: "T0001",
    timestamp: "2026-09-17T00:00:00.000Z",
    event: callFixture(),
    after: {
      version: 1,
      cursor: { lastEventId: "E0001", eventCount: 1, turnIndex: 1 },
      verification: {},
      workingSet: [],
      modifiedFiles: [],
      relevantFiles: [],
      activeBlockers: [],
    },
    changes: [],
    decisions: emptyDecisions(),
    updater: "noop",
    config: defaultConfig(),
    cwd: "/workspace",
  };
  const entry = (data: unknown) => ({
    type: "custom",
    customType: "reflex-state.transition",
    data,
  });
  const restored = reconstruct([entry(legacy)]);
  expect(restored.legacy).toBe(true);
  expect(restored.state.stateHealth).toBe("legacy_state_requires_reset");
  expect(highestEventOrdinal([entry(legacy)])).toBe(1);
  const reset = reconstruct([
    entry(legacy),
    { type: "custom", customType: "reflex-state.reset", data: { reason: "user" } },
  ]);
  expect(reset.legacy).toBe(false);
  expect(reset.state.stateHealth).toBe("valid");
});
