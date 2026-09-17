# State safety contract

This document is the durable contract for ReflexState state format v2. The executable tests are
evidence for the examples below; this document remains the source for the intended meaning.

## State and evidence

Every stored transition has a v2 `HotState`. The state contains the current goal, phase, task
status, modified and relevant files, verification summaries, the complete `activeBlockers` set,
the bounded working-set IDs, an observation generation, pending possible changes, and a state
health marker. State is reduced from recorded events. Core does not read the filesystem or call Pi,
TypeSafe, or a network service.

Verification is identified by kind, normalized working directory, and the complete normalized
command. A result also records its event evidence, command, target, attribution, observation
generation, and `freshness`: `current`, `stale`, or `unknown`. `not_run` remains the status for a
check that has not been observed. A passed result is only the observed result of that command.
Different commands, arguments, targets, and working directories are different checks.

Single commands may be classified. Shell control, pipelines, wrappers, substitutions, truncated
commands, and incomplete legacy events are conservative `unknown` observations. They cannot create
or clear a verification blocker. A possible workspace change from edit, write, file-change, or
bash advances the observation generation and makes prior verification stale. A matching successful
verification can be current only when its call and result are paired without an intervening
possible change. Resume and branch-switch events invalidate prior freshness and are recorded only
by the live Pi adapter.

## Blockers and completion

`activeBlockers` is the unresolved source of truth for the current state interval. It is persisted
without a display cap. `limits.maxProjectedBlockers` (default 8) selects a display subset and
reports `unresolved_total`, `shown_count`, and `omitted_count`. The deprecated
`limits.maxActiveBlockers` key is accepted as a warning-only configuration alias.

Verification blockers are removed only by a current successful result with the same check key.
Tool-error blockers require an applied Jev resolution decision with the required evidence.
Relevance decisions, working-set limits, display limits, stale successes, and different checks do
not remove blockers. `/state reset` starts a new interval after confirmation; it does not claim that
old blockers were solved.

`completed` requires an `agent_end` with stop reason `stop`, zero unresolved blockers, no pending
possible changes, valid state health, and an applied `taskComplete` decision. `aborted`, `error`,
and `length` never complete a task through a semantic answer alone.

## Projection

Projection is independent from state recording and is disabled by default. `append` preserves the
input array, message order, roles, content, and tool-call/result pairs, then adds a bounded state
block at the configured placement. It never removes a message. `current-run` is experimental: it
keeps the current run and the immediately preceding ended run, including steers and complete tool
exchanges, and may omit older ordinary messages. Neither mode removes messages inside a run.

Run boundaries require a user prompt and a terminal assistant response. Missing boundaries,
incomplete exchanges, compaction or branch summaries, opaque messages that would be removed, a
missing goal, or a state block that cannot fit cause a fallback to the original context. The state
block reports its projection mode, message omissions, blocker totals, verification freshness, and
working-set evidence. Evidence is shown with recorded event content, related calls, or an explicit
unavailable/truncated marker; IDs alone are not treated as readable evidence.

## Request plans and budgets

Jev questions and their evidence are selected by one bounded request plan. Resolution questions
carry the blocker and the latest recorded result as a single evidence pair; local state-block
projection also expands each result with its related call when that call is available. Relevance
questions include their target evidence. Completion input includes the unresolved total and
freshness-aware verification summaries. A question is omitted when its required evidence is
unavailable or the 24,000-byte input budget cannot include the pair. Read, grep, find, and ls
results never trigger Jev and are not sent as evidence.

## Persistence and legacy data

Transitions, events, configuration, cwd, and recorded decisions are persisted together. Recorded
replay runs the same core reducer over the recorded event sequence and does not query the current
filesystem, wall clock, or APIs. Branch restoration uses only the selected branch after its last
reset, while event ordinals remain monotonic across resets.

Version 1 state is not migrated. If an unsupported v1 transition exists after the last reset,
runtime state updates and projection stop, `/state` and notifications show
`legacy_state_requires_reset`, and the original Pi history remains untouched. A confirmed reset
starts a new v2 interval. Invalid data and unsupported recorded replay are explicit errors. Legacy
trace export preserves its legacy marker and never presents it as a v2 recording.
