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
call is recorded with `sent: false` instead of being reported as a call that happened.

## Communication contract

Live actor, repair, and update calls go through `ModelRuntime.complete` with a system prompt and
a single user message. Request bytes and request hashes are computed on the exact sent body, so
local metadata such as trial ids never leaks into the wire payload. Usage is recorded only when
the provider reports it: missing usage stays absent and is never written as a measured zero.
Recorded providers replay only the response bound to the call kind, trial, step, and request hash.

## Offline commands

```sh
pnpm experiment:hybrid -- audit \
  --config experiments/hybrid-state/config.offline.json \
  --out .local/hybrid-state/audit

pnpm experiment:hybrid -- run \
  --config experiments/hybrid-state/config.stage-a.offline.json \
  --out .local/hybrid-state/stage-a

pnpm experiment:hybrid -- report --input .local/hybrid-state/stage-a
```

The output directory is reserved exclusively before execution; an existing directory is rejected.
It contains `manifest.json`, `updates.jsonl`, `calls.jsonl`, `contexts.jsonl`, `summary.json`, and
`report.md`. The manifest moves through `running` → `completed`/`failed`, so a persistence failure
after execution stays distinguishable from an execution failure. `report` displays an existing
result without starting a new run.

## Evaluation honesty

Every trial reports an execution status (`completed`, `failed`, `cancelled`, `incomplete`), a
wiring status, and an efficacy status. Fake and recorded providers produce
`efficacy_status: not_evaluated`; only real-model runs can be described, and even then only as
`descriptive_only` until a reviewed evaluation exists. Fake success is wiring evidence and must
not be described as real-model task success.

The checked-in tasks are virtual workspaces with read/write/edit/test/finish operations. They
reject absolute paths, `..` escapes, arbitrary shell, network operations, and unlisted test ids.
Each allowed test id resolves through a declared oracle (script or expected files), and test
observations feed the Facts view with a check key and generation. This is an experiment boundary,
not a general-purpose sandbox.

## Live execution

Live execution requires a live configuration and an explicit `--live` flag; the flag is rejected
for non-live configs and required for live ones. Provider and model ids, request and action
limits, and timeouts must be present and are validated before any call is made. A live provider
that is needed but unconfigured fails preflight instead of being silently skipped. When
`provider.executionIsolation` is `required`, the run aborts unless a sandbox mechanism is
available. Live runs do not accept `--session` inputs. Authentication uses the existing Pi and
TypeSafe credential paths; keys are not written to configuration or output. Live execution is
intentionally not part of the default checks.

## What this prototype does not claim

It does not prove that state-first input is equivalent to history, that information is retained
better under either condition, or that Jev adds value. Three synthetic tasks cannot establish a
general cost, speed, or success-rate claim, and offline fake results are never efficacy evidence.
