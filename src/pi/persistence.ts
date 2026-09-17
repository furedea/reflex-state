import { initialState } from "../core/reducer.js";
import { isRecord, parseTransition } from "../core/serialization.js";
import type { AgentEvent, EventId, StateTransitionRecord } from "../core/types.js";

interface StoredEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export function reconstruct(branch: readonly StoredEntry[]) {
  let state = initialState();
  const events = new Map<EventId, AgentEvent>();
  const transitions: StateTransitionRecord[] = [];
  let hasMeta = false;
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === "reflex-state.meta") hasMeta = true;
    if (entry.customType === "reflex-state.reset") {
      state = initialState();
      events.clear();
      transitions.length = 0;
      continue;
    }
    if (entry.customType !== "reflex-state.transition") continue;
    const record = parseTransition(entry.data);
    if (events.has(record.event.id)) throw new Error("Duplicate ReflexState event on branch");
    state = record.after;
    events.set(record.event.id, record.event);
    transitions.push(record);
  }
  return { state, events, transitions, hasMeta };
}

export function highestEventOrdinal(entries: readonly StoredEntry[]): number {
  let highest = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "reflex-state.transition") continue;
    const data = entry.data;
    const id = isRecord(data) && isRecord(data.event) ? data.event.id : undefined;
    if (typeof id === "string" && /^E\d+$/.test(id))
      highest = Math.max(highest, Number(id.slice(1)));
  }
  return highest;
}
