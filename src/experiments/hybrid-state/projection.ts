import { Buffer } from "node:buffer";

import type {
  ExperimentMode,
  FactsView,
  HybridBudgets,
  InputBundle,
  MemoryItem,
  TraceMessage,
  WorkMemory,
} from "./types.js";

export interface ProjectionInput {
  readonly mode: ExperimentMode;
  readonly instruction: string;
  readonly facts: FactsView;
  readonly memory: WorkMemory;
  readonly latest: readonly TraceMessage[];
  readonly history: readonly TraceMessage[];
  readonly fixedTools?: readonly string[];
  readonly budgets: HybridBudgets;
}

export function buildProjection(input: ProjectionInput): InputBundle {
  const fixedTools = input.fixedTools ?? ["read", "write", "edit", "test", "finish"];
  if (input.mode === "history") {
    const history = renderMessages(input.history);
    const bytes = {
      ...sizes("", "", "", history),
      total: byteLength(JSON.stringify({ instruction: input.instruction, fixedTools, history })),
    };
    return {
      mode: input.mode,
      instruction: input.instruction,
      fixedTools,
      facts: "",
      memory: "",
      latest: "",
      history,
      bytes,
      truncated: [],
    };
  }
  const facts = JSON.stringify(input.facts);
  if (byteLength(facts) > input.budgets.factsBytes)
    return unavailable(input, "facts_metadata_exceeds_budget", facts);
  const memoryResult = boundedMemory(input.memory, input.budgets.memoryBytes);
  const latestResult = boundedMessages(input.latest, input.budgets.latestObservationBytes);
  const bytes = sizes(facts, memoryResult.text, latestResult.text, "");
  const total = byteLength(
    JSON.stringify({
      instruction: input.instruction,
      fixedTools,
      facts,
      memory: memoryResult.text,
      latest: latestResult.text,
    }),
  );
  const truncated = [...memoryResult.truncated, ...latestResult.truncated];
  if (total > input.budgets.requestBytes)
    return unavailable(
      input,
      "state_first_request_exceeds_budget",
      facts,
      memoryResult.text,
      latestResult.text,
      truncated,
    );
  return {
    mode: input.mode,
    instruction: input.instruction,
    fixedTools,
    facts,
    memory: memoryResult.text,
    latest: latestResult.text,
    bytes: { ...bytes, total },
    truncated,
  };
}

export function renderMessages(messages: readonly TraceMessage[]): string {
  return messages
    .map((message) => {
      const metadata = [message.id, message.role, message.toolName, message.toolCallId]
        .filter(Boolean)
        .join(" ");
      return `[${metadata}] ${message.text}`;
    })
    .join("\n");
}

export function stateFirstHistoryLength(input: ProjectionInput): number {
  return byteLength(buildProjection({ ...input, mode: "history" }).history ?? "");
}

function boundedMemory(
  memory: WorkMemory,
  budget: number,
): { readonly text: string; readonly truncated: string[] } {
  const all = Object.values(memory).flat();
  const shown: MemoryItem[] = [];
  const omitted: string[] = [];
  for (const item of all) {
    const candidate = JSON.stringify({ items: [...shown, item], omitted });
    if (byteLength(candidate) > budget) omitted.push(item.id);
    else shown.push(item);
  }
  const text = JSON.stringify({
    items: shown,
    shown_count: shown.length,
    omitted_count: omitted.length,
    omitted,
  });
  return { text, truncated: omitted.length ? ["memory"] : [] };
}

function boundedMessages(
  messages: readonly TraceMessage[],
  budget: number,
): { readonly text: string; readonly truncated: string[] } {
  const result: TraceMessage[] = [];
  let omitted = 0;
  for (const message of messages) {
    const candidate = renderMessages([...result, message]);
    if (byteLength(candidate) > budget) omitted++;
    else result.push(message);
  }
  return {
    text: JSON.stringify({ items: result, shown_count: result.length, omitted_count: omitted }),
    truncated: omitted ? ["latest_observation"] : [],
  };
}

function unavailable(
  input: ProjectionInput,
  reason: string,
  facts = "",
  memory = "",
  latest = "",
  truncated: readonly string[] = [],
): InputBundle {
  const bytes = sizes(facts, memory, latest, "");
  return {
    mode: input.mode,
    instruction: input.instruction,
    fixedTools: input.fixedTools ?? ["read", "write", "edit", "test", "finish"],
    facts,
    memory,
    latest,
    bytes,
    truncated,
    unavailable: reason,
  };
}

function sizes(
  facts: string,
  memory: string,
  latest: string,
  history: string,
): InputBundle["bytes"] {
  return {
    total: byteLength(JSON.stringify({ facts, memory, latest, history })),
    facts: byteLength(facts),
    memory: byteLength(memory),
    latest: byteLength(latest),
    history: byteLength(history),
  };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
