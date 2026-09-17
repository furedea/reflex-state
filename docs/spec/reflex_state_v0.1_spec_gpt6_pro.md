# ReflexState v0.1 — Implementation Specification (GPT 6 Pro draft)

> **Provenance**
>
> - Author: GPT 6 Pro (OpenAI), generated as a draft specification.
> - Saved: 2026-09-17, verbatim, for the record.
> - Status: **superseded** by `reflex_state_v0.1_spec_claude.md` in this directory,
>   which reviews this draft and is the version to implement against.
> - Nothing below has been edited except this provenance block.

---

## 0. Mission

Build an experimental context/state-management system for long-horizon coding agents inspired by SKILL.state.

The core idea is to decouple state maintenance from the main reasoning model.

Instead of asking the main autoregressive LLM to both:

1. decide the next action, and
2. generate/update persistent execution state,

use a separate fast typed decision model, initially TypeSafe Jev, to maintain most semantic state.

The intended architecture is:

```
                         ┌─────────────────────┐
                         │ Main reasoning LLM  │
Skill + Hot State + O_t ─►                     ├──► next action
                         └─────────────────────┘
                                   ▲
                                   │
                        current hot state only
                                   │
                         ┌─────────┴──────────┐
                         │   State Manager     │
                         │                    │
Latest event + state ───►│ deterministic      │
                         │ + Jev decisions    │
                         │ + future fallback  │
                         └─────────┬──────────┘
                                   │
                                   ▼
                             Hot State Σ_t
```

All original events/messages remain in a cold event/session history.
They are normally excluded from the main LLM context.

The first usable integration should be a Pi coding-agent extension.

However, the state-management core MUST NOT depend on Pi so that it can later be reused in:

- benchmark runners,
- other coding agents,
- standalone agent loops,
- research experiments.

Working project name: reflex-state.

Do not over-engineer branding or publishing yet.

---

## 1. Research Motivation

SKILL.state maintains explicit execution state rather than replaying an ever-growing conversation history.

The research question behind this project is:

> Can execution-state maintenance be decoupled from autoregressive reasoning and delegated to fast typed decision models without degrading agent performance?

A secondary hypothesis is:

> A hybrid of deterministic updates + typed semantic decisions can maintain agent state more cheaply and with lower latency than asking a reasoning LLM to repeatedly regenerate structured state.

This project should therefore make different state updater implementations replaceable.

Long-term comparison conditions may include:

- Full conversation history
- LLM compaction
- Original SKILL.state-style LLM update
- Small generative LLM update
- Jev-only semantic update
- Hybrid deterministic + Jev
- Hybrid deterministic + Jev + reasoning fallback

Do NOT implement all of these in v0.1.

Design interfaces so they can be added later.

---

## 2. Important Design Principle

Never use AI when ordinary code already knows the answer.

Examples:

| Question | Owner |
| --- | --- |
| git modified files | deterministic |
| command exit code == 0 | deterministic |
| test command failed | deterministic |
| current git branch | deterministic |
| whether a later observation semantically resolves an earlier blocker | Jev |
| whether an observation is still relevant to the current task | Jev |
| whether a failure appears environmental vs implementation-related | Jev |

Jev is a semantic transition classifier, NOT a general state generator.

---

## 3. Jev Constraints

Jev does not generate arbitrary strings.

It returns typed decisions such as:

- Choice
- Score
- Noul

Therefore do NOT design the system around Jev producing arbitrary JSON state patches.

Bad architecture:

```
Jev
  ↓
{
  "summary": "The current bug is probably...",
  "plan": "...",
  ...
}
```

Preferred architecture:

```
event E42 exists
Jev:
  Is E42 still relevant? → yes
  Does E42 introduce a blocker? → yes
  Failure category? → dependency
  Does E47 resolve E42? → yes
Reducer:
  activeBlockers.remove(E42)
```

The original observation remains the source of truth.

---

## 4. Event-Backed State

Do NOT repeatedly rewrite observations into summaries if they can instead be referenced.

Conceptually:

```
Cold history
E001 user request
E002 tool call
E003 tool result
E004 edit
E005 test failure
E006 edit
E007 test success
...
             ▲
             │ references
             │
Hot State
phase: testing
taskStatus: in_progress
latestVerification:
    status: passed
    evidence: E007
activeBlockers: []
workingSet:
    - E006
    - E007
```

State should primarily store:

- typed values,
- file paths,
- IDs/references to evidence,
- status values,
- timestamps,
- small metadata.

Avoid generated natural-language summaries in v0.1.

---

## 5. Repository Structure

Use a small monorepo/workspace layout.

Recommended:

```
reflex-state/
├── package.json
├── tsconfig.json
├── README.md
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts
│   │       ├── state.ts
│   │       ├── events.ts
│   │       ├── reducer.ts
│   │       └── updater.ts
│   │
│   ├── typesafe/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── client.ts
│   │       ├── questions.ts
│   │       └── updater.ts
│   │
│   ├── pi/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── extension.ts
│   │       ├── persistence.ts
│   │       ├── projection.ts
│   │       └── commands.ts
│   │
│   └── replay/
│       └── src/
│           ├── index.ts
│           └── replay.ts
│
└── tests/
```

If the existing Pi packaging conventions make a slightly different structure cleaner, adapt it.

Keep these conceptual boundaries:

```
core
↑
├── typesafe
├── pi
└── replay
```

core MUST NOT import Pi or TypeSafe.

---

## 6. Core Types

Start with a coding-agent-oriented state schema rather than trying to make the entire schema dynamically configurable.

Suggested types:

```ts
type EventId = string;
type AgentPhase =
  | "planning"
  | "exploring"
  | "editing"
  | "testing"
  | "debugging"
  | "done"
  | "unknown";
type TaskStatus =
  | "in_progress"
  | "blocked"
  | "completed"
  | "unknown";
type VerificationStatus =
  | "not_run"
  | "running"
  | "passed"
  | "failed"
  | "unknown";
interface EvidenceRef {
  eventId: EventId;
}
interface VerificationState {
  status: VerificationStatus;
  evidence?: EvidenceRef;
}
interface Blocker {
  eventId: EventId;
  category?:
    | "implementation"
    | "environment"
    | "dependency"
    | "test"
    | "permissions"
    | "network"
    | "unknown";
}
interface HotState {
  version: 1;
  phase: AgentPhase;
  taskStatus: TaskStatus;
  modifiedFiles: string[];
  relevantFiles: string[];
  build: VerificationState;
  tests: VerificationState;
  lint: VerificationState;
  activeBlockers: Blocker[];
  workingSet: EventId[];
  lastUpdatedAt: string;
}
```

Do not treat this exact schema as sacred.

Improve it if necessary, but keep v0.1 intentionally small.

---

## 7. Normalized Events

Create a provider-independent normalized event representation.

Example:

```ts
type AgentEvent =
  | UserPromptEvent
  | ToolCallEvent
  | ToolResultEvent
  | FileChangeEvent
  | VerificationEvent;
interface BaseEvent {
  id: EventId;
  timestamp: string;
}
interface UserPromptEvent extends BaseEvent {
  type: "user_prompt";
  text: string;
}
interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}
interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  outputText?: string;
}
interface FileChangeEvent extends BaseEvent {
  type: "file_change";
  paths: string[];
}
interface VerificationEvent extends BaseEvent {
  type: "verification";
  kind: "build" | "test" | "lint";
  status: "passed" | "failed";
  sourceEventId?: EventId;
}
```

Do not duplicate arbitrarily huge tool output into multiple stores.

Preserve enough information for semantic classification and evidence lookup.

Use bounded excerpts / stable session references / hashes where appropriate.

---

## 8. State Update Pipeline

State updates should have three conceptual layers:

1. deterministic extraction
2. semantic decisions
3. deterministic reducer

Example:

```
tool result:
    pytest failed
        │
        ├── deterministic
        │     tests.status = failed
        │
        └── Jev
              category =
                implementation
                environment
                dependency
                test
                permissions
                network
                unknown
        ↓
Reducer
tests.status = failed
activeBlockers += {
    eventId: E42,
    category: dependency
}
```

The reducer owns mutation of HotState.

Jev should return decisions, NOT mutate state directly.

---

## 9. Updater Interface

Define a replaceable interface.

For example:

```ts
interface StateUpdateContext {
  state: HotState;
  event: AgentEvent;
}
interface StateDecision {
  // semantic decisions only
}
interface StateUpdater {
  evaluate(
    context: StateUpdateContext,
    signal?: AbortSignal
  ): Promise<StateDecision>;
}
```

Then:

```
Deterministic extraction
+
StateUpdater
+
Reducer
```

For v0.1 implement:

- JevStateUpdater

Also provide:

- NoopStateUpdater

for tests and deterministic-only operation.

Do not implement the LLM updater yet unless it falls out trivially.

---

## 10. Initial Jev Decisions

Do NOT ask one vague question like:

> Update the agent state.

Use small atomic questions.

Candidate decisions:

**Phase** — Choice:

> What phase is the coding task currently in?
> planning / exploring / editing / testing / debugging / done / unknown

**Task status** — Choice:

> in_progress / blocked / completed / unknown

**Failure category** — only ask when relevant:

> implementation / environment / dependency / test / permissions / network / unknown

**Blocker introduction** — Noul:

> Does the latest event introduce a currently unresolved blocker?

**Blocker resolution** — for each currently active blocker, when useful:

> Does the latest event resolve or supersede blocker E42?

**Relevance** — for candidate working-set events:

> Is event E42 still relevant to the agent's current task?

Avoid excessive Jev calls.

Batch independent questions that share the same state into one System One request where practical.

---

## 11. Jev Input

Construct Jev input from:

```
Current typed HotState
+
latest normalized event
+
small amount of directly related evidence
+
brief schema semantics
```

Do NOT send the whole Pi conversation.

Example conceptual input:

```json
{
  "current_state": {
    "phase": "testing",
    "taskStatus": "in_progress",
    "tests": {
      "status": "failed",
      "evidence": { "eventId": "E41" }
    },
    "activeBlockers": [
      {
        "eventId": "E41",
        "category": "implementation"
      }
    ]
  },
  "latest_event": {
    "id": "E42",
    "type": "tool_result",
    "toolName": "bash",
    "isError": false,
    "outputText": "19 passed"
  }
}
```

Use structured JSON state if supported cleanly by the current SDK.

---

## 12. TypeSafe Integration

Use the current official JavaScript/TypeScript TypeSafe SDK if practical.

Before implementation:

1. inspect the currently installed/current official SDK API;
2. do not invent package names or SDK methods;
3. pin a sensible dependency version;
4. use TYPESAFE_API_KEY from the environment;
5. default model should be configurable, with jev-latest as the initial default.

If the SDK becomes unnecessarily awkward, isolate all API interaction behind:

```
TypeSafeSystemOneClient
```

so it can later be replaced with direct HTTP calls.

No API-specific objects should leak into core.

---

## 13. Confidence Handling

Do not blindly apply every semantic decision.

Implement a configurable confidence policy.

Example config shape:

```ts
interface ReflexStateConfig {
  jevModel: string;
  minChoiceConfidence: number;
  noulAcceptThreshold: number;
  noulRejectThreshold: number;
  enabled: boolean;
}
```

For Noul:

```
p >= accept threshold
→ yes
p <= reject threshold
→ no
otherwise
→ uncertain
```

For uncertain decisions:

- DO NOT guess.
- DO NOT mutate semantic state.
- Keep the previous value and record an uncertain transition.

Threshold defaults may initially be heuristic.

Document this clearly.

Do not make scientific calibration claims from arbitrary thresholds.

---

## 14. Failure Behavior

ReflexState MUST NOT make Pi unusable when Jev fails.

If:

- API unavailable
- timeout
- authentication error
- rate limit
- invalid response

then:

1. log the failure
2. continue with deterministic updates only
3. keep previous semantic state
4. do not block the coding agent

v0.1 should be fail-open.

Expose Jev health in `/state stats`.

---

## 15. Pi Integration

Implement the first adapter as a Pi extension.

Use Pi's actual current extension APIs.

Relevant capabilities to inspect/use include:

- context event
- tool execution / tool result events
- before_agent_start or equivalent user-turn event
- appendEntry()
- session_start
- registerCommand()
- setWidget()/setStatus() where useful

Do not assume API signatures from this specification if the installed Pi version differs.

Check the current Pi types/docs/examples.

---

## 16. Pi Session Persistence

Persist ReflexState data using Pi extension/session persistence rather than an unrelated database for v0.1.

Persist at minimum:

- current HotState
- state transitions
- ReflexState configuration/version metadata

Use custom Pi session entries where appropriate.

On:

- session restart
- session resume
- extension reload

reconstruct the most recent HotState correctly.

Do not inject persistence metadata into the LLM context.

---

## 17. Cold History vs Hot State

Pi remains the authoritative cold session history.

ReflexState does NOT delete original session data.

Instead:

```
Pi session history
= cold history
HotState
= small projected execution state
```

The user should still be able to inspect the original conversation/session using normal Pi facilities.

Context filtering is non-destructive.

---

## 18. Context Projection

This is the most important Pi-specific feature.

Before each main LLM request, construct a compact context roughly equivalent to:

```
system prompt / loaded skill instructions
ReflexState:
    current HotState
current user turn / latest unresolved interaction
latest observation required for the next action
```

Older transcript messages should normally be excluded from the provider request.

However:

**CRITICAL**

Never create an invalid provider conversation.

Tool calls and tool results may require matching messages.

Preserve any message/tool-call group required for provider validity.

Do not naively delete individual messages without understanding Pi's message format.

For v0.1, use a conservative projection:

```
state injection
+
current user turn
+
current active assistant/tool exchange
```

rather than trying to perfectly minimize every token immediately.

The original Pi session remains unchanged.

---

## 19. State Injection

Inject HotState in a compact machine-readable representation.

Example:

```
<reflex-state>
phase: debugging
task_status: in_progress
modified_files:
- src/auth/session.ts
tests:
  status: failed
  evidence: E42
active_blockers:
- event: E42
  category: implementation
</reflex-state>
```

Do not include internal Jev confidence metadata unless useful to the main agent.

The state should describe what is currently believed, not the full history.

---

## 20. Do Not Accidentally Hide the User's Goal

The current user task/instruction must remain available to the main LLM.

For v0.1, preserve the latest relevant user prompt verbatim.

Do not rely on Jev to summarize or recreate it.

Eventually the system may support explicit goal state, but do not make lossy goal compression mandatory now.

---

## 21. Working Set

Maintain a bounded set of event references representing currently relevant evidence.

For example:

```ts
workingSet: EventId[]
```

Initially enforce a configurable cap, e.g.:

```
maxWorkingSetEvents = 16
```

When capacity is exceeded:

1. prefer removing events already superseded deterministically;
2. use Jev relevance decisions if needed;
3. never delete the cold history;
4. only remove references from the hot state.

---

## 22. Concurrency

Jev exists partly because it is expected to be cheap and fast.

Do not unnecessarily put every Jev request on the critical path.

Where lifecycle semantics allow it:

```
Main LLM request
and
state semantic classification
```

should overlap.

However, correctness is more important than premature concurrency.

For v0.1:

1. implement correct sequential behavior first;
2. isolate the state update pipeline behind async interfaces;
3. add safe parallelism only where state races cannot occur.

Use a serialized state-transition queue if necessary.

Never let two asynchronous state updates overwrite each other nondeterministically.

---

## 23. State Transition Log

Record every state transition.

Suggested structure:

```ts
interface StateTransitionRecord {
  id: string;
  timestamp: string;
  triggeringEventId: EventId;
  before: HotState;
  after: HotState;
  deterministicChanges: string[];
  semanticDecisions: {
    name: string;
    value: unknown;
    confidence?: number;
    probability?: number;
    applied: boolean;
  }[];
  jevLatencyMs?: number;
  inputTokens?: number;
  error?: string;
}
```

For large states, storing full before/after snapshots forever may become wasteful.

For v0.1 this is acceptable if state remains small.

If easy, store a patch plus periodic snapshots instead.

---

## 24. Metrics

Collect enough instrumentation for later research.

At minimum:

- Jev requests
- Jev failures
- Jev latency
- Jev input tokens
- semantic decisions made
- uncertain decisions
- state transitions
- context messages before projection
- context messages after projection
- approximate context tokens if easily available

Expose:

```
/state stats
```

Example:

```
ReflexState
events:                 47
state transitions:      31
jev calls:              24
jev failures:            0
uncertain decisions:     3
jev latency:
  mean:  132 ms
  p50:   110 ms
  p95:   280 ms
input tokens:
  jev:   8,412
working set:
  7 / 16
```

Do not fabricate token counts if the SDK does not return them.

---

## 25. Pi Commands

Implement:

- `/state` — Show current HotState.
- `/state history` — Show recent state transitions.
- `/state stats` — Show metrics.
- `/state reset` — Reset ReflexState state for the current session after confirmation.

Optional if easy:

- `/state debug` — Show last Jev decision details.

---

## 26. TUI

A small status indicator/widget is useful but secondary.

Example:

```
ReflexState: debugging | tests failed | blockers 1 | Jev 124ms
```

Do not spend substantial time on UI polish in v0.1.

Correct state behavior and observability matter more.

---

## 27. Configuration

Support project-local configuration if Pi provides a clean trusted-project mechanism.

Suggested config:

```json
{
  "enabled": true,
  "model": "jev-latest",
  "maxWorkingSetEvents": 16,
  "minChoiceConfidence": 0.65,
  "noulAcceptThreshold": 0.8,
  "noulRejectThreshold": 0.2,
  "contextProjection": true
}
```

Exact defaults can change.

Validate configuration.

Never store API keys in project config.

---

## 28. Security / Privacy

Do not log:

- TYPESAFE_API_KEY
- provider API keys
- authentication headers

Be careful with tool output because repository contents may contain secrets.

For v0.1 document clearly that semantic events sent to Jev may contain source code/tool output.

Provide an obvious way to disable Jev:

```
REFLEX_STATE_DISABLE_JEV=1
```

or equivalent config.

---

## 29. Testing

Use unit tests heavily for core.

Required categories:

**Reducer tests** — Given: state + deterministic facts + semantic decision, verify exact next state.

**Confidence tests** — Verify uncertain decisions do not mutate state.

**Failure tests** — API failure must preserve semantic state and allow deterministic updates.

**Persistence tests** — State survives simulated reload/resume.

**Projection tests** — Verify old history is filtered while required current messages remain. Pay special attention to tool-call/tool-result pairing.

**Replay tests** — Given a deterministic recorded event sequence (E1, E2, E3, ...), replaying it must result in the same HotState.

---

## 30. Replay Harness

Implement a small offline replay utility.

Input:

```
{"id":"E1", ...}
{"id":"E2", ...}
{"id":"E3", ...}
```

Run:

```
initial state
→ event 1
→ updater
→ reducer
→ event 2
...
```

Output:

- final state
- transition log
- latency metrics
- TypeSafe usage

This will later become the basis for research evaluation.

Do not build a large benchmark framework yet.

---

## 31. README

README should explain the architecture succinctly.

Include this conceptual distinction:

```
Cold history
    everything that happened
Hot state
    what the agent currently needs to know
```

And:

```
Reasoning model:
    What should I do next?
Jev:
    What is currently true / relevant / active?
Code:
    How should those decisions mutate state?
```

Be explicit that this is currently experimental.

Do not claim improved accuracy, latency, or cost until measured.

---

## 32. Non-Goals for v0.1

Do NOT implement:

- arbitrary user-defined state schemas;
- multi-agent shared state;
- vector databases;
- embedding retrieval;
- complex RAG;
- automatic natural-language summarization;
- full SKILL.state paper reproduction;
- Claude Code adapter;
- Codex adapter;
- OpenCode adapter;
- distributed event stores;
- cloud synchronization;
- elaborate benchmark suites;
- automatic paper figures;
- a reasoning-model fallback.

Design interfaces so some of these can be added later.

---

## 33. Implementation Order

Implement in this order.

**Phase A — Core**

1. Event types
2. HotState
3. deterministic extraction
4. StateUpdater interface
5. reducer
6. transition records
7. unit tests

No Pi and no API dependency here.

**Phase B — Jev**

1. TypeSafe client wrapper
2. atomic question definitions
3. JevStateUpdater
4. confidence gating
5. error handling
6. mocked API tests

**Phase C — Pi**

1. Extension skeleton
2. event normalization
3. persistence
4. /state
5. context projection
6. /state history
7. /state stats
8. optional widget

**Phase D — Replay**

1. JSONL event loader
2. updater replay
3. metrics output

---

## 34. Acceptance Criteria

v0.1 is complete when all of the following are true.

**Functional**

- The Pi extension loads without patching Pi itself.
- A normal coding session generates normalized ReflexState events.
- Build/test status can update deterministically.
- Jev performs at least phase/failure/blocker semantic decisions.
- HotState persists across Pi session resume/reload.
- /state displays current state.
- /state history displays transitions.
- /state stats displays actual collected metrics.
- Jev failure does not break the Pi agent loop.
- Context projection removes older history from provider context while preserving the underlying Pi session.
- Tool-call/tool-result message structure remains valid.

**Architectural**

- core has no Pi dependency.
- core has no TypeSafe dependency.
- TypeSafe API use is isolated.
- State mutation occurs in the reducer.
- Jev does not generate free-form state.
- Cold history is never destructively deleted.

**Quality**

Run:

- typecheck
- lint
- tests

All must pass.

Avoid unnecessary dependencies.

Prefer straightforward TypeScript over framework-heavy abstractions.

---

## 35. Important Research Constraint

Do not optimize specifically for one cherry-picked demo trace.

The implementation should expose:

- StateUpdater
- Reducer
- Event stream
- Metrics
- Replay

as clean independent components so we can later compare state-management strategies under identical traces.

The eventual experimental question is about state-management architecture, not about whether we can prompt-engineer one Jev call until a demo works.

---

## 36. First Deliverable

Before attempting advanced context compression, produce a working vertical slice:

```
Pi tool result
      ↓
normalized AgentEvent
      ↓
deterministic extraction
      ↓
Jev semantic classification
      ↓
reducer
      ↓
HotState
      ↓
persisted with Pi
      ↓
visible via /state
```

Then add context projection.

Do not attempt everything simultaneously.

---

## 37. Development Instructions

Before editing code:

1. inspect the latest Pi extension documentation/types/examples;
2. inspect the latest TypeSafe JavaScript SDK documentation/types;
3. inspect package manager / workspace conventions;
4. write a short implementation plan in PLAN.md.

Then implement incrementally.

After the implementation is complete:

1. run all tests;
2. run typecheck/lint;
3. perform a real Pi smoke test if possible;
4. document anything that could not be verified;
5. update the README;
6. remove PLAN.md if it only contains temporary implementation planning.

Do not silently weaken requirements to make tests pass.

If an API assumption in this specification is inconsistent with the current Pi or TypeSafe implementation, use the current official API and document the deviation.

---

## 38. Desired Result

At the end I should be able to run Pi with ReflexState enabled, perform a multi-step coding task, and inspect something like:

```
/state
phase: debugging
taskStatus: in_progress
modifiedFiles:
  - src/auth/session.ts
tests:
  status: failed
  evidence: E42
activeBlockers:
  - E42
    category: implementation
workingSet:
  - E38
  - E41
  - E42
```

while the full original Pi session remains available but is not necessarily replayed to the main reasoning model on every step.

This working implementation will serve as both:

1. a usable experimental Pi context-management extension; and
2. the foundation for a research evaluation of System-One-managed execution state.
