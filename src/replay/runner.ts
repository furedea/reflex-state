import type { ReflexStateConfig } from "../core/config.js";
import { StateEngine } from "../core/engine.js";
import { Metrics } from "../core/metrics.js";
import type { AgentEvent, StateTransitionRecord } from "../core/types.js";
import type { StateUpdater } from "../core/updater.js";

interface ReplayOptions {
  readonly cwd: string;
  readonly config: ReflexStateConfig;
  readonly updater: StateUpdater;
  readonly recording?: readonly StateTransitionRecord[];
}

export async function replay(events: readonly AgentEvent[], options: ReplayOptions) {
  const metrics = new Metrics();
  const engine = new StateEngine({
    ...options,
    onTransition: (record) => metrics.transition(record),
  });
  const recording = new Map(options.recording?.map((record) => [record.event.id, record]));
  const transitions: StateTransitionRecord[] = [];
  for (const event of events) {
    const record = recording.get(event.id);
    if (record) {
      if (record.after.version !== 2) throw new Error("Unsupported legacy recorded replay");
      await engine.configure(record.config, options.updater, record.cwd);
    }
    transitions.push(await engine.process(event));
  }
  return { state: engine.state, transitions, metrics: metrics.snapshot() };
}
