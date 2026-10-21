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

export interface StartedVerification {
  readonly eventId: EventId;
  readonly generation: number;
  readonly current: boolean;
  readonly checkKey?: string;
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
  let pendingSpace = false;
  const scanner = new ShellScanner();
  for (const char of command.trim()) {
    const kind = scanner.scan(char);
    if (kind === "plain" && /\s/.test(char)) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace && (kind === "plain" || kind === "open-quote")) result += " ";
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
): VerificationClassification | undefined {
  const normalized = normalizeCommand(command);
  const kind = detectKind(normalized, config);
  if (!kind) return undefined;
  const shell = shellOperators(normalized);
  const compound = shell.length > 0 || hasUnclosedSyntax(normalized);
  const unknownReason = unknownReasonFor(shell.length > 0, compound);
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

export function classifyToolCall(
  call: ToolCallEvent | undefined,
  config: ReflexStateConfig,
): VerificationClassification | undefined {
  if (!call || call.toolName !== "bash" || typeof call.input.command !== "string") return undefined;
  const classification = classifyVerification(call.input.command, call.cwd ?? ".", config);
  return classification && call.commandTruncated ? truncated(classification) : classification;
}

function truncated(classification: VerificationClassification): VerificationClassification {
  const { checkKey: _checkKey, ...rest } = classification;
  return { ...rest, attributable: false, unknownReason: "command_truncated" };
}

function unknownReasonFor(hasShellOperators: boolean, compound: boolean): string | undefined {
  if (hasShellOperators) return "compound_command";
  return compound ? "ambiguous_shell_syntax" : undefined;
}

export function verificationFact(
  event: AgentEvent,
  classification: VerificationClassification | undefined,
  started?: StartedVerification,
): VerificationFact | undefined {
  if (!classification?.kind) return undefined;
  return {
    ...classification,
    kind: classification.kind,
    status: statusFor(event, classification),
    ...(started ? { startedEvent: started.eventId, observedGeneration: started.generation } : {}),
    freshness: freshnessFor(event, classification, started),
  };
}

function freshnessFor(
  event: AgentEvent,
  classification: VerificationClassification,
  started: StartedVerification | undefined,
): VerificationFreshness {
  if (event.type === "tool_call" || !classification.attributable) return "unknown";
  return started?.current ? "current" : "stale";
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
  const scanner = new ShellScanner();
  for (const char of command) {
    const isSeparator = scanner.scan(char) === "plain" && ";|&<>\n".includes(char);
    if (!isSeparator) {
      part += char;
      continue;
    }
    pushSegment(segments, part);
    part = "";
  }
  pushSegment(segments, part);
  return segments;
}

function pushSegment(segments: string[], part: string): void {
  if (part.trim()) segments.push(part.trim());
}

function shellOperators(command: string): string[] {
  const operators: string[] = [];
  const scanner = new ShellScanner();
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (scanner.scan(char) !== "plain") continue;
    if (char === "$" && command[index + 1] === "(") operators.push("substitution");
    else if (char === "`" || ";|&<>\n".includes(char)) operators.push(char);
  }
  return operators;
}

function hasUnclosedSyntax(command: string): boolean {
  const scanner = new ShellScanner();
  for (const char of command) scanner.scan(char);
  return scanner.isUnclosed;
}

type CharKind = "escaped" | "escape" | "quoted" | "open-quote" | "plain";

class ShellScanner {
  private quote: "'" | '"' | "" = "";
  private escaped = false;

  get isUnclosed(): boolean {
    return Boolean(this.quote || this.escaped);
  }

  scan(char: string): CharKind {
    if (this.escaped) {
      this.escaped = false;
      return "escaped";
    }
    if (char === "\\" && this.quote !== "'") {
      this.escaped = true;
      return "escape";
    }
    if (this.quote) {
      if (char === this.quote) this.quote = "";
      return "quoted";
    }
    if (char === "'" || char === '"') {
      this.quote = char;
      return "open-quote";
    }
    return "plain";
  }
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
