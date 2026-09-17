import type { AgentEndEvent as PiAgentEndEvent } from "@earendil-works/pi-coding-agent";

import type { ReflexStateConfig } from "../core/config.js";
import { textContent } from "../core/events.js";
import { isRecord } from "../core/serialization.js";
import type { AgentEvent } from "../core/types.js";
import { PiEventNormalizer } from "./normalization.js";
import { reconstruct } from "./persistence.js";

export function exportSession(
  entries: readonly Record<string, unknown>[],
  options: { leaf?: string; config: ReflexStateConfig },
) {
  const branch = selectBranch(entries, options.leaf);
  const stored = branch.map((entry) => ({
    type: String(entry.type),
    ...(typeof entry.customType === "string" ? { customType: entry.customType } : {}),
    data: entry.data,
  }));
  const restored = reconstruct(stored);
  const hasRecords = stored.some(
    (entry) =>
      entry.customType === "reflex-state.transition" || entry.customType === "reflex-state.reset",
  );
  const header = entries.find((entry) => entry.type === "session");
  return {
    events: hasRecords
      ? restored.transitions.map((record) => record.event)
      : deriveEvents(branch, options.config),
    transitions: restored.transitions,
    cwd: typeof header?.cwd === "string" ? header.cwd : ".",
    config: restored.transitions[0]?.config ?? options.config,
    leaf: branch.at(-1)?.id ?? null,
  };
}

function selectBranch(
  entries: readonly Record<string, unknown>[],
  leaf?: string,
): Record<string, unknown>[] {
  const indexed = entries.filter(
    (entry) => typeof entry.id === "string" && entry.type !== "session",
  );
  const byId = new Map(indexed.map((entry) => [entry.id as string, entry]));
  if (byId.size !== indexed.length) throw new Error("Duplicate Pi session entry ID");
  let id: unknown = leaf ?? indexed.at(-1)?.id;
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (typeof id === "string") {
    const entry = byId.get(id);
    if (!entry || seen.has(id)) throw new Error("Missing or cyclic Pi branch entry");
    seen.add(id);
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

function deriveEvents(
  branch: readonly Record<string, unknown>[],
  config: ReflexStateConfig,
): AgentEvent[] {
  let timestamp = 0;
  const normalizer = new PiEventNormalizer({
    eventCount: 0,
    turnIndex: 0,
    config,
    now: () => timestamp,
  });
  const events: AgentEvent[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    timestamp =
      typeof message.timestamp === "number"
        ? message.timestamp
        : Date.parse(String(entry.timestamp));
    if (!Number.isFinite(timestamp)) throw new Error("Invalid Pi message timestamp");
    if (message.role === "user")
      events.push(normalizer.prompt(textContent(message.content), timestamp));
    if (message.role === "toolResult")
      events.push(
        normalizer.result({
          type: "tool_result",
          toolCallId: string(message.toolCallId),
          toolName: string(message.toolName),
          input: {},
          content: [{ type: "text", text: textContent(message.content) }],
          isError: message.isError === true,
          details: undefined,
        }),
      );
    if (message.role === "assistant") events.push(...assistantEvents(message, normalizer));
  }
  return events;
}

function assistantEvents(
  message: Record<string, unknown>,
  normalizer: PiEventNormalizer,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (!Array.isArray(message.content)) throw new Error("Invalid assistant content");
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    if (!isRecord(block.arguments)) throw new Error("Invalid tool arguments");
    events.push(
      normalizer.call({
        type: "tool_call",
        toolCallId: string(block.id),
        toolName: string(block.name),
        input: block.arguments,
      }),
    );
  }
  if (["stop", "length", "error", "aborted"].includes(String(message.stopReason))) {
    events.push(normalizer.end([message as unknown as PiAgentEndEvent["messages"][number]]));
  }
  return events;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Pi tool reference");
  return value;
}
