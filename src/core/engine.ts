import type { ReflexStateConfig } from "./config.js";
import { extractFacts } from "./extraction.js";
import { initialState, reduce } from "./reducer.js";
import type { AgentEvent, EventId, HotState, StateTransitionRecord } from "./types.js";
import type { StateUpdater } from "./updater.js";

interface EngineOptions {
  readonly cwd: string;
  readonly config: ReflexStateConfig;
  readonly updater: StateUpdater;
  readonly state?: HotState;
  readonly events?: ReadonlyMap<EventId, AgentEvent>;
  readonly onTransition?: (record: StateTransitionRecord) => void | Promise<void>;
}

export class StateEngine {
  private currentState: HotState;
  private readonly eventStore: Map<EventId, AgentEvent>;
  private pending: Promise<unknown> = Promise.resolve();
  private config: ReflexStateConfig;
  private updater: StateUpdater;
  private cwd: string;

  constructor(private readonly options: EngineOptions) {
    this.currentState = options.state ?? initialState();
    this.eventStore = new Map(options.events);
    this.config = options.config;
    this.updater = options.updater;
    this.cwd = options.cwd;
  }

  get state(): HotState {
    return this.currentState;
  }
  get events(): ReadonlyMap<EventId, AgentEvent> {
    return new Map(this.eventStore);
  }

  process(event: AgentEvent, signal?: AbortSignal): Promise<StateTransitionRecord> {
    const result = this.pending.then(() => this.transition(event, signal));
    this.pending = result.catch(() => undefined);
    return result;
  }

  async idle(): Promise<void> {
    await this.pending;
  }

  configure(config: ReflexStateConfig, updater: StateUpdater, cwd = this.cwd): Promise<void> {
    const result = this.pending.then(() => {
      this.config = config;
      this.updater = updater;
      this.cwd = cwd;
    });
    this.pending = result;
    return result;
  }

  private async transition(
    event: AgentEvent,
    signal?: AbortSignal,
  ): Promise<StateTransitionRecord> {
    if (this.eventStore.has(event.id)) throw new Error("Duplicate event ID: " + event.id);
    const context = {
      state: this.currentState,
      event,
      evidence: this.eventStore,
      config: this.config,
      cwd: this.cwd,
    };
    const facts = extractFacts(context);
    const decisions = await this.updater.evaluate({ ...context, facts }, signal);
    const result = reduce({ ...context, facts, decisions, now: event.timestamp });
    const record: StateTransitionRecord = {
      id: "T" + event.id.slice(1),
      timestamp: event.timestamp,
      event,
      after: result.state,
      deterministicPhase: facts.phaseProposal ?? this.currentState.phase,
      changes: result.changes,
      decisions,
      updater: this.updater.name,
      config: this.config,
      cwd: this.cwd,
    };
    await this.options.onTransition?.(record);
    this.eventStore.set(event.id, event);
    this.currentState = result.state;
    return record;
  }
}
