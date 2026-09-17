import { defaultConfig } from "./config.js";
import { initialState } from "./reducer.js";
import { blockerView, stateView } from "./state_view.js";
import type { EventId, HotState } from "./types.js";

test("projection limits do not delete unresolved blockers from the source state", () => {
  const activeBlockers = Array.from({ length: 9 }, (_, index) => ({
    eventId: ("E" + (index + 1)) as EventId,
    origin: "tool_error" as const,
    category: "test" as const,
  }));
  const state: HotState = { ...initialState(), activeBlockers };
  const view = blockerView(state, defaultConfig());
  expect(state.activeBlockers).toHaveLength(9);
  expect(view).toMatchObject({ unresolvedTotal: 9, shownCount: 8, omittedCount: 1 });
  expect(view.blockers[0]?.eventId).toBe("E2");
});

test("state view reports unavailable working-set evidence without changing the state", () => {
  const state = { ...initialState(), workingSet: ["E0001", "E0002"] as EventId[] };
  const view = stateView(state, new Map(), defaultConfig());
  expect(view.workingSet).toMatchObject({
    total: 2,
    shownCount: 2,
    omittedCount: 0,
    available: [],
  });
  expect(state.workingSet).toEqual(["E0001", "E0002"]);
});
