# Live Stage A: six-run history and follow-up protocol

This document records the six live Stage A runs executed before the follow-up fixes, what the
local artifacts verify, the re-read analysis of the final run, and the corrected comparison
protocol (`stage-a-followup-1`). It is descriptive only: no run claims efficacy, superiority, or
non-inferiority.

## Evidence strength

Every claim below is tagged:

- **verified**: recomputed or read directly from files under `.local/hybrid-state/stage-a-live*/`.
- **user_reported**: stated in the task report and not independently reproducible here.
- **unavailable**: the records needed to decide were never written.

System prompts were never recorded in `contexts.jsonl` (only the user body was), so per-run
system-prompt content is unverifiable. All six manifests record `head: 633d62e`, but the working
tree was dirty during the series — response recording exists in runs 2–6 yet lands in git only at
`fa69e43` — so the recorded head is not the executed code and mid-series contract changes cannot
be dated precisely from artifacts.

## Run table (verified from manifests, summaries, and call logs)

| #   | directory     | runId               | timeout | calls         | responseText | wiring p/f/ne | history            | llm |
| --- | ------------- | ------------------- | ------- | ------------- | ------------ | ------------- | ------------------ | --- |
| 1   | stage-a-live  | run-mu8auoq9-v47f2m | 30 s    | 6             | 0/6 recorded | 0/6/0         | 0/3 completed      | 0/3 |
| 2   | stage-a-live2 | run-mu8bvhds-36l99z | 120 s   | 9             | 6/9          | 0/6/0         | 0/3                | 0/3 |
| 3   | stage-a-live3 | run-mu8c6rec-qn8fof | 120 s   | 1/27 recorded | 3/2/1        | 3/3           | 0/3 (1 incomplete) |
| 4   | stage-a-live4 | run-mu8fcfuh-wu7xo7 | 120 s   | 1/23 recorded | 3/3/0        | 2/3           | 1/3                |
| 5   | stage-a-live5 | run-mu8g3xnj-y9cv95 | 120 s   | 29/29         | 3/2/1        | 3/3           | 0/3 (1 incomplete) |
| 6   | stage-a-live6 | run-mu8h5un9-exz3qx | 120 s   | 37/37         | 4/0/2        | 3/3           | 1/3 + 2 incomplete |

(Calls column lists recorded completion records; run 1 shows 6/6 with no responseText, runs 3–4
kept responseText only on decode failures.)

All runs: `openai-codex/gpt-5.6-luna`, closed_loop, modes `[history, llm]`, `maxActions: 8`,
`maxRequests: 64`, `iterations: 1`, `executionIsolation: required`, `recordContextText: true`.
Total recorded actor calls across the six runs: 131 (user_reported "~130" — consistent).

Contract changes across the series (from git and artifact deltas): strict JSON parsing and a
30 s timeout caused run 1's step-0 failures; tolerant JSON extraction, shorthand/bare action
normalization, a 120 s timeout, and opt-in `responseText` recording appear from run 2 onward;
per-operation patch rejection (record-and-continue) arrived by run 6. Exact per-run code states
are **unavailable** beyond what the artifacts show.

## Final run (`run-mu8h5un9-exz3qx`) — verified values

| metric                           | history | llm                        | source              |
| -------------------------------- | ------- | -------------------------- | ------------------- |
| completed trials                 | 3/3     | 1/3 (+2 incomplete)        | summary.json        |
| sent bytes                       | 29,882  | 77,395                     | summary metrics     |
| input tokens (complete coverage) | 7,200   | 18,083                     | usage, coverage 1.0 |
| output tokens                    | 4,591   | 8,106                      | usage               |
| submitted patch ops              | 0       | 11 extracted / 2 generated | updates.jsonl       |
| actor calls                      | 16      | 21                         | calls.jsonl         |

Submitted patch ops are the count the actor sent; v2 records do not store per-op apply/drop
outcomes, so applied counts are **unavailable** for these runs. The llm incompletes are
`iter0-protected-constraint-llm` (79.6 s wall, recorded `rereads: 2`) and
`iter0-observation-derived-llm` (118.5 s wall, `rereads: 5`).

The recorded `rereads` counter means "a `read` on `path|observationGeneration` already seen" —
a workspace mutation between reads makes the key fresh even when the file itself was untouched.

## Re-read analysis of the two llm incompletes

Method: `review-02/analyze_rereads.mjs` rebuilds each step's view strictly from that step's
recorded sent input (memory item texts + latest-observation item texts), the actor action from
`calls.jsonl` `responseText`, and file contents from the next step's observation. Cases are
classified by `analyzeRereads()` in `src/experiments/hybrid-state/reread.ts`. Results are saved
under `.local/hybrid-state/review-02/`; the earlier review-01 output is retained unchanged.

Two corrections relative to the first analysis:

- **Verbatim absence is not necessity.** The earlier pass translated "the original text is not
  in the recorded input" directly into `necessary_detail_missing`. The corrected classifier
  reports `verbatimPresent`, `markersFound` (content-derived literals visible in the input), and
  `required` (named details the planned work needed) separately, and emits
  `necessary_detail_missing` only when a named required detail is absent. With no recorded
  requirement the necessity of an absence stays `undetermined`.
- **Scope is the user body only.** Old runs never recorded the system prompt, so every case is
  `evidenceScope: "user_only"`; absence claims apply to the recorded portion of the input and
  are never widened to "the whole input lacked it".

Patch-drop evidence remains **unavailable** (v2 update records carry no per-op outcome), so
`not_saved` cannot be distinguished from never-proposed.

### observation-derived/llm — 5 re-read events (steps 3–7)

Memory held the extracted values (`PRIMARY_PORT=9377`, `FALLBACK_PORT=8080`) and the task
constraint from step 1 onward — all retained at the final checkpoint. Yet the actor re-read
`docs/net-policy.md` (steps 3, 5, 7) and `src/server.js` (steps 4, 6). At every re-read the
file's verbatim text was absent from the recorded user input (`verbatimPresent: false`,
`markersFound: 0`), and no test was ever run. Classification per case: `not_saved` + `unknown`,
`necessity: undetermined` — the files' content was not represented in the recorded input, but
what the actor planned to do next is not recorded, so whether a _needed_ detail was missing
cannot be asserted from these artifacts.

### protected-constraint/llm — 4 re-read events (steps 2, 4, 5, 6)

The actor did save memory: the apiKey-preservation constraint summary (step 3), the full
`src/config.js` source (step 3), its own edit result (step 5), and — mistakenly — the literal
text of a read tool_call (step 6). `docs/deploy.md` was re-read at steps 2, 4, 6 with its
verbatim text absent from the recorded user input each time (`not_saved` + `unknown`,
necessity undetermined); `src/config.js` was re-read at step 5 after the actor's own edit
(`stale_or_conflicting`, observed — a legitimate re-verification). `config-check` passed in the
final workspace; the trial ended on the 8-action budget without a `finish` call.

### What is confirmed vs. still a hypothesis

- **Confirmed**: re-read events happened (counts above); at each, the file's verbatim text was
  absent from that step's recorded user input; extracted values were retained in memory; the
  step-5 `src/config.js` re-read followed the actor's own edit; both trials died on the action
  budget.
- **Not confirmed**: whether any re-read fetched _needed_ detail (the planned next action is not
  recorded), and any motivational story — "the model distrusts its memory" — fits at least two
  other explanations: the verbatim detail was never saved (patches missing, minimal, or dropped;
  v2 records cannot distinguish), and the prompt gave no reason to expect the text to persist.
  A definitive answer needs per-op outcomes and the new `last_update_result` feedback, which the
  follow-up protocol now records.

## Known contamination and limits of the old runs

- The llm system prompt at `fa69e43` contained a worked example with the literal
  `FALLBACK_PORT=8080` — the scored answer of the observation-derived task. The line is absent
  at `633d62e` and was introduced in `fa69e43`; because system prompts were not recorded and the
  tree was dirty, per-run presence is inferred (likely for runs 2–6) rather than verified. Either
  way, old llm results ran under a condition where one side may have seen task answers; they are
  not a fair comparison and are kept only as history.
- Same-task iteration: prompts were adjusted against these very tasks, so later measurements on
  them are development-set observations, not generalization evidence.
- One iteration per cell; eight-action budget; synthetic tasks. Nothing here supports a rate,
  cost, or superiority claim, and input-token ratios were not converted to money.

## The follow-up protocol (`stage-a-followup-1`, result schema 3)

Fixed in code and locked by tests L-01–L-16:

- The llm example is task-agnostic; no scored name or value appears in either system prompt.
- Patch input is recorded as `missing` / `empty` / `present`; malformed patches stay errors.
- The previous step's patch outcome is sent back as `last_update_result` (snake_case wire shape,
  ≤ 2 KiB detail cap, counts + indexes + short reason codes, never resubmitted content).
- Both modes receive an identical `action_budget` (`limit`, `used`,
  `remaining_including_next`, `finish_counts_as_action`); no ninth call and no auto-finish.
- Trials report `terminationReason`, `finishedWithinBudget`, evaluator-side `finalArtifact`,
  `finalConstraintVerdicts`, and `actorVerificationAtStop` (with `current`/`stale` freshness)
  independently — a budget-exhausted trial's artifact is still scored when the workspace is
  evaluable.
- Results carry `schemaVersion: 3` + `protocolId`; `report` cross-checks summary↔manifest and
  renders v2 results read-only without inventing the new fields.

Future live comparison conditions (not executed here): the same 3 approved tasks, history vs
llm, `maxActions: 8`, actor-only calls, 3 iterations ⇒ `maxRequests: 144`, `timeoutMs: 120000`
shared across modes, a real `actorModel` id filled into
`config.stage-a.followup.live.example.json`, `executionIsolation: required`, and an explicit
`--live`. Any additional retries or budget variants are separate, pre-declared analyses.
