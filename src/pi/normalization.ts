import type {
  AgentEndEvent as PiAgentEndEvent,
  ToolCallEvent as PiToolCallEvent,
  ToolResultEvent as PiToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import type { ReflexStateConfig } from "../core/config.js";
import { boundedInput, boundedText, createExcerpt, eventId, textContent } from "../core/events.js";
import type {
  AgentEndEvent,
  SourceRef,
  ToolCallEvent,
  ToolResultEvent,
  UserPromptEvent,
} from "../core/types.js";

interface NormalizerOptions {
  readonly eventCount: number;
  readonly turnIndex: number;
  readonly config: ReflexStateConfig;
  readonly now?: () => number;
  readonly cwd?: string;
}

export class PiEventNormalizer {
  private ordinal: number;
  private turnIndex: number;

  constructor(private readonly options: NormalizerOptions) {
    this.ordinal = options.eventCount;
    this.turnIndex = options.turnIndex;
  }

  prompt(text: string, timestamp = this.now()): UserPromptEvent {
    this.turnIndex++;
    return {
      ...this.base({ kind: "user_prompt", timestamp }),
      type: "user_prompt",
      text: boundedText(text, this.options.config.limits.maxPromptChars),
    };
  }

  call(event: PiToolCallEvent): ToolCallEvent {
    const maxChars =
      this.options.config.limits.maxExcerptHeadChars +
      this.options.config.limits.maxExcerptTailChars;
    const input = event.input as Readonly<Record<string, unknown>>;
    const command = typeof input.command === "string" ? input.command : undefined;
    return {
      ...this.base({ kind: "tool_call", toolCallId: event.toolCallId, timestamp: this.now() }),
      type: "tool_call",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: boundedInput(event.input, maxChars),
      ...(command !== undefined && command.length > maxChars ? { commandTruncated: true } : {}),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    };
  }

  result(event: PiToolResultEvent): ToolResultEvent {
    return {
      ...this.base({ kind: "tool_call", toolCallId: event.toolCallId, timestamp: this.now() }),
      type: "tool_result",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      excerpt: createExcerpt(textContent(event.content), this.options.config.limits),
    };
  }

  end(messages: PiAgentEndEvent["messages"]): AgentEndEvent {
    const last = messages.findLast((message) => message.role === "assistant");
    const stopReason = last?.role === "assistant" ? last.stopReason : "aborted";
    return {
      ...this.base({ kind: "assistant_message", timestamp: last?.timestamp ?? this.now() }),
      type: "agent_end",
      finalText: createExcerpt(
        last?.role === "assistant" ? textContent(last.content) : "",
        this.options.config.limits,
      ),
      stopReason: stopReason === "toolUse" || stopReason === "pending" ? "aborted" : stopReason,
    };
  }

  resume(reason: "resume" | "branch_switch" = "resume") {
    return {
      ...this.base({ kind: "assistant_message", timestamp: this.now() }),
      type: "session_resume" as const,
      reason,
    };
  }

  private base(source: SourceRef) {
    return {
      id: eventId(++this.ordinal),
      timestamp: new Date(source.timestamp).toISOString(),
      turnIndex: this.turnIndex,
      source,
    };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
