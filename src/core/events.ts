import { createHash } from "node:crypto";

import type { ReflexStateConfig } from "./config.js";
import type { EventId, Excerpt } from "./types.js";

export function eventId(ordinal: number): EventId {
  return ("E" + String(ordinal).padStart(4, "0")) as EventId;
}

export function createExcerpt(text: string, limits: ReflexStateConfig["limits"]): Excerpt {
  const truncated = text.length > limits.maxExcerptHeadChars + limits.maxExcerptTailChars;
  return {
    head: truncated ? text.slice(0, limits.maxExcerptHeadChars) : text,
    ...(truncated && limits.maxExcerptTailChars
      ? { tail: text.slice(-limits.maxExcerptTailChars) }
      : {}),
    totalChars: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
    truncated,
  };
}

export function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n[truncated]\n";
  if (limit <= marker.length) return text.slice(0, limit);
  const available = limit - marker.length;
  const head = Math.ceil((available * 2) / 3);
  const tail = available - head;
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : "");
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: unknown) => {
      if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text")
        return [];
      return "text" in block && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n");
}

export function boundedInput(
  input: Readonly<Record<string, unknown>>,
  maxChars: number,
): Record<string, unknown> {
  return boundedValue(input, maxChars, 0) as Record<string, unknown>;
}

function boundedValue(value: unknown, maxChars: number, depth: number): unknown {
  if (typeof value === "string") return boundedText(value, maxChars);
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value))
    return value.slice(0, 64).map((item) => boundedValue(item, maxChars, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .map(([key, item]) => [key, boundedValue(item, maxChars, depth + 1)]),
    );
  return value;
}
