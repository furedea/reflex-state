import { relative, resolve } from "node:path";

import type { ReflexStateConfig } from "./config.js";
import type { AgentEvent, DeterministicFacts, EventId, HotState, ToolCallEvent } from "./types.js";
import { verificationFact } from "./verification.js";

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
  const call = relatedCall(context);
  const observedCall = call && call.cwd ? call : call ? { ...call, cwd: context.cwd } : undefined;
  const paths = callPaths(context);
  const fileChanges = changedPaths(context);
  const generation = context.state.observationGeneration ?? 0;
  const started = observedCall ? startedVerification(context, observedCall.id) : undefined;
  const verification = verificationFact(
    event,
    observedCall,
    context.config,
    generation,
    context.state.pendingChanges ?? [],
    started,
  );
  const mutation = mutationFact(context, call, fileChanges);
  return {
    fileChanges,
    filesRead: event.type === "tool_call" && call?.toolName === "read" ? paths : [],
    phaseProposal: phaseProposal(event, verification),
    deterministicallyResolved:
      verification?.status === "passed" &&
      verification.freshness === "current" &&
      verification.checkKey
        ? context.state.activeBlockers
            .filter(
              (blocker) =>
                blocker.origin === "verification" && blocker.checkKey === verification.checkKey,
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
        verificationFact(
          previous,
          withCwd(relatedCall(previousContext), context.cwd),
          context.config,
          context.state.observationGeneration ?? 0,
          [],
        )?.checkKey === verification.checkKey
      )
        return true;
      const oldPaths = changedPaths(previousContext);
      return oldPaths.length > 0 && oldPaths.every((path) => fileChanges.includes(path));
    }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(verification ? { verification } : {}),
    ...(mutation ? { mutation } : {}),
  };
}

function withCwd(call: ToolCallEvent | undefined, cwd: string): ToolCallEvent | undefined {
  return call && call.cwd ? call : call ? { ...call, cwd } : undefined;
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
  const text = event.excerpt.head + (event.excerpt.tail ? "\n" + event.excerpt.tail : "");
  const match = /(?:^|\n)Command exited with code (\d+)\s*$/.exec(text);
  return match ? Number(match[1]) : undefined;
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

function startedVerification(
  context: ExtractionContext,
  callId: EventId,
):
  | { readonly eventId: EventId; readonly generation: number; readonly checkKey?: string }
  | undefined {
  const running = Object.values(context.state.verification).find(
    (verification) => verification.startedEvent === callId,
  );
  return running?.startedEvent
    ? {
        eventId: running.startedEvent,
        generation: running.observedGeneration ?? context.state.observationGeneration ?? 0,
        ...(running.checkKey ? { checkKey: running.checkKey } : {}),
      }
    : undefined;
}

function mutationFact(
  context: ExtractionContext,
  call: ToolCallEvent | undefined,
  paths: readonly string[],
) {
  const { event } = context;
  if (event.type === "file_change")
    return { operationId: event.id, possible: true, completed: true, paths };
  if (!call || !["bash", "edit", "write"].includes(call.toolName)) return undefined;
  if (event.type === "tool_call")
    return { operationId: event.id, possible: true, completed: false, paths: [] };
  if (event.type === "tool_result")
    return { operationId: call.id, possible: true, completed: true, paths };
  return undefined;
}

function normalizePaths(paths: readonly string[], cwd: string): string[] {
  const root = resolve("/", cwd);
  return paths.map((path) => relative(root, resolve(root, path)));
}
