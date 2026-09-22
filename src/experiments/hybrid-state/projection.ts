import { Buffer } from "node:buffer";

import type {
  ActionBudgetView,
  ExperimentMode,
  FactsView,
  HybridBudgets,
  InputBundle,
  MemoryItem,
  TraceMessage,
  UpdateFeedback,
  WorkMemory,
} from "./types.js";

export interface ProjectionInput {
  readonly mode: ExperimentMode;
  readonly instruction: string;
  readonly facts: FactsView;
  readonly memory: WorkMemory;
  readonly latest: readonly TraceMessage[];
  readonly history: readonly TraceMessage[];
  /** Shared action-budget view sent identically to both modes. */
  readonly actionBudget: ActionBudgetView;
  /** llm mode only: the previous step's patch outcome; null is explicit at
   * step 0 and never accumulates older results. */
  readonly lastUpdateResult?: UpdateFeedback | null;
  readonly fixedTools?: readonly string[];
  readonly allowedTests?: readonly string[];
  readonly budgets: HybridBudgets;
}

export interface ProjectedInput {
  readonly bundle: InputBundle;
  readonly userText: string;
}

export function buildProjection(input: ProjectionInput): ProjectedInput {
  const fixedTools = input.fixedTools ?? ["read", "write", "edit", "test", "finish"];
  const allowedTests = input.allowedTests ?? [];
  const feedback = feedbackBytes(input);
  if (input.mode === "history") {
    const history = renderMessages(input.history);
    const userText = sentText({
      instruction: input.instruction,
      tools: fixedTools,
      tests: allowedTests,
      history,
      action_budget: input.actionBudget,
    });
    const bytes = {
      ...sizes("", "", "", history, feedback),
      total: byteLength(userText),
    };
    return {
      bundle: {
        mode: input.mode,
        instruction: input.instruction,
        fixedTools,
        facts: "",
        memory: "",
        latest: "",
        history,
        bytes,
        truncated: [],
      },
      userText,
    };
  }
  const facts = JSON.stringify(input.facts);
  if (byteLength(facts) > input.budgets.factsBytes)
    return unavailable(input, "facts_metadata_exceeds_budget", fixedTools, allowedTests, facts);
  const memoryResult = boundedMemory(input.memory, input.budgets.memoryBytes);
  if (memoryResult.unavailable)
    return unavailable(
      input,
      memoryResult.unavailable,
      fixedTools,
      allowedTests,
      facts,
      memoryResult.text,
    );
  const latestText = renderObservationGroup(input.latest);
  if (byteLength(latestText) > input.budgets.latestObservationBytes)
    return unavailable(
      input,
      "latest_observation_exceeds_budget",
      fixedTools,
      allowedTests,
      facts,
      memoryResult.text,
      latestText,
    );
  const userText = sentText({
    instruction: input.instruction,
    tools: fixedTools,
    tests: allowedTests,
    facts: JSON.parse(facts) as unknown,
    memory: JSON.parse(memoryResult.text) as unknown,
    latest_observation: JSON.parse(latestText) as unknown,
    action_budget: input.actionBudget,
    last_update_result: input.lastUpdateResult
      ? serializeUpdateFeedback(input.lastUpdateResult)
      : null,
  });
  const truncated = memoryResult.truncated;
  if (byteLength(userText) > input.budgets.requestBytes)
    return unavailable(
      input,
      "state_first_request_exceeds_budget",
      fixedTools,
      allowedTests,
      facts,
      memoryResult.text,
      latestText,
      truncated,
    );
  return {
    bundle: {
      mode: input.mode,
      instruction: input.instruction,
      fixedTools,
      facts,
      memory: memoryResult.text,
      latest: latestText,
      bytes: {
        ...sizes(facts, memoryResult.text, latestText, "", feedback),
        total: byteLength(userText),
      },
      truncated,
    },
    userText,
  };
}

export function sentText(sections: Record<string, unknown>): string {
  return JSON.stringify(sections);
}

/** Wire shape of the previous step's patch outcome. Snake_case matches the
 * rest of the actor input contract; internal records keep the full detail. */
export function serializeUpdateFeedback(feedback: UpdateFeedback): Record<string, unknown> {
  return {
    patch_input: feedback.patchInput,
    applied: feedback.applied.map((entry) => ({
      index: entry.index,
      memory_id: entry.memoryId,
    })),
    unchanged: [...feedback.unchanged],
    rejected: feedback.rejected.map((entry) => ({
      index: entry.index,
      reason: entry.reason,
    })),
    applied_count: feedback.appliedCount,
    unchanged_count: feedback.unchangedCount,
    rejected_count: feedback.rejectedCount,
    omitted_detail_count: feedback.omittedDetailCount,
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

export function renderObservationGroup(messages: readonly TraceMessage[]): string {
  return JSON.stringify({
    items: messages.map((message) => ({
      id: message.id,
      role: message.role,
      sourceId: message.sourceId,
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError !== undefined ? { isError: message.isError } : {}),
      text: message.text,
    })),
    count: messages.length,
  });
}

export function stateFirstHistoryLength(input: ProjectionInput): number {
  return byteLength(renderMessages(input.history.length ? input.history : []));
}

/** The exact memory representation sent inside the actor input. Shared by
 * projection and patch validation so budgets measure the same bytes. */
export function renderMemoryProjection(memory: WorkMemory): string {
  const all = Object.values(memory).flat();
  return renderMemoryItems(all, all.length, null);
}

function renderMemoryItems(
  shown: readonly MemoryItem[],
  total: number,
  omittedIds: readonly string[] | null,
): string {
  return JSON.stringify({
    items: shown.map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      sources: item.sourceIds,
      origin: item.origin,
      trust: item.trust,
    })),
    shown_count: shown.length,
    omitted_count: omittedIds ? omittedIds.length : total - shown.length,
    ...(omittedIds ? { omitted_ids: omittedIds } : {}),
  });
}

function boundedMemory(
  memory: WorkMemory,
  budget: number,
): { readonly text: string; readonly truncated: string[]; readonly unavailable?: string } {
  const all = Object.values(memory).flat();
  const required = all.filter((item) => item.kind === "constraints" && item.trust === "user");
  const optional = all.filter((item) => !(item.kind === "constraints" && item.trust === "user"));
  const render = (shown: readonly MemoryItem[], omittedIds: readonly string[] | null) =>
    renderMemoryItems(shown, all.length, omittedIds);
  if (byteLength(render(required, [])) > budget)
    return {
      text: render(required, []),
      truncated: [],
      unavailable: "protected_memory_exceeds_budget",
    };
  const shown: MemoryItem[] = [...required];
  const omitted: string[] = [];
  for (const item of optional) {
    const candidate = render([...shown, item], omitted);
    if (byteLength(candidate) > budget) omitted.push(item.id);
    else shown.push(item);
  }
  let text = render(shown, omitted);
  if (byteLength(text) > budget) text = render(shown, null);
  if (byteLength(text) > budget)
    return { text, truncated: ["memory"], unavailable: "memory_metadata_exceeds_budget" };
  return { text, truncated: omitted.length ? ["memory"] : [] };
}

function unavailable(
  input: ProjectionInput,
  reason: string,
  fixedTools: readonly string[],
  allowedTests: readonly string[],
  facts = "",
  memory = "",
  latest = "",
  truncated: readonly string[] = [],
): ProjectedInput {
  const userText = sentText({
    instruction: input.instruction,
    tools: fixedTools,
    tests: allowedTests,
    unavailable: reason,
    facts: facts ? (JSON.parse(facts) as unknown) : undefined,
    action_budget: input.actionBudget,
    ...(input.mode !== "history"
      ? {
          last_update_result: input.lastUpdateResult
            ? serializeUpdateFeedback(input.lastUpdateResult)
            : null,
        }
      : {}),
  });
  const bytes = sizes(facts, memory, latest, "", feedbackBytes(input));
  return {
    bundle: {
      mode: input.mode,
      instruction: input.instruction,
      fixedTools,
      facts,
      memory,
      latest,
      bytes: { ...bytes, total: byteLength(userText) },
      truncated,
      unavailable: reason,
    },
    userText,
  };
}

/** Serialized size of the shared protocol fields (action_budget and, in llm
 * mode, last_update_result) so their cost is visible in per-field bytes. */
function feedbackBytes(input: ProjectionInput): number {
  return byteLength(
    JSON.stringify({
      action_budget: input.actionBudget,
      last_update_result:
        input.mode === "history"
          ? null
          : input.lastUpdateResult
            ? serializeUpdateFeedback(input.lastUpdateResult)
            : null,
    }),
  );
}

function sizes(
  facts: string,
  memory: string,
  latest: string,
  history: string,
  feedback: number,
): InputBundle["bytes"] {
  return {
    total: 0,
    facts: byteLength(facts),
    memory: byteLength(memory),
    latest: byteLength(latest),
    history: byteLength(history),
    feedback,
  };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
