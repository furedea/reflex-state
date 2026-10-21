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
  VerificationFact,
  VerificationState,
} from "./types.js";

interface ReductionContext {
  readonly state: HotState;
  readonly event: AgentEvent;
  readonly facts: DeterministicFacts;
  readonly decisions: SemanticDecisions;
  readonly evidence: ReadonlyMap<EventId, AgentEvent>;
  readonly config: ReflexStateConfig;
  readonly now: string;
}

export function initialState(): HotState {
  return {
    version: 2,
    goal: null,
    phase: "unknown",
    taskStatus: "unknown",
    modifiedFiles: [],
    relevantFiles: [],
    verification: {
      build: { status: "not_run", freshness: "unknown" },
      test: { status: "not_run", freshness: "unknown" },
      lint: { status: "not_run", freshness: "unknown" },
    },
    activeBlockers: [],
    workingSet: [],
    observationGeneration: 0,
    pendingChanges: [],
    stateHealth: "valid",
    cursor: { lastEventId: null, eventCount: 0, turnIndex: 0 },
    lastUpdatedAt: "1970-01-01T00:00:00.000Z",
  };
}

export function reduce(context: ReductionContext): { state: HotState; changes: string[] } {
  const { state, event, facts, now } = context;
  const blockers = updatedBlockers(context);
  const generation =
    (state.observationGeneration ?? 0) + (mutationAdvancesGeneration(state, event, facts) ? 1 : 0);
  const pendingChanges = nextPendingChanges(state.pendingChanges ?? [], event, facts);
  const verification = updatedVerification(context, generation, pendingChanges);
  const completed = canComplete(context, blockers, pendingChanges);
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
    verification,
    modifiedFiles: uniqueRecent([...state.modifiedFiles, ...facts.fileChanges], 64).sort(),
    relevantFiles: uniqueRecent([...state.relevantFiles, ...facts.filesRead], 32),
    activeBlockers: blockers,
    workingSet: boundedWorkingSet(context, blockers),
    observationGeneration: generation,
    pendingChanges,
    stateHealth: event.type === "session_resume" ? "valid" : (state.stateHealth ?? "valid"),
    taskStatus: derivedTaskStatus(context, { blocked: blockers.length > 0, completed }),
  };
  const changes = stateChanges(state, next);
  return { state: next, changes };
}

function mutationAdvancesGeneration(
  state: HotState,
  event: AgentEvent,
  facts: DeterministicFacts,
): boolean {
  if (!facts.mutation) return false;
  if (event.type !== "tool_result") return true;
  return (
    !facts.mutation.operationId ||
    !(state.pendingChanges ?? []).includes(facts.mutation.operationId)
  );
}

export function admitsEvidence(event: AgentEvent, facts: DeterministicFacts): boolean {
  if (facts.fileChanges.length) return true;
  if (event.type !== "tool_result" || ["read", "grep", "find", "ls"].includes(event.toolName))
    return false;
  return event.isError || facts.verification !== undefined;
}

function updatedBlockers({
  state,
  event,
  facts,
  decisions,
  evidence,
}: ReductionContext): Blocker[] {
  const blockers = state.activeBlockers.filter((blocker) => {
    if (facts.deterministicallyResolved.includes(blocker.eventId)) return false;
    if (blocker.origin !== "tool_error" || event.type !== "tool_result" || event.isError)
      return true;
    return !decisions.resolvedBlockers.some(
      (item) =>
        item.eventId === blocker.eventId &&
        evidence.has(blocker.eventId) &&
        accepted(item.decision) === true,
    );
  });
  if (facts.verification?.status === "failed") {
    if (!facts.verification.attributable || !facts.verification.checkKey) return blockers;
    blockers.push({
      eventId: event.id,
      origin: "verification",
      kind: facts.verification.kind,
      checkKey: facts.verification.checkKey,
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
  if (outcome.completed) return "completed";
  if (context.event.type === "agent_end") return "in_progress";
  if (context.state.taskStatus === "completed") return "completed";
  return "in_progress";
}

function canComplete(
  context: ReductionContext,
  blockers: readonly Blocker[],
  pendingChanges: readonly EventId[],
): boolean {
  return (
    context.event.type === "agent_end" &&
    context.event.stopReason === "stop" &&
    blockers.length === 0 &&
    pendingChanges.length === 0 &&
    context.state.stateHealth === "valid" &&
    context.state.observationGeneration !== undefined &&
    context.state.pendingChanges !== undefined &&
    accepted(context.decisions.taskComplete) === true
  );
}

function nextPendingChanges(
  pending: readonly EventId[],
  event: AgentEvent,
  facts: DeterministicFacts,
): EventId[] {
  const next = [...pending];
  if (event.type === "tool_call" && facts.mutation && !next.includes(event.id)) next.push(event.id);
  if (event.type === "tool_result" && facts.mutation?.operationId)
    return next.filter((id) => id !== facts.mutation?.operationId);
  return next;
}

function updatedVerification(
  context: ReductionContext,
  generation: number,
  pendingChanges: readonly EventId[],
): HotState["verification"] {
  const { state, event, facts } = context;
  const cloned = mapVerification(state.verification, (item) => ({ ...item }));
  const next = facts.mutation ? markStale(cloned) : cloned;
  const fact = facts.verification;
  if (!fact) return event.type === "session_resume" ? markStale(next) : next;
  const entry = verificationEntry(next[fact.kind], fact, { event, generation });
  const staleBecausePending = event.type === "tool_result" && pendingChanges.length > 0;
  return {
    ...next,
    [fact.kind]: staleBecausePending
      ? { ...entry, freshness: fact.attributable ? "stale" : "unknown" }
      : entry,
  };
}

function markStale(verification: HotState["verification"]): HotState["verification"] {
  return mapVerification(verification, (item) =>
    item.status !== "not_run" ? { ...item, freshness: "stale" } : item,
  );
}

function mapVerification(
  verification: HotState["verification"],
  map: (item: VerificationState) => VerificationState,
): HotState["verification"] {
  return {
    build: map(verification.build),
    test: map(verification.test),
    lint: map(verification.lint),
  };
}

function verificationEntry(
  current: VerificationState,
  fact: VerificationFact,
  { event, generation }: { event: AgentEvent; generation: number },
): VerificationState {
  const {
    checkKey: _previousCheckKey,
    startedEvent: _previousStartedEvent,
    unknownReason: _previousUnknownReason,
    ...stable
  } = current;
  return {
    ...stable,
    status: fact.status,
    freshness: fact.freshness ?? (fact.status === "running" ? "unknown" : "current"),
    evidence: event.id,
    command: fact.command,
    cwd: fact.cwd,
    ...(fact.checkKey ? { checkKey: fact.checkKey } : {}),
    ...(fact.startedEvent ? { startedEvent: fact.startedEvent } : {}),
    ...observedFields(fact, event, generation),
    attributable: fact.attributable,
    ...(fact.unknownReason ? { unknownReason: fact.unknownReason } : {}),
  };
}

function observedFields(fact: VerificationFact, event: AgentEvent, generation: number) {
  if (fact.observedGeneration !== undefined) return { observedGeneration: fact.observedGeneration };
  if (event.type === "tool_call") return { observedGeneration: generation, startedEvent: event.id };
  return {};
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
