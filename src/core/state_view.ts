import type { ReflexStateConfig } from "./config.js";
import type { AgentEvent, Blocker, EventId, HotState } from "./types.js";

interface BlockerView {
  readonly unresolvedTotal: number;
  readonly shownCount: number;
  readonly omittedCount: number;
  readonly blockers: readonly Blocker[];
}

interface WorkingSetView {
  readonly total: number;
  readonly shownCount: number;
  readonly omittedCount: number;
  readonly events: readonly EventId[];
}

export function blockerView(state: HotState, config: ReflexStateConfig): BlockerView {
  const limit = config.limits.maxProjectedBlockers;
  const blockers = state.activeBlockers.slice(-limit);
  return {
    unresolvedTotal: state.activeBlockers.length,
    shownCount: blockers.length,
    omittedCount: state.activeBlockers.length - blockers.length,
    blockers,
  };
}

export function workingSetView(state: HotState, limit: number): WorkingSetView {
  const events = state.workingSet.slice(-limit);
  return {
    total: state.workingSet.length,
    shownCount: events.length,
    omittedCount: state.workingSet.length - events.length,
    events,
  };
}

export function stateView(
  state: HotState,
  evidence: ReadonlyMap<EventId, AgentEvent>,
  config: ReflexStateConfig,
) {
  return {
    blockers: blockerView(state, config),
    workingSet: {
      ...workingSetView(state, config.limits.maxWorkingSetEvents),
      available: state.workingSet.filter((id) => evidence.has(id)),
    },
  };
}
