import { initialState } from "../core/reducer.js";
import { isRecord, LegacyTraceError, parseTransition } from "../core/serialization.js";
import type { AgentEvent, EventId, StateTransitionRecord } from "../core/types.js";

interface StoredEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

class Reconstruction {
  private state = initialState();
  private readonly events = new Map<EventId, AgentEvent>();
  private readonly transitions: StateTransitionRecord[] = [];
  private hasMeta = false;
  private legacy = false;

  applyEntry(entry: StoredEntry): void {
    if (
      entry.customType === "reflex-state.meta" &&
      isRecord(entry.data) &&
      entry.data.stateVersion === 2
    )
      this.hasMeta = true;
    if (entry.customType === "reflex-state.reset") this.reset();
    else if (entry.customType === "reflex-state.transition") this.applyTransition(entry);
  }

  result() {
    return {
      state: this.legacy
        ? { ...initialState(), stateHealth: "legacy_state_requires_reset" as const }
        : this.state,
      events: this.events,
      transitions: this.transitions,
      hasMeta: this.hasMeta,
      legacy: this.legacy,
    };
  }

  private reset(): void {
    this.state = initialState();
    this.events.clear();
    this.transitions.length = 0;
    this.legacy = false;
  }

  private applyTransition(entry: StoredEntry): void {
    const record = parseStoredTransition(entry.data);
    if (!record) {
      this.legacy = true;
      return;
    }
    if (this.legacy) return;
    if (this.events.has(record.event.id)) throw new Error("Duplicate ReflexState event on branch");
    this.state = record.after;
    this.events.set(record.event.id, record.event);
    this.transitions.push(record);
  }
}

export function reconstruct(branch: readonly StoredEntry[]) {
  const reconstruction = new Reconstruction();
  for (const entry of branch) {
    if (entry.type === "custom") reconstruction.applyEntry(entry);
  }
  return reconstruction.result();
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
