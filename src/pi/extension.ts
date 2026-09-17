import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { textContent } from "../core/events.js";
import { registerCommands } from "./commands.js";
import { loadConfig } from "./configuration.js";
import { projectContext } from "./projection.js";
import { SessionRuntime } from "./runtime.js";
import type { UpdaterFactory } from "./runtime.js";

export function registerExtension(pi: ExtensionAPI, createUpdater: UpdaterFactory): void {
  let runtime: SessionRuntime | undefined;
  const start = async (_event: unknown, ctx: ExtensionContext) => {
    await runtime?.engine.idle();
    runtime = undefined;
    await guarded(ctx, async () => {
      const { config, warnings } = await loadConfig({
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
      });
      for (const warning of warnings) ctx.ui.notify(warning, "warning");
      runtime = new SessionRuntime({ pi, ctx, config, createUpdater });
      runtime.widget(ctx);
    });
  };
  pi.on("session_start", start);
  pi.on("session_tree", start);
  pi.on("context", async (event, ctx) => {
    if (!runtime || !runtime.projectionSafe) return { messages: event.messages };
    const session = runtime;
    await session.engine.idle();
    const result = projectContext(event.messages, {
      state: session.state,
      evidence: session.engine.events,
      config: session.config,
      compacting: session.compacting,
    });
    session.metrics.projection(result.measurement);
    session.widget(ctx);
    return { messages: result.messages };
  });
  pi.on("session_shutdown", async () => {
    await runtime?.engine.idle();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!runtime?.config.enabled) return;
    const session = runtime;
    session.compacting = false;
    session.expectedPrompt = event.prompt;
    await guarded(ctx, () => session.record(session.normalizer.prompt(event.prompt), ctx));
  });
  pi.on("tool_call", async (event, ctx) => {
    if (runtime?.config.enabled) {
      const session = runtime;
      await guarded(ctx, () => session.record(session.normalizer.call(event), ctx));
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (runtime?.config.enabled) {
      const session = runtime;
      await guarded(ctx, () => session.record(session.normalizer.result(event), ctx));
    }
  });
  pi.on("agent_end", async (event, ctx) => {
    if (runtime?.config.enabled) {
      const session = runtime;
      await guarded(ctx, () => session.record(session.normalizer.end(event.messages), ctx));
    }
  });
  pi.on("message_end", async ({ message }, ctx) => {
    if (!runtime?.config.enabled) return;
    const session = runtime;
    if (message.role === "assistant") session.metrics.provider(message.usage);
    if (message.role !== "user") return;
    const text = textContent(message.content);
    const duplicate = session.expectedPrompt === text;
    session.expectedPrompt = undefined;
    if (!duplicate)
      await guarded(ctx, () =>
        session.record(session.normalizer.prompt(text, message.timestamp), ctx),
      );
  });
  pi.on("session_before_compact", (event) => {
    if (!runtime) return;
    const session = runtime;
    session.compacting = true;
    event.signal.addEventListener(
      "abort",
      () => {
        session.compacting = false;
      },
      { once: true },
    );
  });
  pi.on("session_compact", () => {
    if (runtime) runtime.compacting = false;
  });
  pi.on("agent_settled", () => {
    if (runtime) runtime.compacting = false;
  });
  registerCommands(pi, () => runtime);
}

async function guarded(ctx: ExtensionContext, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    ctx.ui.notify(
      "ReflexState could not update: " + (error instanceof Error ? error.name : "unknown error"),
      "warning",
    );
  }
}
