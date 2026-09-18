import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { defaultConfig } from "../../core/config.js";
import { isRecord } from "../../core/serialization.js";
import type { AgentEvent } from "../../core/types.js";
import { PiEventNormalizer } from "../../pi/normalization.js";
import type { Candidate, TraceData, TraceMessage } from "./types.js";
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
  const messages: TraceMessage[] = [];
  const missingText: string[] = [];
  let sequence = 0;
  for (const entry of branch) {
    const message = isRecord(entry.message) ? entry.message : entry;
    if (!isRecord(message)) continue;
    const sourceId = typeof entry.id === "string" ? entry.id : `entry-${sequence + 1}`;
    const parsed = parseMessage(message, sourceId, sequence);
    if (
      !parsed.length &&
      ((entry.type === "message" && message.role !== "system") || entry.type === "agent_end")
    )
      missingText.push(sourceId);
    for (const item of parsed) messages.push({ ...item, sequence: sequence++ });
  }
  const format = options.synthetic
    ? "synthetic"
    : branch.some((entry) => entry.type === "message")
      ? "pi"
      : "event-only";
  const sourceHash = hash(JSON.stringify(messages));
  const events = deriveEvents(messages);
  return {
    format,
    ...(options.session ? { sessionPath: options.session } : {}),
    leaf: options.leaf ?? branch.at(-1)?.id?.toString() ?? null,
    messages,
    events,
    missingText,
    sourceHash,
  };
}

export function generateCandidates(
  messages: readonly TraceMessage[],
  options: { readonly maxBytes?: number; readonly observedAt?: number } = {},
): Candidate[] {
  const maxBytes = options.maxBytes ?? 4096;
  const candidates: Candidate[] = [];
  let ordinal = 0;
  for (const message of messages) {
    if (!message.text.trim()) continue;
    const units = splitVisibleUnits(message.text);
    for (const unit of units) {
      const text = message.text.slice(unit.start, unit.end);
      const truncated = Buffer.byteLength(text) > maxBytes;
      const category = classify(message);
      const candidate: Candidate = {
        id: `candidate-${++ordinal}`,
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
        contextComplete: !truncated,
      };
      candidates.push(candidate);
    }
  }
  return candidates;
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

function parseMessage(
  message: Record<string, unknown>,
  sourceId: string,
  sequence: number,
): TraceMessage[] {
  const role = typeof message.role === "string" ? message.role : message.type;
  if (role === "user") {
    const text = visibleText(message.content);
    return text
      ? [{ id: `${sourceId}:text`, role, text, sequence, sourceId, truncated: false }]
      : [];
  }
  if (role === "toolResult") {
    const text = visibleText(message.content);
    return [
      {
        id: `${sourceId}:result`,
        role: "tool_result",
        text,
        sequence,
        sourceId,
        ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
        isError: message.isError === true,
        truncated: false,
      },
    ];
  }
  if (role === "user_prompt") {
    const text = typeof message.text === "string" ? message.text : "";
    return text
      ? [{ id: `${sourceId}:text`, role: "user", text, sequence, sourceId, truncated: false }]
      : [];
  }
  if (role === "tool_call") {
    const input = isRecord(message.input) ? message.input : {};
    return [
      {
        id: `${sourceId}:call`,
        role: "tool_call",
        text: JSON.stringify(input),
        sequence,
        sourceId,
        ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
        truncated: false,
      },
    ];
  }
  if (role === "tool_result") {
    const excerpt = isRecord(message.excerpt) ? message.excerpt : undefined;
    const text = typeof excerpt?.head === "string" ? excerpt.head : "";
    return [
      {
        id: `${sourceId}:result`,
        role: "tool_result",
        text,
        sequence,
        sourceId,
        ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
        isError: message.isError === true,
        truncated: excerpt?.truncated === true,
      },
    ];
  }
  if (role === "agent_end") {
    const finalText = isRecord(message.finalText) ? message.finalText.head : undefined;
    return typeof finalText === "string" && finalText
      ? [
          {
            id: `${sourceId}:text`,
            role: "assistant",
            text: finalText,
            sequence,
            sourceId,
            truncated: isRecord(message.finalText) && message.finalText.truncated === true,
          },
        ]
      : [];
  }
  if (role !== "assistant" || !Array.isArray(message.content)) return [];
  const result: TraceMessage[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      result.push({
        id: `${sourceId}:text:${result.length}`,
        role,
        text: block.text,
        sequence,
        sourceId,
        truncated: false,
      });
    }
    if (block.type === "toolCall") {
      const args = isRecord(block.arguments) ? block.arguments : {};
      result.push({
        id: `${sourceId}:call:${result.length}`,
        role: "tool_call",
        text: JSON.stringify(args),
        sequence,
        sourceId,
        ...(typeof block.name === "string" ? { toolName: block.name } : {}),
        ...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
        truncated: false,
      });
    }
  }
  return result;
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

function deriveEvents(messages: readonly TraceMessage[]): AgentEvent[] {
  const normalizer = new PiEventNormalizer({
    eventCount: 0,
    turnIndex: 0,
    config: defaultConfig(),
    now: () => 0,
    cwd: "/experiment",
  });
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

function parseInput(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
