import { defaultConfig } from "./config.js";
import { extractFacts } from "./extraction.js";
import { initialState, reduce } from "./reducer.js";
import { callFixture, excerptFixture, resultFixture } from "./test_fixtures.js";
import type { AgentEvent, EventId, HotState, SemanticDecisions } from "./types.js";
import { emptyDecisions } from "./updater.js";

const evidence = new Map<EventId, AgentEvent>();

test("hot evidence stays bounded and uncertain relevance cannot evict a newer item", () => {
  const workingSet: EventId[] = Array.from(
    { length: 16 },
    (_, index) => ("E" + (index + 1)) as EventId,
  );
  const state: HotState = { ...initialState(), workingSet };
  const event = resultFixture({ id: "E0017", isError: true });
  const next = transition(state, event, {
    ...emptyDecisions(),
    relevance: [
      { eventId: "E10", decision: { value: false, gate: "uncertain" } },
      { eventId: "E2", decision: { value: false, gate: "applied" } },
    ],
  }).state;
  expect(next.workingSet).toHaveLength(16);
  expect(next.workingSet).toContain("E1");
  expect(next.workingSet).toContain("E10");
  expect(next.workingSet).not.toContain("E2");
  expect(state.workingSet).toHaveLength(16);
});

test("a ninth blocker remains in the canonical unresolved set", () => {
  let state = initialState();
  let changes: readonly string[] = [];
  for (let index = 1; index <= 9; index++) {
    const result = transition(
      state,
      resultFixture({ id: ("E" + index) as EventId, isError: true }),
      {
        ...emptyDecisions(),
        blockerIntroduced: { value: true, gate: "applied" },
      },
    );
    state = result.state;
    changes = result.changes;
  }
  expect(state.activeBlockers).toHaveLength(9);
  expect(state.activeBlockers.some((blocker) => blocker.eventId === "E1")).toBe(true);
  expect(changes.some((change) => change.includes("activeBlockers"))).toBe(true);
});

test("file collections are bounded, unique, and modifications are admitted as evidence", () => {
  let state = initialState();
  for (let index = 0; index < 66; index++) {
    state = transition(state, {
      ...callFixture(),
      id: ("E" + (index + 1)) as EventId,
      type: "file_change",
      paths: ["src/file_" + index + ".ts"],
    }).state;
  }
  expect(state.modifiedFiles).toHaveLength(64);
  expect(state.workingSet).toHaveLength(16);
  expect([...state.modifiedFiles].sort()).toEqual(state.modifiedFiles);
  for (let index = 0; index < 34; index++) {
    state = transition(state, {
      ...callFixture({ path: "read_" + index }),
      id: ("E" + (index + 67)) as EventId,
      toolName: "read",
    }).state;
  }
  expect(state.relevantFiles).toHaveLength(32);
  expect(state.relevantFiles.at(-1)).toBe("read_33");
});

test.each(["applied", "uncertain", "skipped", "error"] as const)(
  "only accepted semantic decisions introduce and resolve tool blockers: %s",
  (gate) => {
    const event = resultFixture({ isError: true });
    const decisions: SemanticDecisions = {
      ...emptyDecisions(),
      blockerIntroduced: { value: true, gate },
      failureCategory: { value: "network", gate: "applied" },
      phaseShadow: { value: "done", gate: "applied", shadow: true },
    };
    const next = transition(initialState(), event, decisions).state;
    expect(next.activeBlockers).toEqual(
      gate === "applied" ? [{ eventId: event.id, origin: "tool_error", category: "network" }] : [],
    );
    expect(next.phase).toBe("unknown");
    const blocked: HotState = {
      ...initialState(),
      activeBlockers: [{ eventId: "E0001", origin: "tool_error", category: "network" }],
    };
    evidence.set("E0001", callFixture());
    const resolved = transition(blocked, resultFixture(), {
      ...emptyDecisions(),
      resolvedBlockers: [{ eventId: "E0001", decision: { value: true, gate } }],
    }).state;
    expect(resolved.activeBlockers).toHaveLength(gate === "applied" ? 0 : 1);
  },
);

test.each(["applied", "uncertain", "skipped", "error"] as const)(
  "completion only changes state when accepted: %s",
  (gate) => {
    const event: AgentEvent = {
      ...callFixture(),
      type: "agent_end",
      finalText: excerptFixture("done"),
      stopReason: "stop",
    };
    const decisions = { ...emptyDecisions(), taskComplete: { value: true, gate } };
    const result = transition(
      { ...initialState(), phase: "testing", taskStatus: "in_progress" },
      event,
      decisions,
    ).state;
    expect(result.phase).toBe(gate === "applied" ? "done" : "testing");
    expect(result.taskStatus).toBe(gate === "applied" ? "completed" : "in_progress");
    const prompt: AgentEvent = {
      ...callFixture(),
      id: "E0003",
      type: "user_prompt",
      text: "next task",
    };
    const next = transition(result, prompt).state;
    expect(next.goal).toBe("E0003");
    expect(next.taskStatus).toBe("in_progress");
    expect(next.phase).toBe("planning");
  },
);

test("a remaining blocker prevents task completion", () => {
  const event: AgentEvent = {
    ...callFixture(),
    type: "agent_end",
    finalText: excerptFixture("done"),
    stopReason: "stop",
  };
  const state: HotState = {
    ...initialState(),
    activeBlockers: [{ eventId: "E0000", origin: "tool_error", category: "network" }],
  };
  const next = transition(state, event, {
    ...emptyDecisions(),
    taskComplete: { value: true, gate: "applied" },
  }).state;
  expect(next.taskStatus).toBe("blocked");
  expect(next.phase).not.toBe("done");
});
beforeEach(() => evidence.clear());

function transition(
  state: HotState,
  event: AgentEvent,
  decisions: SemanticDecisions = emptyDecisions(),
) {
  const context = { state, event, evidence, cwd: "/workspace", config: defaultConfig() };
  const result = reduce({
    ...context,
    facts: extractFacts(context),
    decisions,
    now: event.timestamp,
  });
  evidence.set(event.id, event);
  return result;
}

test("verification failure blocks the task until the same verification later passes", () => {
  const initial = initialState();
  const running = transition(initial, callFixture()).state;
  expect(running.verification.test.status).toBe("running");
  const failed = transition(
    running,
    resultFixture({ isError: true, excerpt: excerptFixture("Command exited with code 1") }),
  ).state;
  expect(failed.verification.test).toMatchObject({ status: "failed", evidence: "E0002" });
  expect(failed.activeBlockers).toHaveLength(1);
  expect(failed.activeBlockers[0]).toMatchObject({
    eventId: "E0002",
    origin: "verification",
    kind: "test",
    category: "unknown",
    checkKey: expect.any(String),
  });
  expect(failed.taskStatus).toBe("blocked");
  expect(failed.phase).toBe("debugging");
  expect(failed.workingSet).toContain("E0002");
  const passed = transition(failed, resultFixture({ id: "E0003" })).state;
  expect(passed.verification.test.status).toBe("passed");
  expect(passed.activeBlockers).toEqual([]);
  expect(passed.taskStatus).toBe("in_progress");
  expect(passed.workingSet).toEqual(["E0003"]);
  expect(initial.verification.test.status).toBe("not_run");
  expect(failed.activeBlockers).toHaveLength(1);
});

test("verification freshness becomes stale after a possible workspace change", () => {
  let state = initialState();
  const call = callFixture({ command: "pnpm test" });
  state = transition(state, { ...call, cwd: "/workspace" }).state;
  state = transition(
    state,
    resultFixture({
      isError: false,
      excerpt: excerptFixture("passed"),
      toolCallId: call.toolCallId,
    }),
  ).state;
  expect(state.verification.test).toMatchObject({ status: "passed", freshness: "current" });
  state = transition(state, {
    ...callFixture({ path: "src/main.ts" }),
    id: "E0003" as EventId,
    type: "file_change",
    paths: ["src/main.ts"],
  }).state;
  expect(state.verification.test).toMatchObject({ status: "passed", freshness: "stale" });
});

test("verification blockers require the same current check key to resolve", () => {
  let state = initialState();
  const call = { ...callFixture({ command: "pytest tests/integration" }), cwd: "/workspace" };
  state = transition(state, call).state;
  state = transition(
    state,
    resultFixture({ isError: true, excerpt: excerptFixture("Command exited with code 1") }),
  ).state;
  expect(state.activeBlockers).toHaveLength(1);
  const otherCall = {
    ...callFixture({ command: "pytest tests/unit" }),
    id: "E0003" as EventId,
    cwd: "/workspace",
  };
  state = transition(state, otherCall).state;
  state = transition(state, resultFixture({ id: "E0004" })).state;
  expect(state.activeBlockers).toHaveLength(1);
  const sameCall = {
    ...callFixture({ command: "pytest tests/integration" }),
    id: "E0005" as EventId,
    cwd: "/workspace",
  };
  state = transition(state, sameCall).state;
  state = transition(state, resultFixture({ id: "E0006" })).state;
  expect(state.activeBlockers).toHaveLength(0);
});

test("a possible edit between verification call and result leaves the result stale", () => {
  let state = initialState();
  const verificationCall = { ...callFixture({ command: "pnpm test" }), cwd: "/workspace" };
  state = transition(state, verificationCall).state;
  const editCall = {
    ...callFixture({ path: "src/main.ts", content: "changed" }),
    id: "E0002" as EventId,
    toolCallId: "call-edit",
    toolName: "edit",
  };
  state = transition(state, editCall).state;
  state = transition(
    state,
    resultFixture({ id: "E0003", toolCallId: "call-edit", toolName: "edit" }),
  ).state;
  state = transition(state, resultFixture({ id: "E0004" })).state;
  expect(state.verification.test).toMatchObject({ status: "passed", freshness: "stale" });
  expect(state.observationGeneration).toBeGreaterThan(0);
});

test.each(["aborted", "error", "length"] as const)(
  "an %s agent end never completes from a true semantic decision",
  (stopReason) => {
    const event: AgentEvent = {
      ...callFixture(),
      type: "agent_end",
      finalText: excerptFixture("done"),
      stopReason,
    };
    const state = transition(initialState(), event, {
      ...emptyDecisions(),
      taskComplete: { value: true, gate: "applied" },
    }).state;
    expect(state.taskStatus).toBe("in_progress");
    expect(state.phase).not.toBe("done");
  },
);
