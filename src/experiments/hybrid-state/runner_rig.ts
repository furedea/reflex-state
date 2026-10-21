import { defaultConfig } from "../../core/config.js";
import { StateEngine } from "../../core/engine.js";
import { NoopStateUpdater } from "../../core/updater.js";
import { PiEventNormalizer } from "../../pi/normalization.js";
import { TaskEnvironment } from "./task_environment.js";
import type { HybridTask, TaskScoring, TraceMessage } from "./types.js";

export type EnvironmentFactory = (
  task: HybridTask,
  scoring: TaskScoring | undefined,
  isolated: boolean,
) => TaskEnvironment;

export interface TrialRig {
  readonly env: TaskEnvironment;
  readonly normalizer: PiEventNormalizer;
  readonly engine: StateEngine;
  readonly history: TraceMessage[];
}

/** Fresh workspace, normalizer, engine, and history seeded with the task prompt. */
export async function openRig(
  subject: { readonly task: HybridTask; readonly scoring?: TaskScoring },
  isolated: boolean,
  environmentFor?: EnvironmentFactory,
): Promise<TrialRig> {
  const { task, scoring } = subject;
  const env = environmentFor
    ? environmentFor(task, scoring, isolated)
    : new TaskEnvironment(task, scoring, { isolated });
  const normalizer = new PiEventNormalizer({
    eventCount: 0,
    turnIndex: 0,
    config: defaultConfig(),
    cwd: "/experiment",
  });
  const engine = new StateEngine({
    cwd: "/experiment",
    config: defaultConfig(),
    updater: new NoopStateUpdater(),
  });
  const initialPrompt = normalizer.prompt(task.instruction);
  await engine.process(initialPrompt);
  const history: TraceMessage[] = [
    {
      id: initialPrompt.id,
      role: "user",
      text: task.instruction,
      sequence: 0,
      sourceId: initialPrompt.id,
      truncated: false,
    },
  ];
  return { env, normalizer, engine, history };
}
