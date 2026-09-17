import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { decisionEntries } from "../core/metrics.js";
import type { SessionRuntime } from "./runtime.js";

const suggestions = [
  "history",
  "stats",
  "debug",
  "reset",
  "projection on",
  "projection off",
  "jev on",
  "jev off",
];

export function registerCommands(
  pi: ExtensionAPI,
  runtime: () => SessionRuntime | undefined,
): void {
  pi.registerCommand("state", {
    description: "Inspect ReflexState, its evidence, and updater health",
    getArgumentCompletions: (prefix) =>
      suggestions
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const session = runtime();
      if (!session) {
        ctx.ui.notify("ReflexState is unavailable for this session.", "warning");
        return;
      }
      await session.engine.idle();
      await handleCommand(args.trim(), session, ctx);
      session.widget(ctx);
    },
  });
}

async function handleCommand(
  args: string,
  session: SessionRuntime,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!args) {
    ctx.ui.notify(renderState(session), "info");
    return;
  }
  if (args === "stats") {
    ctx.ui.notify(
      JSON.stringify(
        {
          ...session.metrics.snapshot(),
          health: session.health,
          workingSet: {
            count: session.state.workingSet.length,
            cap: session.config.limits.maxWorkingSetEvents,
          },
          blockers: {
            count: session.state.activeBlockers.length,
            cap: session.config.limits.maxActiveBlockers,
          },
        },
        missingMetric,
        2,
      ),
      "info",
    );
    return;
  }
  if (args === "debug") {
    ctx.ui.notify(
      JSON.stringify(
        session.history.findLast((record) => record.decisions.telemetry.questionsAsked > 0)
          ?.decisions ?? { message: "No semantic decisions yet" },
        null,
        2,
      ),
      "info",
    );
    return;
  }
  const history = /^history(?:\s+(\d+))?$/.exec(args);
  if (history) {
    const count = Math.min(1000, Math.max(1, Number(history[1] ?? 10)));
    ctx.ui.notify(
      session.history
        .slice(-count)
        .map(
          (record) =>
            record.id +
            " " +
            record.event.id +
            " " +
            record.event.type +
            "\n" +
            record.changes.join("\n") +
            "\n" +
            decisionEntries(record.decisions)
              .map(
                ([id, decision]) =>
                  id + ": " + decision.gate + (decision.shadow ? " (shadow)" : ""),
              )
              .join(", "),
        )
        .join("\n\n") || "No transitions yet",
      "info",
    );
    return;
  }
  if (args === "reset") {
    await ctx.waitForIdle();
    if (
      await ctx.ui.confirm(
        "Reset ReflexState?",
        "The current hot state will be cleared. The original session history remains available.",
      )
    )
      await session.reset();
    return;
  }
  const toggle = /^(projection|jev)\s+(on|off)$/.exec(args);
  if (toggle) {
    await session.toggle(toggle[1] as "projection" | "jev", toggle[2] === "on");
    ctx.ui.notify("ReflexState " + args, "info");
    return;
  }
  ctx.ui.notify(
    "Usage: /state [history [n] | stats | debug | reset | projection on|off | jev on|off]",
    "warning",
  );
}

function renderState(session: SessionRuntime): string {
  const state = session.state;
  return [
    "goal: " + (state.goal ?? "none"),
    "phase: " + state.phase,
    "task_status: " + state.taskStatus,
    "modified_files: " + JSON.stringify(state.modifiedFiles),
    "relevant_files: " + JSON.stringify(state.relevantFiles),
    "verification: " + JSON.stringify(state.verification),
    "active_blockers: " + JSON.stringify(state.activeBlockers),
    "working_set: " + JSON.stringify(state.workingSet),
  ].join("\n");
}

function missingMetric(_key: string, value: unknown): unknown {
  return value === undefined ? "n/a" : value;
}
