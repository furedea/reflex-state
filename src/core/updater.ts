import type { ReflexStateConfig } from "./config.js";
import type { StateTransitionRecord } from "./types.js";
import type {
  AgentEvent,
  DeterministicFacts,
  EventId,
  HotState,
  SemanticDecisions,
} from "./types.js";

export interface StateUpdateContext {
  readonly state: HotState;
  readonly event: AgentEvent;
  readonly facts: DeterministicFacts;
  readonly evidence: ReadonlyMap<EventId, AgentEvent>;
  readonly config: ReflexStateConfig;
}

export interface StateUpdater {
  readonly name: string;
  readonly health?: UpdaterHealth;
  evaluate(context: StateUpdateContext, signal?: AbortSignal): Promise<SemanticDecisions>;
}

export interface UpdaterHealth {
  readonly status: "ok" | "degraded" | "disabled";
  readonly circuit: "closed" | "open" | "half_open";
  readonly reason?: string;
}

export function emptyDecisions(): SemanticDecisions {
  return { resolvedBlockers: [], relevance: [], telemetry: { questionsAsked: 0, questionIds: [] } };
}

export class NoopStateUpdater implements StateUpdater {
  readonly name = "noop";
  evaluate(): Promise<SemanticDecisions> {
    return Promise.resolve(emptyDecisions());
  }
}

export class RecordedDecisionsUpdater implements StateUpdater {
  readonly name = "recorded";
  private readonly records: ReadonlyMap<EventId, StateTransitionRecord>;

  constructor(records: readonly StateTransitionRecord[]) {
    this.records = new Map(records.map((record) => [record.event.id, record]));
    if (this.records.size !== records.length) throw new Error("Duplicate event ID in recording");
  }

  evaluate(context: StateUpdateContext): Promise<SemanticDecisions> {
    const record = this.records.get(context.event.id);
    if (!record) return Promise.reject(new Error("No recorded decisions for " + context.event.id));
    if (!isDeepStrictEqual(record.event, context.event))
      return Promise.reject(new Error("Recorded event differs: " + context.event.id));
    return Promise.resolve(record.decisions);
  }
}
import { isDeepStrictEqual } from "node:util";
