# Hybrid state experiment

This page describes an isolated research prototype. It is not enabled by the Pi extension, does
not add a package export or command, and does not change state version 2, projection modes, or
replay behavior.

The prototype compares four closed-loop conditions on the same task: `history` keeps the visible
conversation, `llm` lets the actor return an action and a state patch in one response, `rules`
extracts and selects candidates with code, and `jev` adds a bounded Choice decision over those
same candidates. `rules` and `jev` share the repair model, repair budget, actor, tools, task files,
and action limit. Jev choices can select or reject existing candidates; they cannot create new
memory text.

The source trace is read only from an explicitly supplied file or the checked-in synthetic case.
Only visible user text, assistant text, tool calls, and tool results are used. Thinking blocks are
ignored. Candidate offsets use JavaScript UTF-16 positions and are checked against their source.
Facts are shaped from the existing core state, while experimental memory contains constraints,
decisions, findings, attempts, and open questions. Every memory item records its source and whether
it was extracted or generated. Tool output is never promoted to a user constraint by trust alone.

State-first inputs contain fixed instructions and tools, the current Facts view, bounded memory,
and the latest observation. They do not append old assistant or tool messages. The history baseline
retains its complete visible trace. Budgets are byte budgets: memory 8 KiB, Facts 4 KiB, latest
observation 8 KiB, and provider request 24,000 bytes in the offline configuration. A required Facts
metadata overflow or state-first input overflow is recorded as unavailable; the runner never hides
the failure by silently returning to full history.

The offline commands are:

```sh
pnpm experiment:hybrid -- audit \
  --config experiments/hybrid-state/config.offline.json \
  --out .local/hybrid-state/audit

pnpm experiment:hybrid -- run \
  --config experiments/hybrid-state/config.offline.json \
  --out .local/hybrid-state/run

pnpm experiment:hybrid -- report --input .local/hybrid-state/run
```

The output directory contains `manifest.json`, `updates.jsonl`, `calls.jsonl`, `contexts.jsonl`,
`summary.json`, and `report.md`. Existing non-empty output directories are rejected. Context text is
not stored by default; the manifest records that privacy choice. The checked-in tasks are virtual
workspaces with read/write/edit/test/finish operations. They reject absolute paths, `..` escapes,
arbitrary shell, network operations, and access to labels or answer files. This is an experiment
boundary, not a general-purpose sandbox.

`audit` diagnoses whether a fixed trace update looks deterministic, extractive, generative, or
insufficient under its candidate and byte budget. Labels are evaluator-only data and are never put
into model input. `run` executes the actor response against a fresh virtual workspace after every
tool exchange, so a later input observes the result of the chosen action rather than a recorded
future. Fake success is wiring evidence and must not be described as real-model task success.

Live execution requires a live configuration and an explicit `--live` flag. Provider and model IDs,
request and action limits, and timeouts must be present in that configuration. Authentication uses
the existing Pi and TypeSafe credential paths; keys are not written to configuration or output.
Live execution is intentionally not part of the default checks. Real session data requires an
explicit `--session` path and a separately reviewed data boundary.

The prototype does not prove that state-first input is generally equivalent to history, or that Jev
adds value. Compare `history` with the state conditions, then `rules` with `jev`, and finally `llm`
with `jev`. Report quality failures, missing information, repair rate, rereads, retries, request
bytes, and unavailable trials alongside successes. Three synthetic tasks cannot establish a general
cost, speed, or success-rate claim.
