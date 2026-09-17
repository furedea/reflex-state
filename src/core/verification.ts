import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

import type { ReflexStateConfig } from "./config.js";
import type {
  AgentEvent,
  EventId,
  ToolCallEvent,
  VerificationFact,
  VerificationFreshness,
  VerificationKind,
  VerificationStatus,
} from "./types.js";

export interface VerificationClassification {
  readonly kind?: VerificationKind;
  readonly command: string;
  readonly cwd: string;
  readonly compound: boolean;
  readonly attributable: boolean;
  readonly checkKey?: string;
  readonly unknownReason?: string;
}

const commands: Record<VerificationKind, RegExp> = {
  test: /^(pytest|vitest|jest|cargo\s+test|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)(?:\s|$)/,
  build:
    /^(tsc|cargo\s+build|go\s+build|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck))(?:\s|$)/,
  lint: /^(eslint|oxlint|biome|ruff|cargo\s+clippy|clippy|golangci-lint|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint)(?:\s|$)/,
};

export function normalizeCwd(cwd: string): string {
  const absolute = resolve("/", cwd || ".");
  return relative("/", absolute) ? absolute.replace(/\/$/, "") : "/";
}

export function normalizeCommand(command: string): string {
  let result = "";
  let quote: "'" | '"' | "" = "";
  let escaped = false;
  let pendingSpace = false;
  for (const char of command.trim()) {
    if (escaped) {
      result += char;
      escaped = false;
      pendingSpace = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      result += char;
      escaped = true;
      pendingSpace = false;
      continue;
    }
    if (quote) {
      result += char;
      if (char === quote) quote = "";
      pendingSpace = false;
      continue;
    }
    if (char === "'" || char === '"') {
      if (pendingSpace) result += " ";
      result += char;
      quote = char;
      pendingSpace = false;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) result += " ";
    result += char;
    pendingSpace = false;
  }
  return result;
}

export function verificationCheckKey(kind: VerificationKind, cwd: string, command: string): string {
  const identity = JSON.stringify([kind, normalizeCwd(cwd), normalizeCommand(command)]);
  return "check:" + createHash("sha256").update(identity).digest("hex");
}

export function classifyVerification(
  command: string,
  cwd: string,
  config: ReflexStateConfig,
  truncated = false,
): VerificationClassification | undefined {
  const normalized = normalizeCommand(command);
  const kind = detectKind(normalized, config);
  if (!kind) return undefined;
  const shell = shellOperators(normalized);
  const compound = shell.length > 0 || hasUnclosedSyntax(normalized);
  const unknownReason = truncated
    ? "command_truncated"
    : shell.length > 0
      ? "compound_command"
      : compound
        ? "ambiguous_shell_syntax"
        : undefined;
  return {
    kind,
    command,
    cwd: normalizeCwd(cwd),
    compound,
    attributable: !unknownReason,
    ...(unknownReason ? { unknownReason } : {}),
    ...(!unknownReason ? { checkKey: verificationCheckKey(kind, cwd, command) } : {}),
  };
}

export function verificationFact(
  event: AgentEvent,
  call: ToolCallEvent | undefined,
  config: ReflexStateConfig,
  generation: number,
  pendingChanges: readonly EventId[],
  started?: { readonly eventId: EventId; readonly generation: number; readonly checkKey?: string },
): VerificationFact | undefined {
  if (!call || call.toolName !== "bash" || typeof call.input.command !== "string") return undefined;
  const classification = classifyVerification(
    call.input.command,
    call.cwd ?? ".",
    config,
    call.commandTruncated,
  );
  if (!classification?.kind) return undefined;
  const kind = classification.kind;
  const status = statusFor(event, classification);
  const current =
    event.type === "tool_call"
      ? true
      : Boolean(
          started &&
          started.generation === generation &&
          pendingChanges.every((id) => id === started.eventId),
        );
  const freshness: VerificationFreshness =
    event.type === "tool_call"
      ? "unknown"
      : classification.attributable
        ? current
          ? "current"
          : "stale"
        : "unknown";
  return {
    ...classification,
    kind,
    status,
    ...(started ? { startedEvent: started.eventId, observedGeneration: started.generation } : {}),
    freshness,
  };
}

function detectKind(command: string, config: ReflexStateConfig): VerificationKind | undefined {
  return candidateSegments(command)
    .map((segment) => detectSingle(segment, config))
    .find(Boolean);
}

function detectSingle(command: string, config: ReflexStateConfig): VerificationKind | undefined {
  const executable = command.trim().replace(/^(?:npx\s+|(?:npm|pnpm|yarn|bun)\s+exec\s+)/, "");
  return (["test", "build", "lint"] as const).find(
    (kind) =>
      commands[kind].test(executable) ||
      config.verificationCommands[kind].some((pattern) => {
        try {
          return new RegExp(pattern).test(executable);
        } catch {
          return false;
        }
      }),
  );
}

function candidateSegments(command: string): string[] {
  const segments: string[] = [];
  let part = "";
  let quote: "'" | '"' | "" = "";
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      part += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      part += char;
      escaped = true;
      continue;
    }
    if (quote) {
      part += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      part += char;
      quote = char;
      continue;
    }
    if (";|&<>\n".includes(char)) {
      if (part.trim()) segments.push(part.trim());
      part = "";
      continue;
    }
    part += char;
  }
  if (part.trim()) segments.push(part.trim());
  return segments;
}

function shellOperators(command: string): string[] {
  const operators: string[] = [];
  let quote: "'" | '"' | "" = "";
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") operators.push("substitution");
    else if (char === "`" || ";|&<>\n".includes(char)) operators.push(char);
  }
  return operators;
}

function hasUnclosedSyntax(command: string): boolean {
  let quote: "'" | '"' | "" = "";
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
  }
  return Boolean(quote || escaped);
}

function statusFor(
  event: AgentEvent,
  classification: VerificationClassification,
): VerificationStatus {
  if (event.type === "tool_call") return "running";
  if (event.type !== "tool_result") return "unknown";
  if (!classification.attributable) return "unknown";
  if (!event.isError) return "passed";
  const text = event.excerpt.head + (event.excerpt.tail ? "\n" + event.excerpt.tail : "");
  const match = /(?:^|\n)Command exited with code (\d+)\s*$/.exec(text);
  if (!match) return "unknown";
  return Number(match[1]) === 0 ? "passed" : "failed";
}
