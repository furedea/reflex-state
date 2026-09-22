# Hybrid state experiment

This page describes an isolated research prototype. It is not enabled by the Pi extension, does
not add a package export or command, and does not change state version 2, projection modes, or
replay behavior.

## Stage A: history versus llm

The current stage compares exactly two closed-loop conditions on the same task, action budget,
tools, and actor-response structure:

- `history` keeps the complete visible conversation in every actor input.
- `llm` replaces the conversation with the current Facts view, bounded working memory, and the
  latest observation group. Its actor returns one JSON object containing both the action and an
  optional state patch (`{"action": ..., "statePatch": [...], "text": "..."}`).

Stage A makes a single actor request per step. It does not call Jev, and it does not use a
separate state-update LLM call. Whether `rules` or `jev` add value is a later-stage question and
is intentionally not decided by this stage.

The earlier four-condition prototype (`history`, `llm`, `rules`, `jev`) still exists under the
`audit` evaluation and the fake provider, but it is wiring and contract evidence only. It is not
evidence about task quality, information retention, or Jev value.

## Inputs and memory

The source trace is read only from an explicitly supplied file or the checked-in synthetic case.
Only visible user text, assistant text, tool calls, and tool results are used. Thinking blocks are
ignored. Candidate offsets use JavaScript UTF-16 positions and are checked against their source.

State-first inputs contain fixed instructions and tools, the current Facts view, bounded memory,
and the latest observation group. Observation groups are indivisible: if the latest group exceeds
its byte budget the input is recorded as unavailable rather than silently truncated. Memory items
carry their sources and an `extracted`/`generated` origin; extracted text must equal its cited
source, and protected user constraints are never dropped for budget reasons. Tool output is never
promoted to a user constraint by trust alone.

Budgets are byte budgets measured on the sent text: memory 8 KiB, Facts 4 KiB, latest observation
8 KiB, and provider request 24,000 bytes in the offline configuration. Provider requests also have
a global count budget (`maxRequests`) and a per-trial count budget (`trialMaxRequests`); a blocked
call is recorded with `providerInvoked: false`, zero attempts, and a `not_sent` error instead of
being reported as a call that happened.

## Communication contract

Live actor, repair, and update calls go through `ModelRuntime.complete` with a system prompt and
a single user message. Request bytes and request hashes are computed on the exact sent body, so
local metadata such as trial ids never leaks into the wire payload. Usage is recorded only when
the provider reports it: missing usage stays absent and is never written as a measured zero.
Recorded providers replay only the response bound to the call kind, trial, step, and request hash.

Under protocol `stage-a-followup-1` (prompt `hybrid-state-prompt-v3`, result schema 3) both modes
receive an identical `action_budget` object (`limit`, `used`, `remaining_including_next`,
`finish_counts_as_action`) in every request, and llm additionally receives `last_update_result`:
the previous step's patch outcome (`patch_input` missing/empty/present, applied/unchanged/
rejected indexes and counts, capped at 2 KiB of detail with an `omitted_detail_count`). The
feedback covers the previous step only and never accumulates. The actor responds with one JSON
object carrying `action` plus, in llm mode, an optional `statePatch`; canonical, shorthand, and
bare action spellings are normalized and the observed form is recorded per trial.

## Offline commands

```sh
pnpm experiment:hybrid -- audit \
  --config experiments/hybrid-state/config.offline.json \
  --out .local/hybrid-state/audit

pnpm experiment:hybrid -- run \
  --config experiments/hybrid-state/config.stage-a.offline.json \
  --out .local/hybrid-state/stage-a

pnpm experiment:hybrid -- run \
  --config experiments/hybrid-state/config.stage-a.followup.offline.json \
  --out .local/hybrid-state/stage-a-followup-offline

pnpm experiment:hybrid -- report --input .local/hybrid-state/stage-a
```

The output directory is reserved exclusively before execution; an existing directory is rejected.
It contains `manifest.json`, `updates.jsonl`, `calls.jsonl`, `contexts.jsonl`, `summary.json`, and
`report.md`. Each invoked call writes a `call_start` record before its completion record so a
crash mid-call is distinguishable from a call never made. The manifest moves through `running` →
`completed`/`failed`, so a persistence failure after execution stays distinguishable from an
execution failure. `report` displays an existing result without starting a new run and verifies
that the summary's run id and schema match the manifest.

When `recordContextText` is on, the system prompt body is also persisted — once per distinct
hash in `system_prompts.jsonl`, referenced by `systemHash` on each context record — so every
call's exact sent body `{system, messages:[{role:"user", content}]}` can be reconstructed from
the saved data and checked against the recorded `requestHash`/`requestBytes`. Auth material and
local metadata never enter the sent body, so none appears in this evidence. Each call record may
additionally carry `responseModel`: the model id the provider reported answering with, which is
never assumed equal to the requested model. The completed manifest pins the executed condition:
`head` plus a `dirty` flag for the working tree, `taskSetHash` over the task and scoring files,
per-mode `promptHashes`, and `runtime` (node, platform, lockfile hash, and whether generation
options were sent explicitly or left to provider defaults).

## Evaluation honesty

Every trial reports an execution status (`completed`, `failed`, `cancelled`, `incomplete`), a
wiring status, and an efficacy status. Fake and recorded providers produce
`efficacy_status: not_evaluated`; only real-model runs can be described, and even then only as
`descriptive_only` until a reviewed evaluation exists. Fake success is wiring evidence and must
not be described as real-model task success.

The checked-in tasks are virtual workspaces with read/write/edit/test/finish operations. They
reject absolute paths, `..` escapes, arbitrary shell, network operations, and unlisted test ids.
Each allowed test id resolves through a declared oracle (script or expected files), and test
observations feed the Facts view with a check key and generation. Script oracles must print a
final `oracle-result:` line whose JSON carries a boolean `passed` field; a clean exit or matching
text is not a pass. Each verification carries the evidence id of the action that produced it and
a generation plus sequence number so stale checks never outrank newer ones, and the Facts view
reports the latest result per declared test id so one check's success cannot stand in for
another's. This is an experiment boundary, not a general-purpose sandbox.

Script oracles evaluate candidate workspace code through a trusted `loadModule` prelude: the
candidate file is read as text and evaluated inside a fresh `vm.SourceTextModule` context built
from a null-prototype sandbox, and the console is constructed inside the candidate realm. No host
value enters the context, so candidate code cannot reach a host-realm `Function`/`process`
through a constructor chain, cannot import, and cannot emit the verdict line — only the trusted
script emits `oracle-result:`. `node:vm` is not a general security boundary; what this design
guarantees is narrower: candidate code only produces return values and exceptions, and pass/fail
is decided by code it cannot reach. Oracles that compare behavior (not file bytes) call the
candidate's exports across several inputs and decide pass/fail on the trusted side.

## Scoring

Checkpoint requirements are typed instead of free-text matching:

- `verbatim` retains only when the canonical phrases appear together inside one
  provenance-eligible item (a memory item of a declared kind or trust, a history or observation
  line of a declared role) that does not itself carry an inverting phrase. Canonical phrases are
  clause spans, not keyword sets, and an occurrence does not count when a negation immediately
  precedes it in the same item — "do not use X" never satisfies "use X". A canonical text found
  only under the wrong provenance fails, and a recognizable paraphrase stays
  `needs_semantic_review` rather than passing.
- `exact_value` requires the declared token with identifier/numeric boundaries, so `9377` never
  matches inside `19377`. When a `name` is declared the value must also be bound to that name
  (`FALLBACK_PORT=8080`), so the same digits under a different name do not count.
- `verification` compares the structured latest check for the declared test id — status and
  freshness in the state-first Facts view. In a history transcript only real test evidence
  counts: the check record must be the first line of a `tool_result test` message, ordered by
  generation and sequence, so a pass quoted inside an assistant explanation or a read file's
  contents is never adopted, and a stale pass or a different check's success does not count.

Task constraints are scored independently of action policy: oracles may attach a `constraints`
map of boolean verdicts to their result, verdicts are sticky-false across the trial, and
`constraintPassed` is `null` when a task declares none. A policy violation (for example a path
escape) fails wiring without changing `constraintPassed`, and a broken task constraint fails
`constraintPassed` without needing any policy violation.

Completion, artifact quality, and the actor's own verification are scored as separate facts:
`finishedWithinBudget` records only that the actor chose `finish` inside the action budget;
`finalArtifact` runs the task oracles on the final workspace even when the budget ran out —
but only when the workspace is intact and required isolation was actually verified; a corrupt
workspace, unverified isolation, a recording failure, or cancellation runs zero additional
candidate code and reports the reason (`environment_error`, `isolation_unverified`,
`cancelled`) instead of a verdict;
`finalConstraintVerdicts` reports the constraint verdicts from that final pass without erasing
sticky mid-run violations; `actorVerificationAtStop` keeps the actor's latest self-check per test
id with `current`/`stale` freshness so a pass taken before a later edit is never presented as
current; and `terminationReason` distinguishes `finish`, `action_budget`, `request_budget`,
`policy_violation`, `contract_error`, `provider_error`, `persistence_error`,
`environment_error`, `cancelled`, and `state_unavailable`. Result artifacts carry
`schemaVersion: 3` and
`protocolId` on both manifest and summary; the report reader cross-checks them and renders older
schema v2 results read-only instead of filling missing fields with defaults.

## Live execution

Live execution requires a live configuration and an explicit `--live` flag; the flag is rejected
for non-live configs and required for live ones. Provider and model ids, request and action
limits, and timeouts must be present and are validated before any call is made. A live provider
that is needed but unconfigured fails preflight instead of being silently skipped.

Live runs are limited to the approved Stage A fixture set: `taskRoot` must be the manifest's
directory (`experiments/hybrid-state/tasks/stage-a`) and every task and scoring file is compared
against the checked-in sha256 manifest `experiments/hybrid-state/stage-a.approved.json`; a
tampered, missing, or extra file fails preflight. Every closed-loop task must have a scoring
entry and every allowed test a declared oracle — there is no silent expectedFiles fallback when a
comparison run is being scored.

Isolation is required whenever `provider.executionIsolation` is `required` and whenever a
closed-loop run uses a non-fake provider — a `recorded` provider still replays generated code
into the task environment, so it does not skip the boundary check either. On macOS the mechanism
is a deny-default `sandbox-exec` seatbelt profile around a resolved absolute node binary; the
preflight probes workspace writes, outside reads, symlink escapes, environment non-inheritance,
network denial, and timeout enforcement, and reports each failed check. Live runs do not accept
`--session` inputs. Authentication uses the existing Pi and TypeSafe credential paths; keys are
not written to configuration or output. Live execution is intentionally not part of the default
checks.

A fixed comparison can be pinned with a `FreezeRecord` (commit, dirty flag, effective-config
hash, task-set hash, prompt hashes, lockfile hash, runtime) captured via
`captureFreeze()`/`verifyFreeze()` in `freeze.ts`, and re-checked at run time with
`--freeze <path>`: any drift in code, config, tasks, scoring, or prompts aborts the run as a
different condition rather than executing under the frozen name.

## What this prototype does not claim

It does not prove that state-first input is equivalent to history, that information is retained
better under either condition, or that Jev adds value. Three synthetic tasks cannot establish a
general cost, speed, or success-rate claim, and offline fake results are never efficacy evidence.
