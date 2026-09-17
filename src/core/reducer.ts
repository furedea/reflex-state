import type { ReflexStateConfig } from "./config.js";
import type {
  AgentEvent,
  Blocker,
  DeterministicFacts,
  EventId,
  GatedDecision,
  HotState,
  SemanticDecisions,
  TaskStatus,
} from "./types.js";

interface ReductionContext {
  readonly state: HotState;
  readonly event: AgentEvent;
  readonly facts: DeterministicFacts;
  readonly decisions: SemanticDecisions;
  readonly config: ReflexStateConfig;
  readonly now: string;
}

export function initialState(): HotState {
  return {
    version: 1,
    goal: null,
    phase: "unknown",
    taskStatus: "unknown",
    modifiedFiles: [],
    relevantFiles: [],
    verification: {
      build: { status: "not_run" },
      test: { status: "not_run" },
      lint: { status: "not_run" },
    },
    activeBlockers: [],
    workingSet: [],
    cursor: { lastEventId: null, eventCount: 0, turnIndex: 0 },
    lastUpdatedAt: "1970-01-01T00:00:00.000Z",
  };
}

export function reduce(context: ReductionContext): { state: HotState; changes: string[] } {
  const { state, event, facts, decisions, config, now } = context;
  const blockers = updatedBlockers(context);
  const completed =
    event.type === "agent_end" && !blockers.length && accepted(decisions.taskComplete) === true;
  const evicted = blockers.slice(0, Math.max(0, blockers.length - config.limits.maxActiveBlockers));
  const activeBlockers = blockers.slice(-config.limits.maxActiveBlockers);
  const next: HotState = {
    ...state,
    goal: event.type === "user_prompt" ? event.id : state.goal,
    cursor: {
      lastEventId: event.id,
      eventCount: Number(event.id.slice(1)),
      turnIndex: event.turnIndex,
    },
    lastUpdatedAt: now,
    phase: completed ? "done" : (facts.phaseProposal ?? state.phase),
    verification: facts.verification
      ? {
          ...state.verification,
          [facts.verification.kind]: {
            status: facts.verification.status,
            evidence: event.id,
            command: facts.verification.command,
          },
        }
      : state.verification,
    modifiedFiles: uniqueRecent([...state.modifiedFiles, ...facts.fileChanges], 64).sort(),
    relevantFiles: uniqueRecent([...state.relevantFiles, ...facts.filesRead], 32),
    activeBlockers,
    workingSet: boundedWorkingSet(context, blockers),
    taskStatus: derivedTaskStatus(context, { blocked: blockers.length > 0, completed }),
  };
  const changes = stateChanges(state, next);
  changes.push(...evicted.map((blocker) => "evicted oldest blocker " + blocker.eventId));
  return { state: next, changes };
}

export function admitsEvidence(event: AgentEvent, facts: DeterministicFacts): boolean {
  if (facts.fileChanges.length) return true;
  if (event.type !== "tool_result" || ["read", "grep", "find", "ls"].includes(event.toolName))
    return false;
  return event.isError || facts.verification !== undefined;
}

function updatedBlockers({ state, event, facts, decisions }: ReductionContext): Blocker[] {
  const blockers = state.activeBlockers.filter((blocker) => {
    if (facts.deterministicallyResolved.includes(blocker.eventId)) return false;
    if (blocker.origin !== "tool_error" || event.type !== "tool_result" || event.isError)
      return true;
    return !decisions.resolvedBlockers.some(
      (item) => item.eventId === blocker.eventId && accepted(item.decision) === true,
    );
  });
  if (facts.verification?.status === "failed") {
    blockers.push({
      eventId: event.id,
      origin: "verification",
      kind: facts.verification.kind,
      category: accepted(decisions.failureCategory) ?? "unknown",
    });
  } else if (
    event.type === "tool_result" &&
    event.isError &&
    accepted(decisions.blockerIntroduced) === true
  ) {
    blockers.push({
      eventId: event.id,
      origin: "tool_error",
      category: accepted(decisions.failureCategory) ?? "unknown",
    });
  }
  return blockers;
}

function boundedWorkingSet(context: ReductionContext, blockers: readonly Blocker[]): EventId[] {
  const { state, event, facts, decisions, config } = context;
  let workingSet = state.workingSet.filter((id) => !facts.supersededInWorkingSet.includes(id));
  if (admitsEvidence(event, facts) && !workingSet.includes(event.id)) workingSet.push(event.id);
  const cap = config.limits.maxWorkingSetEvents;
  if (workingSet.length <= cap) return workingSet;
  const resolved = state.activeBlockers.filter(
    (old) => !blockers.some((blocker) => blocker.eventId === old.eventId),
  );
  workingSet = workingSet.filter((id) => !resolved.some((blocker) => blocker.eventId === id));
  if (workingSet.length <= cap) return workingSet;
  workingSet = workingSet.filter(
    (id) =>
      !decisions.relevance.some((item) => item.eventId === id && accepted(item.decision) === false),
  );
  return workingSet.slice(-cap);
}

function derivedTaskStatus(
  context: ReductionContext,
  outcome: { blocked: boolean; completed: boolean },
): TaskStatus {
  if (context.event.type === "user_prompt") return "in_progress";
  if (outcome.blocked) return "blocked";
  if (
    outcome.completed ||
    (context.state.taskStatus === "completed" && context.event.type === "agent_end")
  )
    return "completed";
  return "in_progress";
}

function uniqueRecent<T>(values: readonly T[], cap: number): T[] {
  return [...new Set([...values].reverse())].slice(0, cap).reverse();
}

function stateChanges(before: HotState, after: HotState): string[] {
  return (Object.keys(after) as (keyof HotState)[])
    .filter(
      (key) =>
        key !== "lastUpdatedAt" &&
        key !== "cursor" &&
        JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    .map((key) => key + ": " + JSON.stringify(before[key]) + " -> " + JSON.stringify(after[key]));
}

function accepted<T>(decision: GatedDecision<T> | undefined): T | null {
  return decision?.gate === "applied" && !decision.shadow ? decision.value : null;
}
