import { defaultConfig } from "../../core/config.js";
import { StateEngine } from "../../core/engine.js";
import { NoopStateUpdater } from "../../core/updater.js";
import { PiEventNormalizer } from "../../pi/normalization.js";
import { actionInput } from "./runner_exchange.js";
import type { TaskEnvironment } from "./task_environment.js";
import type { ActorAction, TraceMessage } from "./types.js";

export type Execution = Awaited<ReturnType<TaskEnvironment["execute"]>>;

/** A trial's workspace together with the normalizer, engine, and history that
 * mirror it, seeded with the task prompt. */
export class TrialRig {
  readonly normalizer = new PiEventNormalizer({
    eventCount: 0,
    turnIndex: 0,
    config: defaultConfig(),
    cwd: "/experiment",
  });
  readonly engine = new StateEngine({
    cwd: "/experiment",
    config: defaultConfig(),
    updater: new NoopStateUpdater(),
  });
  readonly history: TraceMessage[] = [];

  private constructor(readonly env: TaskEnvironment) {}

  static async open(env: TaskEnvironment, instruction: string): Promise<TrialRig> {
    const rig = new TrialRig(env);
    const initialPrompt = rig.normalizer.prompt(instruction);
    await rig.engine.process(initialPrompt);
    rig.history.push({
      id: initialPrompt.id,
      role: "user",
      text: instruction,
      sequence: 0,
      sourceId: initialPrompt.id,
      truncated: false,
    });
    return rig;
  }

  /** Feeds the executed tool call and its result through the state engine and
   * appends both to the trial history. */
  async recordToolExchange(
    action: ActorAction,
    evidenceId: string,
    execution: Execution,
  ): Promise<void> {
    const { normalizer, engine, history } = this;
    const callEvent = normalizer.call({
      type: "tool_call",
      toolCallId: evidenceId,
      toolName: action.tool,
      input: actionInput(action),
    });
    const resultEvent = normalizer.result({
      type: "tool_result",
      toolCallId: callEvent.toolCallId,
      toolName: action.tool,
      input: actionInput(action),
      content: [{ type: "text", text: execution.text }],
      isError: !execution.passed,
      details: undefined,
    });
    await engine.process(callEvent);
    await engine.process(resultEvent);
    history.push({
      id: callEvent.id,
      role: "tool_call",
      text: JSON.stringify(actionInput(action)),
      sequence: history.length,
      sourceId: callEvent.id,
      toolName: action.tool,
      toolCallId: callEvent.toolCallId,
      truncated: false,
    });
    history.push({
      id: resultEvent.id,
      role: "tool_result",
      text: execution.text,
      sequence: history.length,
      sourceId: resultEvent.id,
      toolName: action.tool,
      toolCallId: callEvent.toolCallId,
      isError: !execution.passed,
      truncated: false,
    });
  }
}
