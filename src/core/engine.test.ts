import { defaultConfig } from "./config.js";
import { StateEngine } from "./engine.js";
import { callFixture, resultFixture } from "./test_fixtures.js";
import type { EventId, StateTransitionRecord } from "./types.js";
import { emptyDecisions, NoopStateUpdater } from "./updater.js";
import type { StateUpdater } from "./updater.js";

test("an identical raw trace produces an identical log without ambient time", async () => {
  async function run() {
    const engine = new StateEngine({
      cwd: "/workspace",
      config: defaultConfig(),
      updater: new NoopStateUpdater(),
    });
    const log = [];
    for (const event of [callFixture(), resultFixture()]) log.push(await engine.process(event));
    return { log, state: engine.state };
  }
  const first = await run();
  expect(first).toEqual(await run());
  expect(first.state.verification.test.status).toBe("passed");
  expect(first.log).toHaveLength(2);
});

test("overlapping submissions evaluate against their predecessor and persist in order", async () => {
  const release = Promise.withResolvers<void>();
  const observed: (EventId | null)[] = [];
  const saved: StateTransitionRecord[] = [];
  const updater: StateUpdater = {
    name: "controlled",
    async evaluate(context) {
      observed.push(context.state.cursor.lastEventId);
      if (context.event.id === "E0001") await release.promise;
      return emptyDecisions();
    },
  };
  const engine = new StateEngine({
    cwd: "/workspace",
    config: defaultConfig(),
    updater,
    onTransition: (record) => {
      saved.push(record);
    },
  });
  const first = engine.process(callFixture());
  const second = engine.process(resultFixture());
  await Promise.resolve();
  expect(observed).toEqual([null]);
  release.resolve();
  await Promise.all([first, second]);
  expect(observed).toEqual([null, "E0001"]);
  expect(saved.map((record) => record.event.id)).toEqual(["E0001", "E0002"]);
  expect(engine.state.verification.test.status).toBe("passed");
});
