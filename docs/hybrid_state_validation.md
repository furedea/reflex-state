# Hybrid state validation

This revision continues the PR #5 head `a2d92ad8f2a395a7f338eae52a2addc624885335`
(`feat/hybrid-state-experiment`), which corrected the original head
`453845c2aa8afa5d5412f2e476c9a5f01cbdf677`. The experiment is isolated under
`src/experiments/hybrid-state/`; the Pi extension, state version 2, projection modes, public API,
and replay are unchanged.

## What was corrected

The previous prototype misreported its own evidence. The corrected implementation now measures
the sent request body for bytes and hashes, distinguishes missing usage from measured zero usage,
keeps the actor request's local metadata out of the wire payload, and validates actor actions and
state patches against the declared contract. Memory updates are source-backed: extracted text must
equal its cited source, generated text requires an allowed origin, and protected user constraints
cannot be dropped for budget reasons. Latest observation groups are indivisible, and budget
overflows are recorded as explicit `unavailable` reasons instead of silent truncation. Blocked
calls are recorded with `providerInvoked: false`, zero attempts, and a `not_sent` error; trials
report execution, wiring, and efficacy status
separately, and fake or recorded providers always report `efficacy_status: not_evaluated`.
Earlier claims that fake results demonstrated information retention, state-first superiority,
Jev value, or provider correctness are withdrawn; the fake conditions are wiring evidence only.
Existing result files were not modified.

The follow-up review found that scoring itself still passed wrong answers: checkpoint matching
was substring-only, oracle verdicts could be forged by candidate code, and task constraints were
conflated with action policy. Checkpoint requirements are now typed (`verbatim` with provenance
and inversion checks, `exact_value` with token boundaries, `verification` compared structurally
against per-test facts or generation/sequence-ordered history), and ambiguous paraphrases stay
`needs_semantic_review` instead of passing. A second review round then showed the remaining
holes: an inverted condition sharing the same keywords passed, a value under the wrong name
passed, a pass quoted inside an assistant message or a read file's contents was adopted as real
evidence, and candidate code could escape the oracle's vm context through the host-built
console's constructor chain. These are now closed: canonical phrases are clause spans whose
occurrences do not count when immediately negated; `exact_value` can bind a value to a declared
name (`FALLBACK_PORT=8080`); history-side verification counts only first-line records of
`tool_result test` messages; and the candidate context is built from a null-prototype sandbox
with the console constructed inside the candidate realm, so no host value is reachable through a
constructor chain. Candidate code only produces return values and exceptions — pass/fail is
decided by the trusted script it cannot reach. Task-constraint verdicts travel through the
oracle result (`constraints` map) and are scored independently of policy violations
(`constraintPassed`, `null` when undeclared). The Stage A tasks were revised to cover what the
comparison requires: the protected-constraint task hides the constraint inside a mid-run
observation and presents the rotation request only as unverified file content (`docs/inbox.txt`)
rather than a contradicting user instruction, the transient-recovery task adds an independent
second check so a different test's success cannot masquerade, and the observation-derived task
requires conditional selection between two candidate ports. Live gating now verifies the
approved task set by content hash (`stage-a.approved.json`), requires scoring for every
closed-loop task, and requires isolation for every non-fake closed-loop provider including
`recorded`.

## Acceptance evidence

Acceptance tests live in `src/experiments/hybrid-state/acceptance.test.ts` and run under vitest.

| ID  | Test name                                                                                    |
| --- | -------------------------------------------------------------------------------------------- |
| C1  | the actor wire body is the ModelRuntime.complete shape without local metadata                |
| C2  | missing usage stays absent while measured zeros are preserved                                |
| C3  | the actor response is one JSON object with action plus optional state patch                  |
| C4  | Jev answers decode per question with invalid entries marked, never fabricated                |
| C5  | recorded providers replay only the call bound to kind, trial, step, and request hash         |
| C6  | exhausted request budgets record providerInvoked:false instead of pretending a call happened |
| E1  | extracted operations must match cited source text and generated ones need approval           |
| E2  | an oversized latest observation group is reported unavailable, never split                   |
| E3  | Stage A compares history and llm through identical single actor calls with no Jev            |
| E4  | a fake provider run reports efficacy as not evaluated                                        |
| E5  | the task environment rejects path escapes and unlisted test ids                              |
| E6  | live preflight and output reservation fail before any execution                              |
| F1  | the input-dependent fake detects providers that ignore the sent input                        |

Follow-up acceptance tests (protocol `stage-a-followup-1`, result schema 3) live in the same
files:

| ID   | Test name and file                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| L-01 | the llm system prompt carries no task-specific answers or policies (acceptance.test.ts)                       |
| L-02 | missing, empty, and present patches stay distinct; malformed ones fail (acceptance.test.ts)                   |
| L-03 | a partially invalid patch applies the valid op, records the drop, and notifies the next step (runner.test.ts) |
| L-04 | a valid-but-duplicate op is unchanged, never counted as applied (runner.test.ts)                              |
| L-05 | the update notification covers only the previous step and stays under its 2 KiB cap (runner.test.ts)          |
| L-06 | both modes see identical remaining budgets and no ninth actor call happens (runner.test.ts)                   |
| L-07 | Stage A runs actor calls only; jev/update/repair invocations are zero (stage_a.test.ts)                       |
| L-08 | verified-but-unfinished scores the artifact without crediting a finish (runner.test.ts)                       |
| L-09 | a correct artifact without actor verification keeps actor not_run (runner.test.ts)                            |
| L-10 | a change after the actor's passing test keeps the stale flag (runner.test.ts)                                 |
| L-11 | a wrong artifact fails the final oracle and an oracle-less task reports not evaluated (runner.test.ts)        |
| L-12 | fake runs keep efficacy not_evaluated while patch and artifact fields stay separate (runner.test.ts)          |
| L-13 | a schema v2 result renders read-only and never gains v3 fields (acceptance.test.ts)                           |
| L-14 | re-read analysis uses only inputs at or before the step and degrades to unknown (reread.test.ts, reread.ts)   |
| L-15 | the sent request carries feedback and budget but never scoring internals (runner.test.ts)                     |
| L-16 | the actor can read the rejection and correct its patch on the next step (runner.test.ts)                      |

Condition-freeze round tests (same protocol and schema; the comparison's meaning is unchanged):

| ID   | Test name and file                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-01 | verbatim absence with needed values present is not `necessary_detail_missing`; a missing concrete edit detail and unclear planned work are distinguished (reread.test.ts)     |
| G-02 | user-only records scope claims to the recorded portion, and JSON-escaped newlines never fake verbatim absence (reread.test.ts)                                                |
| G-03 | persisted context + system_prompts records reconstruct the exact sent body with matching hash and bytes; scoring fields and auth material stay out (runner.test.ts)           |
| G-04 | the frozen snapshot identifies code, effective config, task/scoring content, and prompts; content drift and a dirty tree are different conditions (freeze.test.ts, freeze.ts) |
| G-05 | unverified isolation, a corrupt workspace, a writer failure, and cancellation each stop candidate execution with zero additional oracle runs (runner.test.ts)                 |
| G-06 | the frozen plan is 3 tasks × 2 modes × 3 iterations = 18 trials at ≤144 actor calls, identical budgets across modes, zero jev/repair/update calls (runner.test.ts)            |

Regression tests live in `update.test.ts`, `task_environment.test.ts`, `stage_a.test.ts`,
`evaluation.test.ts`, `projection.test.ts`, `runner.test.ts`, and `trace.test.ts`. They cover
protected-constraint updates, actually-applied operation counts, oracle result protocol
(`oracle-result:` JSON with a boolean `passed`), verification evidence ids with
generation/sequence freshness, the deny-default isolation boundary probes (workspace write,
outside read, symlink escape, environment non-inheritance, network denial, timeout), over-budget
actor patches, skipped trials, recorder failure classification, and the full Stage A loop of
three tasks across both modes.

The negative-side cases are covered as well: a stale pass, a different test's pass, a value
embedded in a longer digit string, a value bound to the wrong name, an inverted canonical
phrase, a canonical phrase immediately negated in its item, a condition reduced to shared
keywords ("When occupied, do not use FALLBACK_PORT."), canonical text under wrong provenance, a
pass quoted inside an assistant message, a pass quoted inside a read file's contents, and an
unverifiable paraphrase are all rejected or left unevaluated by the checkpoint scorers; a
constant-returning implementation, a missing export, a forged `oracle-result:` line printed by
candidate code, a `process.exit` inside the candidate, a candidate `import`, and realm escapes
through the console, global, and local-object constructor chains all fail the oracle; an
unapproved task root, a tampered or missing task file, an extra file, a missing scoring entry,
and a `recorded` provider without isolation are all rejected.

## Executed commands and results

| Evidence                | Command                                                                                                                                    | Result                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript build        | `pnpm run build`                                                                                                                           | passed (`tsc -p tsconfig.build.json`)                                                                                                                                             |
| Hybrid-state tests      | `pnpm exec vitest run src/experiments/hybrid-state`                                                                                        | 8 files, 95 tests passed                                                                                                                                                          |
| Full repository gate    | `pnpm check`                                                                                                                               | passed: oxfmt, oxlint, type-aware check, 231 vitest tests passed + 1 skipped, 14 release tests passed, knip clean                                                                 |
| Package verification    | `pnpm run package:check`                                                                                                                   | passed: extension packaging plus export/replay commands                                                                                                                           |
| Trace audit (wiring)    | `node dist/experiments/hybrid-state/cli.js audit --config experiments/hybrid-state/config.offline.json --out .local/hybrid-state/audit-v2` | run `run-mu6p260g-x6mt86`; 4 modes wiring passed; efficacy not_evaluated                                                                                                          |
| Stage A closed loop     | `pnpm experiment:hybrid -- run --config experiments/hybrid-state/config.stage-a.offline.json --out .local/hybrid-state/stage-a-v3`         | run `run-mu88cltp-8i9j0z`; 3 tasks × 2 modes = 6 trials, all wiring passed and all oracle tests passed; efficacy not_evaluated; 40 actor calls recorded (no Jev, no update calls) |
| Existing result display | `node dist/experiments/hybrid-state/cli.js report --input .local/hybrid-state/stage-a`                                                     | existing result displayed; report rendered from `summary.json` without a new run                                                                                                  |
| Live preflight          | `node dist/experiments/hybrid-state/cli.js run --config experiments/hybrid-state/config.live.example.json --out ...`                       | rejected: `provider.mode=live requires --live` (exit 1), no output directory created                                                                                              |
| Live flag misuse        | `node dist/experiments/hybrid-state/cli.js run --live --config experiments/hybrid-state/config.offline.json --out ...`                     | rejected: `--live is only valid with provider.mode=live` (exit 1)                                                                                                                 |
| Product replay          | `node dist/replay_cli.js <exported events.jsonl> --updater noop`                                                                           | exported trace replayed; state produced without errors                                                                                                                            |
| Pi extension smoke      | inside `pnpm run test` (`src/pi/smoke.test.ts`)                                                                                            | extension loads and persists branch-correct state through the real Pi runner                                                                                                      |

The Stage A output directory `.local/hybrid-state/stage-a-v3/` contains `manifest.json`,
`updates.jsonl`, `calls.jsonl`, `contexts.jsonl`, `summary.json`, and `report.md`. No persistence
failure occurred; the manifest completed normally.

### Follow-up round (protocol `stage-a-followup-1`)

| Evidence               | Command                                                                                                                                                      | Result                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Full repository gate   | `pnpm check`                                                                                                                                                 | passed: format, lint, typecheck, 254 vitest tests passed + 1 skipped, 14 release tests passed, knip clean        |
| Package verification   | `pnpm run package:check`                                                                                                                                     | passed                                                                                                           |
| Follow-up offline run  | `pnpm experiment:hybrid -- run --config experiments/hybrid-state/config.stage-a.followup.offline.json --out .local/hybrid-state/stage-a-followup-offline-01` | run `run-mua5nib6-ptecrf`; 6/6 trials completed, wiring passed; new fields populated; efficacy not_evaluated     |
| Report of that result  | `pnpm experiment:hybrid -- report --input .local/hybrid-state/stage-a-followup-offline-01`                                                                   | rendered with protocol id, termination, final artifact, actor verify, and patch columns                          |
| Existing live evidence | `.local/hybrid-state/stage-a-live{,2..6}/` read-only analysis                                                                                                | six manifests/summaries verified; see `docs/hybrid_state_live_stage_a.md` for the run table and re-read analysis |

### Condition-freeze round (request evidence + safe evaluation + freeze)

| Evidence                     | Command                                                                                                                                                                                                                               | Result                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full repository gate         | `pnpm check`                                                                                                                                                                                                                          | passed: format, lint, typecheck, 270 vitest tests passed + 1 skipped, 14 release tests passed, knip clean                                                                |
| Package verification         | `pnpm run package:check`                                                                                                                                                                                                              | passed                                                                                                                                                                   |
| Evidence-capture offline run | `node dist/experiments/hybrid-state/cli.js run --config experiments/hybrid-state/config.stage-a.followup.offline.json --out .local/hybrid-state/stage-a-followup-offline-02`                                                          | run `run-muavng6b-6aury1`; `system_prompts.jsonl` written (one record per mode); all 40 context records reconstructed to byte- and hash-identical sent bodies            |
| Re-read re-analysis          | `node .local/hybrid-state/review-02/analyze_rereads.mjs .local/hybrid-state/stage-a-live6 .local/hybrid-state/review-02`                                                                                                              | corrected output at `review-02/reread-cases-stage-a-live6.json`; no `necessary_detail_missing` is asserted without a named missing requirement                           |
| Frozen live Stage A run      | `node dist/experiments/hybrid-state/cli.js run --config .local/hybrid-state/review-02/config.stage-a.followup.live.json --freeze .local/hybrid-state/review-02/freeze.json --live --out .local/hybrid-state/stage-a-followup-live-01` | run `run-mub0wwh3-1yuxt5`; freeze check passed; 18/18 trials completed; 113 actor calls, 0 Jev/repair/update; all 113 sent bodies reconstructed hash- and byte-identical |

New evidence fields added this round: `ContextRecord.systemHash` + `system_prompts.jsonl`
(prompt body once per distinct hash, gated by the existing `recordContextText`), and
`CallRecord.responseModel` (the model the provider actually answered with, never assumed).
Manifests now carry `dirty`, `taskSetHash`, `promptHashes`, and `runtime` (node, platform,
lockfile hash, generation-option provenance). `runClosedLoop` accepts `isolationVerified`,
`signal`, and a test-only `environmentFor` seam; a cancelled or corrupt workspace runs zero
final oracle passes and reports the reason (`cancelled`, `environment_error`,
`isolation_unverified`) instead of a verdict. `--freeze <file>` replays a captured
`FreezeRecord` against the current code/config/tasks/prompts and refuses to run on any
mismatch. No historical artifacts were modified; no live request was made.

## Not performed

As of the previous revision no live request had been made. Since then, six live Stage A runs
were executed and are recorded in `docs/hybrid_state_live_stage_a.md`. During the follow-up
revision itself no live request was made — all API-facing paths were exercised only through
fake providers, stubbed clients, and read-only log analysis. After that revision was frozen,
one authorized live run (`run-mub0wwh3-1yuxt5`) executed the frozen condition once; its
results are descriptive only and are recorded in the same document. No private session data
was supplied. No human review of the synthetic labels was performed. No claim about real task
success, cost, latency, statistical non-inferiority, or state-first superiority is supported
by this evidence.

The frozen Stage A comparison ran once under authorization: the three approved tasks, modes
`history` and `llm`, `maxActions: 8`, actor calls only, 3 iterations (`maxRequests: 144` as the
actor-call budget), and `timeoutMs: 120000` identical across modes. Live output remains
`descriptive_only` — how live efficacy would be scored was never decided, and no further runs
are planned. Any hypothetical future run would still need a filled `actorModel`, resolvable
credentials, `--live`, and a freeze match; none of that is scheduled.
