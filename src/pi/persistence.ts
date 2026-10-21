import { initialState } from "../core/reducer.js";
import { isRecord, LegacyTraceError, parseTransition } from "../core/serialization.js";
import type { AgentEvent, EventId, StateTransitionRecord } from "../core/types.js";

interface StoredEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

interface Reconstruction {
  state: ReturnType<typeof initialState>;
  readonly events: Map<EventId, AgentEvent>;
  readonly transitions: StateTransitionRecord[];
  hasMeta: boolean;
  legacy: boolean;
}

export function reconstruct(branch: readonly StoredEntry[]) {
  const reconstruction: Reconstruction = {
    state: initialState(),
    events: new Map<EventId, AgentEvent>(),
    transitions: [],
    hasMeta: false,
    legacy: false,
  };
  for (const entry of branch) {
    if (entry.type === "custom") applyEntry(reconstruction, entry);
  }
  const { state, events, transitions, hasMeta, legacy } = reconstruction;
  return {
    state: legacy
      ? { ...initialState(), stateHealth: "legacy_state_requires_reset" as const }
      : state,
    events,
    transitions,
    hasMeta,
    legacy,
  };
}

function applyEntry(reconstruction: Reconstruction, entry: StoredEntry): void {
  if (
    entry.customType === "reflex-state.meta" &&
    isRecord(entry.data) &&
    entry.data.stateVersion === 2
  )
    reconstruction.hasMeta = true;
  if (entry.customType === "reflex-state.reset") resetReconstruction(reconstruction);
  else if (entry.customType === "reflex-state.transition") applyTransition(reconstruction, entry);
}

function resetReconstruction(reconstruction: Reconstruction): void {
  reconstruction.state = initialState();
  reconstruction.events.clear();
  reconstruction.transitions.length = 0;
  reconstruction.legacy = false;
}

function applyTransition(reconstruction: Reconstruction, entry: StoredEntry): void {
  const record = parseStoredTransition(entry.data);
  if (!record) {
    reconstruction.legacy = true;
    return;
  }
  if (reconstruction.legacy) return;
  if (reconstruction.events.has(record.event.id))
    throw new Error("Duplicate ReflexState event on branch");
  reconstruction.state = record.after;
  reconstruction.events.set(record.event.id, record.event);
  reconstruction.transitions.push(record);
}

function parseStoredTransition(data: unknown): StateTransitionRecord | undefined {
  try {
    return parseTransition(data);
  } catch (error) {
    if (error instanceof LegacyTraceError) return undefined;
    throw error;
  }
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
