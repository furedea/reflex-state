# ReflexState v0.1 — Implementation Specification (reviewed edition)

> **Provenance**
>
> - Author: Claude (Fable 5.1), 2026-09-17.
> - Basis: a review of the GPT 6 Pro draft stored as
>   `reflex_state_v0.1_spec_gpt6_pro.md` in this directory, cross-checked against the
>   actually installed Pi (`pi 0.83.0`, package `@earendil-works/pi-coding-agent`), the
>   published TypeSafe JavaScript SDK (`@typesafe-ai/sdk` 0.6.0, HTTP `POST /v1/systemone`),
>   and the SKILL.state paper (arXiv:2608.26263).
> - Status: **authoritative for v0.1**. Where this document and the GPT draft disagree,
>   this document wins. Appendix A lists every deliberate deviation and why.
> - Anything marked **VERIFY** is an assumption that must be confirmed during Phase 0
>   before code depends on it.

---

## Part I — Intent

### 1. Mission

Build an experimental context/state-management layer for long-horizon coding agents,
inspired by SKILL.state, in which **execution-state maintenance is decoupled from the
reasoning model**.

```
                          ┌──────────────────────┐
 system prompt            │  Main reasoning LLM  │
 + <reflex-state>  ──────►│  "what next?"        ├──► next action
 + current run            └──────────────────────┘
                                     ▲
                                     │ projected context (ephemeral)
                                     │
                          ┌──────────┴───────────┐
 raw event ──────────────►│ extract (pure code)  │
                          │ decide  (Jev, typed) │
                          │ reduce  (pure code)  │
                          └──────────┬───────────┘
                                     ▼
                              HotState Σ_t  ── persisted as Pi custom entries
 Pi session (JSONL, append-only tree) = cold history, never modified
```

Three roles, kept strictly apart:

| Role                      | Question it answers                         | Implemented by                      |
| ------------------------- | ------------------------------------------- | ----------------------------------- |
| Reasoning model           | What should I do next?                      | Pi's configured LLM                 |
| Jev (TypeSafe System One) | What is currently true / active / relevant? | typed Choice / Score / Noul answers |
| Code                      | How do those facts mutate state?            | pure extraction + pure reducer      |

First adapter: a **Pi extension**. The core must stay reusable for replay, benchmarks
and other agents, so core has **no Pi and no TypeSafe imports**.

Working name: `reflex-state`. No branding or publishing work in v0.1.

### 2. Research framing

Primary question:

> Can execution-state maintenance be delegated to a fast typed decision model plus
> deterministic code without degrading agent performance, compared with (a) full
> history and (b) reasoning-LLM-generated state?

Secondary hypothesis:

> Hybrid deterministic + typed decisions is cheaper and lower-latency than asking a
> generative model to regenerate structured state on every step.

v0.1 must therefore produce **comparable artifacts under identical traces**: a raw event
stream, a replaceable `StateUpdater`, a pure reducer, a transition log with recorded raw
decisions, and metrics. The comparison conditions themselves (full history, LLM
compaction, SKILL.state-style LLM update, small generative model, Jev-only, hybrid,
hybrid + fallback) are **not** implemented in v0.1; only the seams for them are.

Nothing in v0.1 may claim improved accuracy, cost or latency. It measures; it does not
conclude.

### 3. Design principles (binding)

1. **Code before AI.** If ordinary code knows the answer, Jev is not asked. §9 fixes
   ownership per state field; a Jev question outside that table is a spec violation.
2. **Typed decisions only.** Jev returns Choice / Score / Noul. It never produces state
   patches, summaries or free text. Decisions are inputs to the reducer.
3. **Event-backed state.** HotState stores typed values, paths, IDs, statuses and
   bounded verbatim excerpts. No generated natural-language summaries.
4. **Pure core.** Extraction and reduction are pure functions of `(state, event, facts,
decisions, clock)`. No I/O, no ambient time. This is what makes replay exact.
5. **Fail-open.** Any Jev failure degrades to deterministic-only updates. Pi must never
   become unusable because of ReflexState.
6. **Cold history is sacred.** Pi's session file is never edited or truncated. Context
   projection is an ephemeral view built per request.
7. **Uncertain means unchanged.** A gated decision that does not clear its threshold
   leaves the previous value in place and is logged as uncertain.
8. **Measure honestly.** Never fabricate token counts or latencies. If a source does not
   report a number, the metric is absent, not zero.

---

## Part II — Core (no Pi, no TypeSafe)

### 4. Repository layout

The repository is already a single-package TypeScript template (pnpm, oxlint/oxfmt,
vitest with colocated `*.test.ts`, knip, ls-lint). v0.1 keeps a **single package** and
enforces boundaries by directory plus lint, rather than introducing a workspace:

```
reflex-state/
├── src/
│   ├── core/          # types, events, extraction, reducer, updater interface, metrics
│   ├── typesafe/      # TypeSafe client wrapper, question builders, JevStateUpdater
│   ├── pi/            # Pi extension: normalization, persistence, projection, commands
│   ├── replay/        # JSONL loader, replay runner, report
│   └── index.ts       # public re-exports of core
├── docs/spec/         # this document and the GPT draft
└── .pi/extensions/    # optional thin loader shim for `pi` in this repo (see §17)
```

Boundary rules (enforced by an oxlint `no-restricted-imports` override scoped to
`src/core/**`, plus a unit test that scans import specifiers):

- `src/core` imports nothing from `src/pi`, `src/typesafe`, `src/replay`,
  `@earendil-works/*`, `@typesafe-ai/*`.
- `src/typesafe`, `src/pi`, `src/replay` import from `src/core` only (never from each other).

Naming follows the repo's ls-lint: directories kebab-case, files snake_case. Tests are
colocated (`foo.test.ts`), as the template's vitest config already expects.

Moving to a pnpm workspace later is a mechanical change and is explicitly deferred.

### 5. Identifiers and references

```ts
type EventId = `E${string}`; // "E0001", zero-padded, session-monotonic

interface SourceRef {
  // how to find the original in cold history
  kind: "tool_call" | "user_prompt" | "assistant_message";
  toolCallId?: string; // join key into Pi ToolResultMessage.toolCallId
  timestamp: number; // Pi message timestamp (ms)
}
```

Event IDs are assigned by ReflexState from a persisted counter (`cursor.eventCount`),
never derived from Pi entry IDs: at `tool_result` time the Pi session entry does not yet
exist. `SourceRef.toolCallId` is the stable join key back into the Pi session.

### 6. Raw events (the recorded stream)

Replay input is **raw events only**. Everything else (file changes, verification
outcomes, exit codes) is _derived_ by pure extraction so that different strategies can be
compared on the same trace.

```ts
type AgentEvent =
  | UserPromptEvent
  | ToolCallEvent
  | ToolResultEvent
  | AgentEndEvent
  | FileChangeEvent; // optional: for adapters that have native file-change signals.
// The Pi adapter does NOT emit it (derived instead).

interface BaseEvent {
  id: EventId;
  timestamp: string;
  turnIndex: number;
  source: SourceRef;
}

interface UserPromptEvent extends BaseEvent {
  type: "user_prompt";
  text: string; // verbatim, bounded (limits.maxPromptChars, head+tail)
}
interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>; // bounded: long string fields are excerpted
}
interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  excerpt: Excerpt; // see below
}
interface AgentEndEvent extends BaseEvent {
  type: "agent_end";
  finalText: Excerpt; // last assistant text of the run
  stopReason: "stop" | "length" | "error" | "aborted";
}
interface Excerpt {
  head: string; // first N chars
  tail?: string; // last M chars when truncated
  totalChars: number;
  sha256: string; // of the full text, for integrity / dedupe
  truncated: boolean;
}
```

Excerpt bounds default to head 1200 / tail 600 chars. Full outputs stay in the Pi session.

### 7. HotState

```ts
type AgentPhase =
  | "planning"
  | "exploring"
  | "editing"
  | "testing"
  | "debugging"
  | "done"
  | "unknown";
type TaskStatus = "in_progress" | "blocked" | "completed" | "unknown";
type VerificationKind = "build" | "test" | "lint";
type VerificationStatus = "not_run" | "running" | "passed" | "failed" | "unknown";
type BlockerCategory =
  | "implementation"
  | "environment"
  | "dependency"
  | "test"
  | "permissions"
  | "network"
  | "unknown";

interface VerificationState {
  status: VerificationStatus;
  evidence?: EventId;
  command?: string;
}

interface Blocker {
  eventId: EventId; // the observation that introduced it
  origin: "verification" | "tool_error"; // decides who may resolve it (§9)
  kind?: VerificationKind; // present when origin === "verification"
  category: BlockerCategory; // "unknown" until Jev classifies it
}

interface HotState {
  version: 1;
  goal: EventId | null; // latest user prompt; text lives in the event store
  phase: AgentPhase;
  taskStatus: TaskStatus;
  modifiedFiles: string[]; // sorted, unique, cap 64
  relevantFiles: string[]; // LRU, cap 32
  verification: Record<VerificationKind, VerificationState>;
  activeBlockers: Blocker[]; // cap limits.maxActiveBlockers (8)
  workingSet: EventId[]; // cap limits.maxWorkingSetEvents (16), ordered oldest→newest
  cursor: {
    lastEventId: EventId | null;
    eventCount: number;
    turnIndex: number;
  };
  lastUpdatedAt: string;
}
```

Differences from the GPT draft, and why:

- `goal` is explicit so "never hide the user's goal" (§16) is a state invariant, not a
  projection heuristic.
- `Blocker.origin`/`kind` exist so verification-originated blockers are **resolved by
  code** when the same verification later passes (§9). Only tool-error blockers need Jev.
- `cursor` is what makes resume and replay exact.
- `taskStatus` is stored but its transitions are fixed by the reducer (§9); Jev supplies
  only the `task_complete` Noul at `agent_end`.

### 8. Deterministic extraction

`extractFacts(state, event): DeterministicFacts` — pure, total, never throws.

```ts
interface DeterministicFacts {
  fileChanges: string[]; // edit/write tool inputs (path)
  filesRead: string[]; // read tool inputs
  exitCode?: number; // bash: parsed from "Command exited with code N"
  verification?: {
    kind: VerificationKind;
    status: "running" | "passed" | "failed" | "unknown";
    command: string;
    compound: boolean; // command had &&, ;, | or || segments
  };
  phaseProposal: AgentPhase | null; // rule-based, see §9
  deterministicallyResolved: EventId[]; // blockers resolved by code
  supersededInWorkingSet: EventId[]; // older evidence made obsolete by this event
}
```

Rules that are in scope for v0.1:

- **Exit code.** Pi's bash tool appends `Command exited with code N` to the output and
  sets `isError` on non-zero exit. Exit 0 ⇒ `isError === false`. Parse the trailing
  status line; absent ⇒ `exitCode` undefined.
- **Verification classifier.** A regex table maps a bash command to a
  `VerificationKind` (tests: pytest/vitest/jest/cargo test/go test/npm|pnpm|yarn|bun
  test/…; build: tsc/cargo build/go build/npm|pnpm run build/typecheck/…; lint:
  eslint/oxlint/biome/ruff/clippy/golangci-lint/npm|pnpm run lint/…). Projects may extend
  it via `verificationCommands` (§21). At `tool_call` ⇒ `running`; at `tool_result`
  exit 0 ⇒ `passed`, non-zero ⇒ `failed`, unknown exit ⇒ `unknown`. A compound command
  is classified if **any** segment matches and is flagged `compound: true`.
- **Files.** `edit`/`write` inputs ⇒ `fileChanges`; `read` inputs ⇒ `filesRead`. Paths are
  normalised relative to the session cwd. Bash-driven mutations are _not_ tracked in
  v0.1 (documented limitation; a `git status` probe is a v0.2 candidate).
- **Superseding.** A newer verification of kind K supersedes older K results in the
  working set; a newer change to path P supersedes older changes to P; a passed
  verification supersedes the failed one it fixes.

### 9. Decision ownership (the core of "code before AI")

| State field / transition                  | Owner                         | Trigger and rule                                                                                                                                                       |
| ----------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modifiedFiles`, `relevantFiles`          | code                          | §8                                                                                                                                                                     |
| `verification.*`                          | code                          | §8 classifier + exit code                                                                                                                                              |
| `phase` proposal                          | code                          | `read/grep/find/ls` ⇒ exploring; `edit/write` ⇒ editing; verification `running` ⇒ testing; verification `failed` ⇒ debugging; `user_prompt` ⇒ planning; otherwise keep |
| `phase = done`                            | Jev Noul `task_complete`      | at `agent_end`, with `finalText` as evidence                                                                                                                           |
| `phase` (full Choice)                     | Jev **shadow**                | asked and logged, never applied (agreement measurement, §12)                                                                                                           |
| `taskStatus`                              | code                          | `user_prompt` ⇒ in_progress; any active blocker ⇒ blocked; none ⇒ in_progress; `task_complete` accepted ⇒ completed                                                    |
| blocker introduced                        | Jev Noul `blocker_introduced` | only when `isError` **or** verification `failed`                                                                                                                       |
| blocker `category`                        | Jev Choice `failure_category` | same request as above; applied only if the blocker is introduced (verification failures always introduce a blocker deterministically, Jev only classifies)             |
| blocker resolved (`origin: verification`) | code                          | same `kind` later `passed`                                                                                                                                             |
| blocker resolved (`origin: tool_error`)   | Jev Noul `resolves_<id>`      | on a non-error `tool_result` or passed verification; ≤ 8 per request                                                                                                   |
| working-set admission                     | code                          | admit: error results, verification results, file changes; never `read` results; goal is not in the working set                                                         |
| working-set eviction                      | code → Jev → code             | 1) superseded (§8); 2) resolved-blocker evidence; 3) Jev Noul `relevant_<id>` for the oldest ≤ 4 candidates; 4) oldest first                                           |

Consequences: `read`, `grep`, `find`, `ls` results and every non-verification successful
bash result with no active tool-error blockers trigger **zero** Jev calls. Most events
cost nothing.

### 10. Updater interface

```ts
interface StateUpdateContext {
  state: HotState;
  event: AgentEvent;
  facts: DeterministicFacts; // updater may only ask what facts make relevant
  evidence: ReadonlyMap<EventId, AgentEvent>; // events referenced by state (blockers, working set, goal)
  config: ReflexStateConfig;
}

type Gate = "applied" | "uncertain" | "skipped" | "error";

interface GatedDecision<T> {
  value: T | null;
  gate: Gate;
  probability?: number; // noul p(yes)
  confidence?: number; // choice/score peakedness
  probabilities?: Record<string, number>; // choice distribution, kept for offline threshold sweeps
  shadow?: boolean; // asked but never applied
}

interface SemanticDecisions {
  blockerIntroduced?: GatedDecision<boolean>;
  failureCategory?: GatedDecision<BlockerCategory>;
  resolvedBlockers: Array<{
    eventId: EventId;
    decision: GatedDecision<boolean>;
  }>;
  relevance: Array<{ eventId: EventId; decision: GatedDecision<boolean> }>;
  taskComplete?: GatedDecision<boolean>;
  phaseShadow?: GatedDecision<AgentPhase>;
  telemetry: {
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    error?: string;
    questionsAsked: number;
  };
}

interface StateUpdater {
  readonly name: string;
  evaluate(ctx: StateUpdateContext, signal?: AbortSignal): Promise<SemanticDecisions>;
}
```

v0.1 ships three updaters:

- `NoopStateUpdater` — returns empty decisions (deterministic-only baseline).
- `JevStateUpdater` — §13–§14.
- `RecordedDecisionsUpdater` — replays decisions from a transition log keyed by
  `(eventId, questionId)`; the basis for exact offline replay (§25).

### 11. Reducer

`reduce(state, event, facts, decisions, now): { state: HotState; changes: string[] }` —
pure. It is the **only** place HotState is constructed. Order of application:

1. cursor / timestamps;
2. deterministic facts (files, verification, phase proposal, deterministic resolutions,
   working-set supersession);
3. applied semantic decisions (never `uncertain`, `skipped`, `error` or `shadow`);
4. derived `taskStatus`;
5. caps (blockers, working set, file lists), evicting per §9.

`changes` is a list of human-readable strings (`"verification.test: running -> failed
(E0042)"`) used by `/state history` and by tests.

### 12. Transition log

One record per processed event, even when nothing changed.

```ts
interface StateTransitionRecord {
  id: string; // "T0042"
  timestamp: string;
  event: AgentEvent; // the raw event (bounded), so the log is self-contained
  after: HotState; // `before` = previous record's `after`
  deterministicPhase?: AgentPhase; // comparison target before semantic completion
  changes: string[];
  decisions: SemanticDecisions; // includes raw probabilities and shadow answers
  updater: string;
  config: ReflexStateConfig; // effective configuration for this event
  cwd: string; // original extraction root for exact recorded replay
  projection?: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
  };
}
```

Storing only `after` halves the volume versus before/after pairs. Patches plus periodic
snapshots are a v0.2 optimisation, to be introduced only if session files grow
uncomfortably (estimate: 2–6 KB per record).

The log is the research artifact: raw Jev probabilities allow **threshold sweeps offline**
without re-calling the API, and shadow answers give deterministic-vs-Jev agreement rates.

---

## Part III — Jev (TypeSafe System One)

### 13. Verified API surface (2026-09-17)

- Package: `@typesafe-ai/sdk` **0.6.0** (2026-09-15; first public 0.5.7 on 2026-09-11).
  Node ≥ 20. Pin exactly. Jev itself is **early access** (opened 2026-09-15); access
  and pricing may change. Development must not require a key (§14, §25).
- Client: `new TypeSafeClient({ apiKey?, baseURL?, defaultModel?, timeout?, retry?, fetch?, logger?, logLevel? })`.
  Env fallbacks: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`
  (default `jev-latest`), `TYPESAFE_LOG_LEVEL`.
- Call: `client.systemOne({ state, questions, model? }, { signal?, timeout?, retry?, headers? })`
  → `{ answers, model, usage: { input_tokens, output_tokens } }`.
- Questions are a map `id → { type, instructions, criteria }`:
  Choice `criteria: Record<key, description>` → `{ choice, probabilities, confidence }`;
  Score `criteria: string[]` (ordered levels) → `{ score, legend, probabilities, confidence }`;
  Noul `criteria?: { true?, false? }` → `{ noul: p(yes) }` (no confidence field).
- `state` may be a string, object or array. Answers within one request are independent
  of each other. Budget ≈ 32k tokens shared by state and questions.
- Defaults that are **unsafe on the agent's critical path**: `timeout` 10 000 ms per
  attempt and `retry.maxRetries` 2 with backoff up to 5 s ⇒ worst case > 30 s per event.
  §14 overrides them.
- Error classes: `AuthenticationError`, `RateLimitError`, `APITimeoutError`,
  `APIConnectionError`, `BadRequestError`, `UnprocessableEntityError`,
  `InternalServerError`, base `TypeSafeError`. HTTP: 401 / 422 / 429 / 529.
- `confidence` is a peakedness statistic of the returned distribution (0–1). TypeSafe's
  own guidance: start conservative and tune per domain. Our thresholds are heuristics
  and must be documented as such.

All TypeSafe types stay behind `src/typesafe/client.ts` (`TypeSafeSystemOneClient`
interface with a `systemOne(request, {signal})` method). Core sees only
`SemanticDecisions`. If the SDK becomes awkward, the same interface is re-implemented
over `fetch` against `POST https://api.typesafe.ai/v1/systemone`.

### 14. JevStateUpdater

**One request per event, or none.** Questions are assembled from §9 triggers; if the set
is empty, no call is made. Question IDs are stable: `blocker_introduced`,
`failure_category`, `task_complete`, `phase_shadow`, `resolves_E0042`, `relevant_E0038`.

**Input state** (JSON object, bounded to ≈ 8k tokens, excerpts truncated first):

```json
{
  "schema": { "phase": "…one line per enum value…", "blocker": "…", "verification": "…" },
  "goal": { "id": "E0001", "text": "…verbatim user prompt, ≤ 2000 chars…" },
  "current_state": { "phase": "testing", "taskStatus": "in_progress", "verification": {…}, "activeBlockers": […], "modifiedFiles": […] },
  "latest_event": { "id": "E0042", "type": "tool_result", "toolName": "bash", "command": "pnpm test", "isError": true, "exitCode": 1, "verification": {"kind":"test","status":"failed"}, "excerpt": "…" },
  "evidence": { "E0038": { "type": "tool_result", "excerpt": "…" } }
}
```

Never sent: `read`/`grep`/`find`/`ls` outputs, the Pi conversation, system prompt, API
keys. A redaction pass strips common secret shapes (`sk-…`, `AKIA…`, `-----BEGIN … PRIVATE
KEY`, `Bearer …`, `.env`-style `KEY=value` lines) from excerpts before they leave the
process. README states plainly that source code and command output _do_ leave the
machine when Jev is enabled.

**Gating** (`ReflexStateConfig.thresholds`):

- Noul: `p ≥ noulAccept` ⇒ yes; `p ≤ noulReject` ⇒ no; else `uncertain`.
- Choice: `confidence ≥ minChoiceConfidence` ⇒ applied; else `uncertain`.
  Optional `minChoiceMargin` (top minus runner-up probability); default 0.
- Defaults: `noulAccept 0.8`, `noulReject 0.2`, `minChoiceConfidence 0.65`. Heuristic.
  Uncertain ⇒ previous value kept, record marked uncertain, counted in metrics.

**Critical-path budget** (per event): SDK `timeout` = `jev.timeoutMs` (default 3000),
`retry.maxRetries` = `jev.maxRetries` (default 0), plus an outer `AbortSignal` at
`jev.deadlineMs` (default 4000) chained to Pi's `ctx.signal` so a user abort also cancels
Jev. On deadline ⇒ `gate: "error"`, deterministic-only for that event; the request is
aborted, **not** left to finish in the background (late answers would race the reducer).

**Failure policy** (fail-open):

| Condition                                            | Behaviour                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `AuthenticationError`                                | disable Jev for the session, notify once, stats show `auth_error`      |
| `RateLimitError`, 5xx/529, timeout, connection       | count failure; deterministic-only for this event                       |
| 3 consecutive failures                               | circuit open for `jev.cooldownMs` (60 000); half-open probe afterwards |
| invalid/missing answer field                         | treat as `error`, log the raw response shape (no secrets)              |
| `REFLEX_STATE_DISABLE_JEV=1` or `jev.enabled: false` | `NoopStateUpdater` is used                                             |

Health (`ok / degraded / disabled(reason)`) is exposed in `/state stats` and the widget.

---

## Part IV — Pi adapter

### 15. Verified Pi 0.83.0 surface (installed build)

Events and payloads used (from `dist/core/extensions/types.d.ts`):

| Event                                        | Payload used                                                                                          | Return used                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `session_start`                              | `reason: "startup"\|"reload"\|"new"\|"resume"\|"fork"`                                                | —                                                                       |
| `before_agent_start`                         | `prompt`                                                                                              | — (we do **not** return `message`; that would persist a custom message) |
| `tool_call`                                  | `toolCallId`, `toolName`, `input`                                                                     | — (never block)                                                         |
| `tool_result`                                | `toolCallId`, `toolName`, `input`, `content`, `isError`, `details`                                    | — (never modify)                                                        |
| `agent_end`                                  | `messages` (last assistant message ⇒ `finalText`, `stopReason`)                                       | —                                                                       |
| `context`                                    | `messages: AgentMessage[]` (deep copy)                                                                | `{ messages }`                                                          |
| `message_end`                                | assistant `usage` (`input`, `cacheRead`, `cacheWrite`, `output`) for metrics                          | —                                                                       |
| `session_before_compact` / `session_compact` | set/clear a `compacting` flag (**VERIFY** whether `context` fires for the compaction summariser call) | —                                                                       |

Message shapes (from `@earendil-works/pi-ai` `types.d.ts`):
`UserMessage { role:"user", content: string | (Text|Image)[], timestamp }`,
`AssistantMessage { role:"assistant", content:(Text|Thinking|ToolCall)[], stopReason:
"stop"|"length"|"toolUse"|"error"|"aborted", usage, … }`, `ToolCall { type:"toolCall",
id, name, arguments }`, `ToolResultMessage { role:"toolResult", toolCallId, toolName,
content:(Text|Image)[], isError, timestamp }`. `AgentMessage` may also contain other
roles (custom/bash-execution entries); projection treats them opaquely (§18).

Persistence: `pi.appendEntry(customType, data)` writes a `CustomEntry` that is **not**
part of LLM context and survives restarts and branching. `ctx.sessionManager.getBranch()`
walks leaf → root along the current branch; `getEntries()` returns the whole tree.

Bash exit codes: on non-zero exit the tool result is an error whose text ends with
`Command exited with code N` (from `dist/core/tools/bash.js`).

Commands: `pi.registerCommand(name, { description, handler(args, ctx), getArgumentCompletions })`.
UI: `ctx.ui.setWidget(key, lines)`, `ctx.ui.setStatus(key, text)`, `ctx.ui.confirm(title, msg)`,
`ctx.ui.notify(text, level)`. Trust: `ctx.isProjectTrusted()`; usage: `ctx.getContextUsage()`.
Tools: `pi.registerTool({...})` (for the optional recall tool, §19).

Loading: `pi -e ./src/pi/index.ts`, `.pi/extensions/*.ts` (project, after trust),
`~/.pi/agent/extensions/*.ts`, or a package with `"pi": { "extensions": [...] }`.
Package name for types is `@earendil-works/pi-coding-agent` (not the older
`@mariozechner/…` scope); pin the devDependency to the installed CLI version (0.83.0).
**VERIFY** that this version is published under that scope.

### 16. Event normalization

| Pi hook              | ReflexState event                                                           |
| -------------------- | --------------------------------------------------------------------------- |
| `before_agent_start` | `user_prompt` (sets `goal`, `taskStatus = in_progress`, `phase = planning`) |
| `tool_call`          | `tool_call` (verification ⇒ `running`)                                      |
| `tool_result`        | `tool_result` (excerpt from text content blocks only; images ignored)       |
| `agent_end`          | `agent_end`                                                                 |

Steering / follow-up user messages delivered mid-run also arrive through Pi as user
messages; they are normalised as `user_prompt` and become the new `goal`. The previous
goal text remains reachable via the transition log and `recent_user_requests` (§18).

### 17. Extension skeleton and lifecycle

```ts
export default function reflexState(pi: ExtensionAPI) {
  /* wire hooks, commands, widget */
}
```

- A single `SessionRuntime` per Pi session holds `state`, an in-memory `eventStore`
  (rebuilt from transition entries), metrics and a **serialised transition queue**
  (promise chain). Every hook enqueues; the queue guarantees exactly one in-flight
  reduce per session and preserves event order.
- Hooks await their transition (sequential v0.1). Overlapping Jev with the main LLM
  request is a v0.2 item behind a flag; the queue already makes it race-free.
- On `session_start` (all reasons) the runtime is rebuilt from the branch (§20). On
  `reload` the old instance is discarded; nothing is kept in module scope.
- Config is loaded once per session start (§21); `/state` toggles change the in-memory
  session config only.
- The extension file in this repo is `src/pi/index.ts`; `.pi/extensions/reflex_state.ts`
  may re-export it for convenience when running `pi` inside the repo.

### 18. Context projection (ephemeral, per request)

**Unit of manipulation: the exchange group** — one assistant message together with the
tool-result messages for every `toolCall` it contains. Groups are kept or dropped whole,
so tool-call/tool-result pairing can never break.

**Run boundary.** The current agent run starts after the last assistant message whose
`stopReason` is neither `"toolUse"` nor `"pending"` (an assistant message that ended a previous run). Everything
after that index — the user prompt(s), steers, and exchange groups — is the current run.

**v0.1 projection (`mode: "current-run"`):**

```
projected = [ ...messages of the current run (unchanged, in order) ]
state block appended as a TextContent to the LAST message of the run:
   - a toolResult message ⇒ push { type: "text", text: "<reflex-state>…</reflex-state>" }
   - a user message      ⇒ normalise content to an array and push the block
```

Rationale for appending at the **end**: the block changes after every tool result; placing
it at the head of the run would invalidate the provider prompt cache for the whole run on
every step, potentially making ReflexState _more_ expensive than plain history within long
runs. Appending to the newest message keeps the cached prefix intact. Pi's Anthropic
cache-control marker already targets the last text content, so the placement is
compatible. **VERIFY** per provider (Anthropic, OpenAI-compat, Google) that a tool result
with multiple text blocks round-trips; if a provider rejects it, `projection.placement:
"run-start"` is the documented fallback.

**What is dropped:** all previous runs (their user prompts, assistant text, tool exchanges).
Their information reaches the model only through the state block: verification status
with evidence excerpts, active blockers with excerpts, `recent_user_requests`
(last `limits.maxRecentUserPrompts` prompts, verbatim, bounded), modified files. This is
the SKILL.state trade-off, made explicit and measurable.

**Opaque messages** (roles other than user/assistant/toolResult) inside the current run
are kept in place; outside it they are dropped with the run they belong to. Pi's own
compaction summary, if present, is a message inside `messages` and is kept only if it
falls within the current run. Pi materializes its latest compaction as a `compactionSummary`
message followed by retained entries; see [Phase 0 findings](phase0_findings.md).

**Invariants (tested):** (1) every `toolResult` in the output has its `toolCall` in a
preceding assistant message of the output and vice versa; (2) the output is a
contiguous suffix of the input plus one appended text block; (3) the latest user prompt
is present verbatim; (4) with `projection.enabled: false` the output equals the input.

**Kill switches:** `/state projection off`, `REFLEX_STATE_PROJECTION=0`, config. When the
`compacting` flag is set (§15), projection is bypassed.

**Deferred to v0.2 (designed, not built):** within-run pruning that keeps only exchange
groups referenced by the working set plus the last N groups. Same group unit, same
invariants; deferred because it is where the cache and validity risk concentrates.

### 19. State block and evidence access

```
<reflex-state>
note: Earlier conversation history is not included. This block is the current execution state.
goal: E0001
phase: debugging
task_status: blocked
modified_files:
  - src/auth/session.ts
verification:
  build: { status: passed, evidence: E0031 }
  test:  { status: failed, evidence: E0042, command: "pnpm test" }
  lint:  { status: not_run }
active_blockers:
  - { event: E0042, origin: verification, kind: test, category: implementation }
working_set: [E0038, E0041, E0042]
recent_user_requests:
  - { event: E0001, text: "Fix the session refresh bug and add a regression test" }
evidence_excerpts:
  E0042: |
    FAIL src/auth/session.test.ts > refresh > rotates token
    expected 200 received 401
    … (2 143 chars total, truncated)
</reflex-state>
```

No Jev probabilities or internal metadata are included. Excerpts are verbatim slices, not
summaries. `evidence_excerpts` covers active blockers and the latest failed verification
only, bounded by `limits.maxStateBlockChars` (default 6000).

**Recall tool (optional in v0.1, required in v0.2):** `reflex_recall(eventId)` returns the
full original tool output from the Pi session by `toolCallId` join. It gives the reasoning
model a deterministic way back to cold history after projection. Implementation is small
(`pi.registerTool` + a lookup); include it if the vertical slice is done on schedule.

### 20. Persistence and reconstruction

Custom entry types (all `pi.appendEntry`, none reach the LLM):

| `customType`              | When                                       | Data                                                            |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `reflex-state.meta`       | first transition on a branch that has none | `{ specVersion, stateVersion, config (no secrets), piVersion }` |
| `reflex-state.transition` | every processed event                      | `StateTransitionRecord`                                         |
| `reflex-state.reset`      | `/state reset` confirmed                   | `{ reason }`                                                    |

Reconstruction on `session_start` (any reason) and `session_tree`: walk `getBranch()` root → leaf.
Clear state and the event store at each `reflex-state.reset`, then apply subsequent transition
snapshots and rebuild evidence from their raw events. Numbering resumes above the maximum event
ordinal across the session tree, while restored state comes only from the active branch.
`/tree` navigation, fork and branch-with-summary therefore restore the state belonging to that path.

If no record exists, start from `initialState()`. Never read the whole tree for state.

### 21. Configuration

Resolution order: defaults ← `~/.pi/agent/reflex-state.json` (or
`$PI_CODING_AGENT_DIR/reflex-state.json`) ← `.pi/reflex-state.json`
(only when `ctx.isProjectTrusted()`) ← environment ← `/state` session toggles.

```jsonc
{
  "enabled": true,
  "jev": {
    "enabled": true,
    "model": "jev-latest",
    "timeoutMs": 3000,
    "maxRetries": 0,
    "deadlineMs": 4000,
    "cooldownMs": 60000,
  },
  "thresholds": {
    "noulAccept": 0.8,
    "noulReject": 0.2,
    "minChoiceConfidence": 0.65,
    "minChoiceMargin": 0,
  },
  "limits": {
    "maxWorkingSetEvents": 16,
    "maxActiveBlockers": 8,
    "maxExcerptHeadChars": 1200,
    "maxExcerptTailChars": 600,
    "maxPromptChars": 2000,
    "maxRecentUserPrompts": 3,
    "maxStateBlockChars": 6000,
  },
  "projection": {
    "enabled": true,
    "mode": "current-run",
    "placement": "last-message",
  },
  "shadowQuestions": ["phase"],
  "verificationCommands": { "test": [], "build": [], "lint": [] }, // extra regexes, merged with built-ins
}
```

Environment: `TYPESAFE_API_KEY` (read by the SDK only), `REFLEX_STATE_DISABLE=1`,
`REFLEX_STATE_DISABLE_JEV=1`, `REFLEX_STATE_PROJECTION=0`, `REFLEX_STATE_LIVE_JEV=1`
(enables the live contract test, §24).

Validation: unknown keys are warnings; out-of-range thresholds (`noulReject ≥ noulAccept`,
values outside 0–1) reject the file and fall back to defaults with a notification. API keys
in config files are rejected (key named `apiKey` or a value matching a key shape).

### 22. Commands, widget, metrics

Commands (`pi.registerCommand("state", …)` with argument completions):

| Command                                           | Behaviour                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `/state`                                          | render HotState (YAML-like, as in §19 without the note)                         |
| `/state history [n]`                              | last _n_ (default 10) transitions: id, event, `changes`, gates                  |
| `/state stats`                                    | metrics below                                                                   |
| `/state debug`                                    | the last `SemanticDecisions` incl. raw probabilities and the question IDs asked |
| `/state reset`                                    | `ctx.ui.confirm` then append `reflex-state.reset` and reinitialise              |
| `/state projection on\|off`, `/state jev on\|off` | session-scoped toggles                                                          |

Widget (`ctx.ui.setWidget("reflex-state", [line])`), one line:
`ReflexState debugging | tests failed | blockers 1 | Jev ok 124ms | ctx 41→7 msgs`.

Metrics collected in memory and summarised in `/state stats`:

```
events / transitions / jev calls / jev failures (by class) / circuit state
questions asked (by id) / applied / uncertain / shadow agreement (phase)
jev latency mean, p50, p95 / jev input_tokens, output_tokens (from SDK usage)
projection: messages before→after, chars before→after (per call, mean)
provider usage per LLM call (from AssistantMessage.usage): input, cacheRead, cacheWrite
working set n / cap, blockers n / cap
```

Provider token numbers come from Pi's assistant messages; Jev token numbers from the SDK
`usage`. If a source is missing the line reads `n/a`.

---

## Part V — Quality

### 23. Security and privacy

- Never log `TYPESAFE_API_KEY`, provider keys or `Authorization` headers; the SDK logger
  is set to `warn` and our own logger redacts `Bearer …`.
- Data leaving the machine when Jev is on: user prompt (bounded), bash/edit/write tool
  outputs (bounded excerpts, redacted), file paths, state. Never `read` outputs. Stated in
  README under a "What is sent to TypeSafe" heading.
- Project-local config is read only for trusted projects.
- The recall tool returns only content already present in the local session.

### 24. Testing (Test-Specification-Driven)

Each behaviour below is an independently required observable contract and gets its own
test before the production code that satisfies it. Tests are colocated, deterministic,
and the only network-touching test is opt-in.

| Slice                           | Contract (Given / When / Then)                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction: exit code           | error result ending `Command exited with code 2` ⇒ `exitCode 2`; success ⇒ undefined                                                                                                   |
| Extraction: classifier          | `pnpm test`, `pytest -q`, `cargo test` ⇒ test; `tsc --noEmit` ⇒ build; `oxlint .` ⇒ lint; `a && pnpm test` ⇒ test, `compound: true`; `ls` ⇒ none                                       |
| Extraction: files               | edit/write inputs ⇒ `fileChanges` normalised to cwd; read ⇒ `filesRead`                                                                                                                |
| Reducer: verification lifecycle | tool_call(test) ⇒ running; result exit 1 ⇒ failed + blocker(origin verification) + working set; later exit 0 ⇒ passed, blocker removed by code, old evidence superseded                |
| Reducer: taskStatus derivation  | blocker present ⇒ blocked; removed ⇒ in_progress; `task_complete` applied ⇒ completed; new prompt ⇒ in_progress                                                                        |
| Reducer: caps                   | 17th working-set admission evicts per §9 order; 9th blocker drops oldest with a `changes` entry                                                                                        |
| Gating                          | noul 0.85 ⇒ applied yes; 0.1 ⇒ applied no; 0.5 ⇒ uncertain and state unchanged; choice confidence 0.5 ⇒ uncertain                                                                      |
| Shadow                          | `phaseShadow` present ⇒ never changes `phase`; recorded in the transition                                                                                                              |
| Updater triggers                | read result ⇒ zero questions; error bash result ⇒ `blocker_introduced` + `failure_category`; non-error result with a tool-error blocker ⇒ `resolves_<id>`; agent_end ⇒ `task_complete` |
| Jev failure                     | mock client throws each SDK error class ⇒ deterministic changes applied, semantic state unchanged, telemetry.error set, circuit opens after 3                                          |
| Jev deadline                    | mock client never resolves ⇒ evaluate rejects/aborts within `deadlineMs`, event still reduced                                                                                          |
| Redaction                       | excerpt containing `sk-…`, `AKIA…`, PEM header ⇒ removed before request                                                                                                                |
| Persistence                     | append transitions on branch A, branch to B, append more, resume on A ⇒ state of A; `/state reset` ⇒ initial state, cold entries intact                                                |
| Projection: pairing             | three runs with multi-tool assistant messages ⇒ output is exactly the current run + block; every toolResult has its toolCall; invariant (2) holds                                      |
| Projection: run boundary        | previous run ended with `stopReason: "stop"`; aborted run; steer mid-run ⇒ boundary chosen as §18                                                                                      |
| Projection: placement           | last message toolResult ⇒ block appended as text; last message user with string content ⇒ content array with two blocks; disabled ⇒ identity                                           |
| Replay: determinism             | same JSONL with `NoopStateUpdater` twice ⇒ identical final state and log (minus timestamps)                                                                                            |
| Replay: recorded                | live log ⇒ `RecordedDecisionsUpdater` replay ⇒ identical final state                                                                                                                   |
| Boundaries                      | import scan: `src/core/**` has no forbidden specifiers                                                                                                                                 |
| Live contract (opt-in)          | `REFLEX_STATE_LIVE_JEV=1` ⇒ one real `systemOne` call with a Choice and a Noul; asserts response shape and `usage.input_tokens > 0`; otherwise skipped                                 |

Pi hooks are tested through a thin `PiEventNormalizer` with hand-built event payloads
matching the 0.83.0 types; the wiring (`pi.on`) is covered by the smoke test, not units.

### 25. Replay harness

`pnpm replay <events.jsonl> --updater noop|jev|recorded[:<transitions.jsonl>] [--config file]`

- Input: one raw `AgentEvent` per line (§6). A Pi session can be exported to this format
  by a small `pnpm export-trace <session.jsonl>` that derives raw events from message
  entries (user prompts, tool calls, tool results, run ends).
- Run: `initialState → for each event: extract → updater → reduce`, with the same queue
  and the same reducer as the extension.
- Output: final HotState (JSON), transition log (JSONL), metrics (latency distribution,
  Jev usage, questions per event, applied/uncertain counts), and a short text summary.
- `recorded` mode reproduces a live run exactly; `noop` gives the deterministic-only
  baseline for free. This is the seam through which future comparison conditions plug in.

No benchmark framework, no datasets, no figures in v0.1.

### 26. Non-goals for v0.1

Unchanged from the GPT draft: no user-defined schemas, multi-agent state, vector/embedding
retrieval, RAG, NL summarisation, full SKILL.state reproduction, Claude Code / Codex /
OpenCode adapters, distributed stores, cloud sync, benchmark suites, paper figures,
reasoning-model fallback. Additionally deferred with designs in this document:
within-run pruning (§18), Jev/LLM overlap (§17), patch-based persistence (§12), git-probe
file tracking (§8), recall tool made mandatory (§19).

### 27. Implementation order

**Phase 0 — Verify (½ day).** Confirm every **VERIFY** item against the installed Pi and
the SDK; record outcomes in `docs/spec/phase0_findings.md`. Add pinned dependencies
(`@typesafe-ai/sdk@0.6.0`, `@earendil-works/pi-coding-agent@0.83.0` as devDependency).
Write the boundary lint override.

**Phase A — Core.** Types → extraction (+tests) → reducer (+tests) → updater interface,
Noop and Recorded updaters → transition log → metrics accumulator → replay runner over
Noop (gives end-to-end determinism early).

**Phase B — Jev.** Client wrapper with budget/circuit → question builders → JevStateUpdater
→ gating → redaction → mocked-error tests → opt-in live contract test.

**Phase C — Pi vertical slice.** Skeleton → normalisation → queue → persistence and
reconstruction → `/state`, `/state history`, `/state stats`, `/state debug`, `/state reset`
→ widget. Smoke test in this repo: `pi -e ./src/pi/index.ts`, run a small edit/test loop,
inspect `/state`, quit, resume, confirm state survives.

**Phase D — Projection.** Exchange-group model → run boundary → state block → placement →
invariants tests → kill switches → provider round-trip smoke on the providers available →
metrics wiring from `message_end`.

**Phase E — Replay & docs.** `export-trace`, `recorded` mode, README (architecture, what is
sent to TypeSafe, limitations, how to disable), remove temporary planning notes.

`pnpm check` (format, lint, typecheck, test, knip) must pass at the end of every phase.

### 28. Acceptance criteria

Functional

- Extension loads with `pi -e` and from `.pi/extensions` without patching Pi.
- A coding session produces raw events; `read`-only steps make zero Jev calls.
- Verification status, files and verification-originated blockers update with Jev disabled.
- With Jev enabled: `blocker_introduced`, `failure_category`, `resolves_*`, `task_complete`
  are asked exactly under §9 triggers; `phase` is recorded in shadow.
- Uncertain decisions leave state unchanged and are counted.
- State survives quit/resume, reload, and fork; branch navigation shows branch-correct state.
- `/state`, `/state history`, `/state stats`, `/state debug`, `/state reset` work; stats show
  only measured numbers.
- Jev auth failure, timeout and 5xx never stall or break the agent loop; deadline ≤ `deadlineMs`.
- Projection sends only the current run plus the state block; pairing invariants hold; the
  Pi session file is byte-for-byte unaffected by projection.
- `recorded` replay reproduces a live session's final state.

Architectural

- `src/core` imports no Pi or TypeSafe code (lint + test).
- HotState is constructed only in the reducer.
- Jev output is typed answers only; no free text enters state.
- Cold history is never deleted or rewritten.

Quality

- `pnpm check` passes. No new runtime dependency besides `@typesafe-ai/sdk`.
- README documents: architecture, data sent to TypeSafe, limitations (previous-run
  context loss, bash-driven file changes untracked, heuristic thresholds), disable switches,
  and everything from Phase 0 that could not be verified.

---

## Appendix A — Deviations from the GPT 6 Pro draft

| #   | GPT draft                                                          | This spec                                                                                         | Why                                                                                          |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `packages/*` monorepo                                              | single package, directory boundaries, lint-enforced                                               | matches the existing template; YAGNI; boundaries are what matter                             |
| 2   | Phase and task status listed as Jev Choice questions on each event | phase proposal by code; `done` via one Noul; full phase Choice in shadow only; taskStatus derived | the draft's own principle ("code before AI") applied; shadow mode still yields research data |
| 3   | `StateDecision` left empty; `StateUpdateContext` lacks facts       | concrete `SemanticDecisions` with gates; context carries `facts` and `evidence`                   | updater must know what is relevant to ask; gates make "uncertain ⇒ unchanged" testable       |
| 4   | `file_change` / `verification` as recorded event types             | derived facts from raw events; `file_change` optional for other adapters                          | replay input stays raw; strategies re-derive identically                                     |
| 5   | Blocker resolution always a Jev question                           | verification-origin blockers resolved by code; Jev only for tool-error blockers                   | cheaper and more reliable; fewer calls                                                       |
| 6   | Working set: cap and vague eviction                                | explicit admission list and 4-step eviction order                                                 | otherwise the working set fills with reads and never means anything                          |
| 7   | Transition record with full before/after                           | `after` only, self-contained with the event                                                       | halves volume; `before` is the previous record                                               |
| 8   | "Reconstruct the most recent HotState"                             | branch walk after latest reset; event store rebuilt from records                                  | handles Pi's tree sessions (fork, `/tree`) correctly by construction                         |
| 9   | Projection: "current user turn + current exchange"                 | exchange-group unit, run boundary by `stopReason`, block appended to the newest message           | precise, testable, and avoids destroying the provider prompt cache                           |
| 10  | No path for the model to see dropped evidence                      | verbatim excerpts in the block; optional `reflex_recall` tool                                     | without it the model is told "tests failed, evidence E42" and cannot see E42                 |
| 11  | SDK used with defaults                                             | 3 s timeout, 0 retries, 4 s deadline, circuit breaker, abort chained to Pi                        | SDK defaults (10 s × 3 attempts) would stall the agent on outages                            |
| 12  | Replay "must produce the same state" with live Jev                 | `RecordedDecisionsUpdater`; raw probabilities logged for offline threshold sweeps                 | live Jev is non-deterministic; only recorded decisions replay exactly                        |
| 13  | "semantic events may contain source code"                          | `read` outputs never sent; redaction pass; README disclosure                                      | narrows exposure at near-zero cost                                                           |
| 14  | PLAN.md at repo root                                               | Phase 0 findings in `docs/spec/`; ADRs optional                                                   | repo already has `docs/`; keeps root clean                                                   |
| 15  | Package names unspecified / older scope implied                    | `@earendil-works/pi-coding-agent@0.83.0`, `@typesafe-ai/sdk@0.6.0`, both pinned                   | verified against the installed CLI and the SDK changelog                                     |
| 16  | Testing categories listed                                          | TSDD contract table, one test per behaviour slice, opt-in live test                               | matches the project's development method                                                     |

Kept unchanged because they are right: fail-open, reducer-owned mutation, typed decisions
only, no NL summaries, non-destructive cold history, the non-goal list, the research
constraint against demo-tuning, and the honesty rule for metrics.

## Appendix B — Facts verified on 2026-09-17

- Pi CLI 0.83.0 installed via Nix; package `@earendil-works/pi-coding-agent`; events,
  message and session types as quoted in §15; bash exit-code text as quoted in §15.
- TypeSafe: docs at `docs.typesafe.ai`; HTTP `POST https://api.typesafe.ai/v1/systemone`,
  Bearer auth; answer shapes and `usage.input_tokens/output_tokens` as in §13; JS SDK
  `@typesafe-ai/sdk` 0.6.0 (2026-09-15) with `TypeSafeClient.systemOne`, `RequestOptions.signal`,
  `RetryPolicy` defaults (2 retries, 500→5000 ms, jitter 0.25, statuses 408/429/5xx),
  `TypeSafeClientConfig.timeout` default 10 000 ms; Jev early access opened 2026-09-15.
- SKILL.state: arXiv:2608.26263 (Badhe, Tiwari, Chung; Aug 2026). Model receives skill
  spec + structured state + latest observation; intermediate reasoning discarded after a
  validated state update.

Subsequent implementation verification is recorded in [Phase 0 findings](phase0_findings.md).
npm availability and compaction behavior are now verified. Live TypeSafe calls and multi-text
tool-result round trips per provider remain unverified.

## Implementation clarifications (2026-09-17)

The following resolves implementation gaps in the reviewed draft. Verification evidence is in
[Phase 0 findings](phase0_findings.md); these clarifications take precedence over conflicting
examples above.

- Extraction receives an explicit context containing cwd, configuration, and a read-only event
  store. Tool results join tool calls by `toolCallId`; no adapter-only facts are required for replay.
- Concrete adapters are assembled at outer entry points as described in
  [ADR-0002](../adr/0002_compose_adapters_at_entry_points.md).
- IDs remain session-monotonic across branches and resets. An allocator reads the maximum event
  ordinal from all transition entries; state reconstruction still reads only the active branch.
  `cursor.eventCount` is the last processed ordinal, which may have gaps on a branch. Replay
  preserves supplied IDs and rejects duplicates. Reset does not rewind the allocator.
- A new user prompt sets `taskStatus` to `in_progress`. On subsequent events active blockers
  take precedence over completion; completion is accepted only with no active blockers and is
  retained until a new prompt, a new blocker, or further tool activity.
- `phase_shadow` only accompanies a non-empty set of required semantic questions. Read-like
  results never cause a request, including errors. Verification blockers are introduced by code;
  only `failure_category` is necessary for those failures.
- Successful bash results mean passed even though their extracted `exitCode` is absent. An error
  without an exit marker means unknown verification status. Compound commands report the overall
  shell outcome, with test > build > lint precedence when several kinds occur; this is not proof
  that every segment executed.
- File changes are recorded only after successful edit/write results; calls alone do not prove
  a file changed. Read paths are recorded on calls. Supersession uses prior raw events.
- Branch restoration follows Pi's root-to-leaf order and also handles `session_tree`. Config and
  environment overrides are reapplied at restoration; recorded replay uses recorded decisions
  and each transition's effective configuration, cwd, and timestamps. Recorded replay rejects
  mismatched event contents even when event IDs match. Exported metadata provides config and cwd
  defaults for ordinary replay.
- `deterministicPhase` records the phase before semantic task completion, so shadow agreement
  compares against the rule-based result. Client invocation counts exclude events cancelled
  before invocation. Invalid-response telemetry records expected field types, never raw values.
- Projection falls back to the original context when no valid user/tool-result placement exists,
  tool pairing is incomplete, or compaction removed the latest user prompt. It never invents
  missing tool messages. This conservative fallback is counted separately from successful projection.
