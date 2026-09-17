import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ReflexStateConfig } from "../core/config.js";
import { StateEngine } from "../core/engine.js";
import { Metrics } from "../core/metrics.js";
import type { AgentEvent, HotState } from "../core/types.js";
import type { StateUpdater } from "../core/updater.js";
import { PiEventNormalizer } from "./normalization.js";
import { highestEventOrdinal, reconstruct } from "./persistence.js";

export type UpdaterFactory = (
  config: ReflexStateConfig,
  notify: (message: string) => void,
) => StateUpdater;

export class SessionRuntime {
  engine: StateEngine;
  normalizer: PiEventNormalizer;
  metrics = new Metrics();
  compacting = false;
  projectionSafe = true;
  expectedPrompt: string | undefined;
  private currentConfig: ReflexStateConfig;
  private updater: StateUpdater;
  private historyRecords: ReturnType<typeof reconstruct>["transitions"];

  constructor(
    private readonly options: {
      pi: ExtensionAPI;
      ctx: ExtensionContext;
      config: ReflexStateConfig;
      createUpdater: UpdaterFactory;
    },
  ) {
    this.currentConfig = options.config;
    this.updater = options.createUpdater(options.config, (message) =>
      options.ctx.ui.notify(message, "warning"),
    );
    const restored = this.restore();
    this.engine = restored.engine;
    this.normalizer = restored.normalizer;
    this.historyRecords = restored.transitions;
  }

  get config(): ReflexStateConfig {
    return this.currentConfig;
  }
  get state(): HotState {
    return this.engine.state;
  }
  get history() {
    return this.historyRecords.slice();
  }
  get health() {
    return (
      this.updater.health ?? { status: "disabled", circuit: "closed", reason: "configuration" }
    );
  }

  async record(event: AgentEvent, ctx: ExtensionContext): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.engine.process(event, ctx.signal);
    } catch (error) {
      this.projectionSafe = false;
      throw error;
    }
    this.widget(ctx);
  }

  async toggle(target: "projection" | "jev", enabled: boolean): Promise<void> {
    const config = { ...this.config, [target]: { ...this.config[target], enabled } };
    const updater =
      target === "jev"
        ? this.options.createUpdater(config, (message) =>
            this.options.ctx.ui.notify(message, "warning"),
          )
        : this.updater;
    await this.engine.configure(config, updater);
    this.currentConfig = config;
    this.updater = updater;
  }

  async reset(): Promise<void> {
    await this.engine.idle();
    this.options.pi.appendEntry("reflex-state.reset", { reason: "user" });
    this.metrics = new Metrics();
    const restored = this.restore();
    this.engine = restored.engine;
    this.normalizer = restored.normalizer;
    this.historyRecords = restored.transitions;
    this.projectionSafe = true;
  }

  widget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const last = this.historyRecords.findLast(
      (record) => record.decisions.telemetry.questionsAsked > 0,
    )?.decisions.telemetry;
    const projection = this.metrics.lastProjection;
    const latency = last?.latencyMs === undefined ? "" : " " + Math.round(last.latencyMs) + "ms";
    const counts = projection
      ? " | ctx " + projection.messagesBefore + "→" + projection.messagesAfter + " msgs"
      : "";
    ctx.ui.setWidget("reflex-state", [
      "ReflexState " +
        (this.config.enabled ? this.state.phase : "disabled") +
        " | tests " +
        this.state.verification.test.status +
        " | blockers " +
        this.state.activeBlockers.length +
        " | Jev " +
        this.health.status +
        latency +
        counts,
    ]);
  }

  private restore() {
    const { pi, ctx } = this.options;
    const restored = reconstruct(ctx.sessionManager.getBranch());
    for (const record of restored.transitions) this.metrics.transition(record);
    let hasMeta = restored.hasMeta;
    const engine = new StateEngine({
      cwd: ctx.cwd,
      config: this.config,
      updater: this.updater,
      state: restored.state,
      events: restored.events,
      onTransition: (record) => {
        if (!hasMeta) {
          pi.appendEntry("reflex-state.meta", {
            specVersion: "0.1",
            stateVersion: 1,
            config: this.config,
            piVersion: "0.83.0",
          });
          hasMeta = true;
        }
        pi.appendEntry("reflex-state.transition", record);
        restored.transitions.push(record);
        this.metrics.transition(record);
      },
    });
    const normalizer = new PiEventNormalizer({
      config: this.config,
      eventCount: highestEventOrdinal(ctx.sessionManager.getEntries()),
      turnIndex: restored.state.cursor.turnIndex,
    });
    return { engine, normalizer, transitions: restored.transitions };
  }
}
