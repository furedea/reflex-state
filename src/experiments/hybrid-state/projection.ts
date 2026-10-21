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
  const builder = new ProjectionBuilder(input);
  return input.mode === "history" ? builder.projectHistory() : builder.projectStateFirst();
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

/** Renders one actor input. The sections rendered so far are what an
 * unavailable projection still reports. */
class ProjectionBuilder {
  private readonly fixedTools: readonly string[];
  private readonly allowedTests: readonly string[];
  private historyText: string | undefined;
  private facts = "";
  private memory = "";
  private latest = "";
  private truncated: readonly string[] = [];

  constructor(private readonly input: ProjectionInput) {
    this.fixedTools = input.fixedTools ?? ["read", "write", "edit", "test", "finish"];
    this.allowedTests = input.allowedTests ?? [];
  }

  projectHistory(): ProjectedInput {
    const { input } = this;
    this.historyText = renderMessages(input.history);
    const userText = sentText({
      instruction: input.instruction,
      tools: this.fixedTools,
      tests: this.allowedTests,
      history: this.historyText,
      action_budget: input.actionBudget,
    });
    return this.projected(userText);
  }

  projectStateFirst(): ProjectedInput {
    const { input } = this;
    this.facts = JSON.stringify(input.facts);
    if (byteLength(this.facts) > input.budgets.factsBytes)
      return this.unavailable("facts_metadata_exceeds_budget");
    const memoryResult = boundedMemory(input.memory, input.budgets.memoryBytes);
    this.memory = memoryResult.text;
    if (memoryResult.unavailable) return this.unavailable(memoryResult.unavailable);
    this.latest = renderObservationGroup(input.latest);
    if (byteLength(this.latest) > input.budgets.latestObservationBytes)
      return this.unavailable("latest_observation_exceeds_budget");
    const userText = sentText({
      instruction: input.instruction,
      tools: this.fixedTools,
      tests: this.allowedTests,
      facts: JSON.parse(this.facts) as unknown,
      memory: JSON.parse(this.memory) as unknown,
      latest_observation: JSON.parse(this.latest) as unknown,
      action_budget: input.actionBudget,
      last_update_result: input.lastUpdateResult
        ? serializeUpdateFeedback(input.lastUpdateResult)
        : null,
    });
    this.truncated = memoryResult.truncated;
    if (byteLength(userText) > input.budgets.requestBytes)
      return this.unavailable("state_first_request_exceeds_budget");
    return this.projected(userText);
  }

  private unavailable(reason: string): ProjectedInput {
    const { input } = this;
    const userText = sentText({
      instruction: input.instruction,
      tools: this.fixedTools,
      tests: this.allowedTests,
      unavailable: reason,
      facts: this.facts ? (JSON.parse(this.facts) as unknown) : undefined,
      action_budget: input.actionBudget,
      ...(input.mode !== "history"
        ? {
            last_update_result: input.lastUpdateResult
              ? serializeUpdateFeedback(input.lastUpdateResult)
              : null,
          }
        : {}),
    });
    return this.projected(userText, reason);
  }

  private projected(userText: string, unavailableReason?: string): ProjectedInput {
    const { input } = this;
    return {
      bundle: {
        mode: input.mode,
        instruction: input.instruction,
        fixedTools: this.fixedTools,
        facts: this.facts,
        memory: this.memory,
        latest: this.latest,
        ...(this.historyText === undefined ? {} : { history: this.historyText }),
        bytes: this.bytes(userText),
        truncated: this.truncated,
        ...(unavailableReason === undefined ? {} : { unavailable: unavailableReason }),
      },
      userText,
    };
  }

  private bytes(userText: string): InputBundle["bytes"] {
    return {
      total: byteLength(userText),
      facts: byteLength(this.facts),
      memory: byteLength(this.memory),
      latest: byteLength(this.latest),
      history: byteLength(this.historyText ?? ""),
      feedback: feedbackBytes(this.input),
    };
  }
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

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
