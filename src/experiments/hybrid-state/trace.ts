import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { defaultConfig } from "../../core/config.js";
import { isRecord } from "../../core/serialization.js";
import type { AgentEvent } from "../../core/types.js";
import { PiEventNormalizer } from "../../pi/normalization.js";
import type { Candidate, ObservationGroup, TraceData, TraceMessage } from "./types.js";
import type { MemoryKind, SourceTrust } from "./types.js";

export interface TraceReadOptions {
  readonly session?: string;
  readonly leaf?: string;
  readonly synthetic?: boolean;
  readonly candidateMaxBytes?: number;
}

export async function readTrace(options: TraceReadOptions): Promise<TraceData> {
  if (!options.session) throw new Error("audit requires --session or a synthetic fixture");
  const text = await readFile(options.session, "utf8");
  const values = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => parseLine(line, index + 1));
  return parseTraceEntries(values, { ...options, session: options.session });
}

export function parseTraceEntries(
  entries: readonly Record<string, unknown>[],
  options: TraceReadOptions = {},
): TraceData {
  const branch = selectBranch(entries, options.leaf);
  const { messages, missingText } = collectMessages(branch);
  const sourceHash = hash(JSON.stringify(messages));
  const events = deriveEvents(messages);
  return {
    format: traceFormat(branch, options),
    ...(options.session ? { sessionPath: options.session } : {}),
    leaf: options.leaf ?? branch.at(-1)?.id?.toString() ?? null,
    messages,
    events,
    missingText,
    sourceHash,
  };
}

function collectMessages(branch: readonly Record<string, unknown>[]) {
  const messages: TraceMessage[] = [];
  const missingText: string[] = [];
  let sequence = 0;
  for (const entry of branch) {
    const message = isRecord(entry.message) ? entry.message : entry;
    const sourceId = typeof entry.id === "string" ? entry.id : `entry-${sequence + 1}`;
    const parsed = parseMessage(message, sourceId, sequence);
    if (!parsed.length && expectsText(entry, message)) missingText.push(sourceId);
    for (const item of parsed) messages.push({ ...item, sequence: sequence++ });
  }
  return { messages, missingText };
}

function expectsText(entry: Record<string, unknown>, message: Record<string, unknown>): boolean {
  if (entry.type === "agent_end") return true;
  return entry.type === "message" && message.role !== "system";
}

function traceFormat(
  branch: readonly Record<string, unknown>[],
  options: TraceReadOptions,
): TraceData["format"] {
  if (options.synthetic) return "synthetic";
  return branch.some((entry) => entry.type === "message") ? "pi" : "event-only";
}

export function generateCandidates(
  messages: readonly TraceMessage[],
  options: { readonly maxBytes?: number; readonly observedAt?: number } = {},
): Candidate[] {
  const maxBytes = options.maxBytes ?? 4096;
  const candidates: Candidate[] = [];
  for (const message of messages) {
    if (!message.text.trim()) continue;
    const units = splitVisibleUnits(message.text);
    for (const unit of units) {
      const text = message.text.slice(unit.start, unit.end);
      const truncated = Buffer.byteLength(text) > maxBytes;
      const category = classify(message);
      const candidate: Candidate = {
        id: candidateId(message, unit, text),
        category,
        sourceId: message.sourceId,
        sourceIds: [message.sourceId],
        role: message.role,
        trust: trustFor(message),
        text,
        context: message.text,
        start: unit.start,
        end: unit.end,
        sourceHash: hash(message.text),
        observedAt: options.observedAt ?? message.sequence,
        truncated,
        contextComplete: !truncated && !message.truncated,
      };
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * The observation group for the next actor call: every message recorded since
 * `fromIndex`. Tool call/result pairs and injected user instructions are kept
 * together because the runner only advances the index between actor calls.
 */
export function latestGroup(history: readonly TraceMessage[], fromIndex = 0): ObservationGroup {
  return { messages: history.slice(fromIndex) };
}

export function candidateId(
  message: TraceMessage,
  span: { readonly start: number; readonly end: number },
  text: string,
): string {
  const digest = hash(`${message.id}:${span.start}:${span.end}:${text}`).slice(0, 12);
  return `cand-${digest}`;
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseLine(line: string, lineNumber: number): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error(`Invalid trace entry at line ${lineNumber}`);
  return value;
}

function selectBranch(
  entries: readonly Record<string, unknown>[],
  leaf?: string,
): Record<string, unknown>[] {
  const indexed = entries.filter((entry) => typeof entry.id === "string");
  if (!indexed.length) return [...entries];
  if (!indexed.some((entry) => typeof entry.parentId === "string")) return [...indexed];
  const byId = new Map(indexed.map((entry) => [entry.id as string, entry]));
  const selected = leaf ?? String(indexed.at(-1)?.id);
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = selected;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry || seen.has(cursor)) throw new Error("Missing or cyclic trace branch");
    seen.add(cursor);
    branch.push(entry);
    cursor = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  return branch.reverse();
}

type MessageParser = (
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
) => TraceMessage[];

const MESSAGE_PARSERS = new Map<unknown, MessageParser>([
  ["user", parseUser],
  ["toolResult", parseToolResult],
  ["user_prompt", parseUserPrompt],
  ["tool_call", parseToolCall],
  ["tool_result", parseRecordedToolResult],
  ["agent_end", parseAgentEnd],
  ["assistant", parseAssistant],
]);

function parseMessage(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  const role = typeof message.role === "string" ? message.role : message.type;
  const parser = MESSAGE_PARSERS.get(role);
  return parser ? parser(message, sourceId, sequence) : [];
}

function toolFields(
  name: unknown,
  callId: unknown,
): { readonly toolName?: string; readonly toolCallId?: string } {
  return {
    ...(typeof name === "string" ? { toolName: name } : {}),
    ...(typeof callId === "string" ? { toolCallId: callId } : {}),
  };
}

function userMessages(text: string, sourceId: string, sequence: number): TraceMessage[] {
  return text
    ? [{ id: `${sourceId}:text`, role: "user", text, sequence, sourceId, truncated: false }]
    : [];
}

function parseUser(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  return userMessages(visibleText(message.content), sourceId, sequence);
}

function parseUserPrompt(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  const text = typeof message.text === "string" ? message.text : "";
  return userMessages(text, sourceId, sequence);
}

function parseToolResult(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  return [
    {
      id: `${sourceId}:result`,
      role: "tool_result",
      text: visibleText(message.content),
      sequence,
      sourceId,
      ...toolFields(message.toolName, message.toolCallId),
      isError: message.isError === true,
      truncated: false,
    },
  ];
}

function parseToolCall(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  const input = isRecord(message.input) ? message.input : {};
  return [
    {
      id: `${sourceId}:call`,
      role: "tool_call",
      text: JSON.stringify(input),
      sequence,
      sourceId,
      ...toolFields(message.toolName, message.toolCallId),
      truncated: false,
    },
  ];
}

function parseRecordedToolResult(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  const excerpt = isRecord(message.excerpt) ? message.excerpt : undefined;
  const text = typeof excerpt?.head === "string" ? excerpt.head : "";
  return [
    {
      id: `${sourceId}:result`,
      role: "tool_result",
      text,
      sequence,
      sourceId,
      ...toolFields(message.toolName, message.toolCallId),
      isError: message.isError === true,
      truncated: excerpt?.truncated === true,
    },
  ];
}

function parseAgentEnd(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  const finalText = isRecord(message.finalText) ? message.finalText : undefined;
  const head = finalText?.head;
  if (typeof head !== "string" || !head) return [];
  return [
    {
      id: `${sourceId}:text`,
      role: "assistant",
      text: head,
      sequence,
      sourceId,
      truncated: finalText?.truncated === true,
    },
  ];
}

function parseAssistant(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  if (!Array.isArray(message.content)) return [];
  const result: TraceMessage[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    const parsed = parseAssistantBlock(block, { sourceId, sequence }, result.length);
    if (parsed) result.push(parsed);
  }
  return result;
}

function parseAssistantBlock(
  block: Record<string, unknown>,
  origin: { readonly sourceId: string; readonly sequence: number },
  index: number,
): TraceMessage | undefined {
  const { sourceId, sequence } = origin;
  if (block.type === "text" && typeof block.text === "string" && block.text)
    return {
      id: `${sourceId}:text:${index}`,
      role: "assistant",
      text: block.text,
      sequence,
      sourceId,
      truncated: false,
    };
  if (block.type !== "toolCall") return undefined;
  const args = isRecord(block.arguments) ? block.arguments : {};
  return {
    id: `${sourceId}:call:${index}`,
    role: "tool_call",
    text: JSON.stringify(args),
    sequence,
    sourceId,
    ...toolFields(block.name, block.id),
    truncated: false,
  };
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function splitVisibleUnits(
  text: string,
): readonly { readonly start: number; readonly end: number }[] {
  const units: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(/\n\s*\n/g)) {
    const end = match.index ?? text.length;
    if (text.slice(start, end).trim()) units.push({ start, end });
    start = end + match[0].length;
  }
  if (text.slice(start).trim()) units.push({ start, end: text.length });
  return units.length ? units : [{ start: 0, end: text.length }];
}

function classify(message: TraceMessage): MemoryKind {
  if (message.role === "user") return "constraints";
  if (message.role === "tool_result") return message.isError ? "attempts" : "findings";
  if (message.role === "tool_call") return "attempts";
  return "decisions";
}

function trustFor(message: TraceMessage): SourceTrust {
  if (message.role === "user") return "user";
  if (message.role === "assistant") return "assistant";
  if (message.role === "tool_result") return "tool_result";
  return "unknown";
}

export function eventsForMessages(
  messages: readonly TraceMessage[],
  normalizer: PiEventNormalizer,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const message of messages) {
    if (message.role === "user") events.push(normalizer.prompt(message.text));
    if (message.role === "tool_call")
      events.push(
        normalizer.call({
          type: "tool_call",
          toolCallId: message.toolCallId ?? message.id,
          toolName: message.toolName ?? "unknown",
          input: parseInput(message.text),
        }),
      );
    if (message.role === "tool_result")
      events.push(
        normalizer.result({
          type: "tool_result",
          toolCallId: message.toolCallId ?? message.id,
          toolName: message.toolName ?? "unknown",
          input: {},
          content: [{ type: "text", text: message.text }],
          isError: message.isError === true,
          details: undefined,
        }),
      );
  }
  return events;
}

function deriveEvents(messages: readonly TraceMessage[]): AgentEvent[] {
  return eventsForMessages(
    messages,
    new PiEventNormalizer({
      eventCount: 0,
      turnIndex: 0,
      config: defaultConfig(),
      now: () => 0,
      cwd: "/experiment",
    }),
  );
}

function parseInput(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
