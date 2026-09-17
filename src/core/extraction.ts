import { relative, resolve } from "node:path";

import type { ReflexStateConfig } from "./config.js";
import type {
  AgentEvent,
  DeterministicFacts,
  EventId,
  HotState,
  ToolCallEvent,
  VerificationKind,
} from "./types.js";

export interface ExtractionContext {
  readonly state: HotState;
  readonly event: AgentEvent;
  readonly evidence: ReadonlyMap<EventId, AgentEvent>;
  readonly cwd: string;
  readonly config: ReflexStateConfig;
}

export function extractFacts(context: ExtractionContext): DeterministicFacts {
  const { event } = context;
  const exitCode = resultExitCode(event);
  const verification = verificationFact(context, exitCode);
  const paths = callPaths(context);
  const call = relatedCall(context);
  const fileChanges = changedPaths(context);
  return {
    fileChanges,
    filesRead: event.type === "tool_call" && call?.toolName === "read" ? paths : [],
    phaseProposal: phaseProposal(event, verification),
    deterministicallyResolved:
      verification?.status === "passed"
        ? context.state.activeBlockers
            .filter(
              (blocker) => blocker.origin === "verification" && blocker.kind === verification.kind,
            )
            .map((blocker) => blocker.eventId)
        : [],
    supersededInWorkingSet: context.state.workingSet.filter((id) => {
      const previous = context.evidence.get(id);
      if (!previous) return false;
      const previousContext = { ...context, event: previous };
      if (
        verification &&
        event.type === "tool_result" &&
        previous.type === "tool_result" &&
        verificationFact(previousContext, resultExitCode(previous))?.kind === verification.kind
      )
        return true;
      const oldPaths = changedPaths(previousContext);
      return oldPaths.length > 0 && oldPaths.every((path) => fileChanges.includes(path));
    }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(verification ? { verification } : {}),
  };
}

function phaseProposal(
  event: AgentEvent,
  verification: DeterministicFacts["verification"],
): DeterministicFacts["phaseProposal"] {
  if (event.type === "user_prompt") return "planning";
  if (verification?.status === "failed") return "debugging";
  if (verification?.status === "running") return "testing";
  if (event.type === "file_change") return "editing";
  if (event.type !== "tool_call" && event.type !== "tool_result") return null;
  if (["read", "grep", "find", "ls"].includes(event.toolName)) return "exploring";
  if (["edit", "write"].includes(event.toolName)) return "editing";
  return null;
}

function relatedCall(context: ExtractionContext): ToolCallEvent | undefined {
  const { event, evidence } = context;
  if (event.type === "tool_call") return event;
  if (event.type !== "tool_result") return undefined;
  return [...evidence.values()]
    .reverse()
    .find(
      (candidate): candidate is ToolCallEvent =>
        candidate.type === "tool_call" &&
        candidate.toolCallId === event.toolCallId &&
        candidate.toolName === event.toolName,
    );
}

function resultExitCode(event: AgentEvent): number | undefined {
  if (event.type !== "tool_result" || !event.isError || event.toolName !== "bash") return undefined;
  const text = event.excerpt.tail ?? event.excerpt.head;
  const match = /(?:^|\n)Command exited with code (\d+)\s*$/.exec(text);
  return match ? Number(match[1]) : undefined;
}

function verificationFact(
  context: ExtractionContext,
  exitCode: number | undefined,
): DeterministicFacts["verification"] {
  const call = relatedCall(context);
  if (call?.toolName !== "bash" || typeof call.input.command !== "string") return undefined;
  const command = call.input.command;
  const segments = commandSegments(command);
  const kind = (["test", "build", "lint"] as const).find((candidate) =>
    segments.some((segment) => matchesCommand(segment, candidate, context.config)),
  );
  if (!kind) return undefined;
  const event = context.event;
  const status =
    event.type === "tool_call"
      ? "running"
      : event.type === "tool_result" && !event.isError
        ? "passed"
        : exitCode === undefined
          ? "unknown"
          : exitCode === 0
            ? "passed"
            : "failed";
  return { kind, status, command, compound: segments.length > 1 };
}

const commands: Record<VerificationKind, RegExp> = {
  test: /^(pytest|vitest|jest|cargo\s+test|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)(?:\s|$)/,
  build:
    /^(tsc|cargo\s+build|go\s+build|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck))(?:\s|$)/,
  lint: /^(eslint|oxlint|biome|ruff|cargo\s+clippy|clippy|golangci-lint|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint)(?:\s|$)/,
};

function matchesCommand(
  segment: string,
  kind: VerificationKind,
  config: ReflexStateConfig,
): boolean {
  const command = segment.trim().replace(/^(?:npx\s+|(?:npm|pnpm|yarn|bun)\s+exec\s+)/, "");
  if (commands[kind].test(command)) return true;
  return config.verificationCommands[kind].some((pattern) => {
    try {
      return new RegExp(pattern).test(segment);
    } catch {
      return false;
    }
  });
}

function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let part = "";
  let quote = "";
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
    if (";&|\n".includes(char)) {
      segments.push(part);
      part = "";
      continue;
    }
    part += char;
  }
  segments.push(part);
  return segments;
}

function callPaths(context: ExtractionContext): string[] {
  const call = relatedCall(context);
  return typeof call?.input.path === "string" ? normalizePaths([call.input.path], context.cwd) : [];
}

function changedPaths(context: ExtractionContext): string[] {
  const { event } = context;
  if (event.type === "file_change") return normalizePaths(event.paths, context.cwd);
  if (event.type !== "tool_result" || event.isError || !["edit", "write"].includes(event.toolName))
    return [];
  return callPaths(context);
}

function normalizePaths(paths: readonly string[], cwd: string): string[] {
  const root = resolve("/", cwd);
  return paths.map((path) => relative(root, resolve(root, path)));
}
