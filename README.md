# ReflexState

**Your agent reasons. ReflexState keeps track.**

English | [日本語](README_ja.md)

ReflexState gives [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
coding agents a dedicated execution-state layer.
It tracks what changed, which checks are still current, and what remains
blocked—independently of the main reasoning LLM.

**[TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) makes typed
semantic decisions. Code extracts facts and applies updates.**
Inspect the state as your agent works, or explicitly add it to the model's context.

Built around the execution-state idea from Google's
[SKILL.state](https://arxiv.org/abs/2608.26263), ReflexState explores a different division
of labor: keep reasoning and coding with the main model, and maintain execution state with
Jev and deterministic code.

## Why ReflexState?

- **Separate reasoning from state maintenance.** Maintain structured execution state without
  asking the main model to generate state summaries. Jev handles bounded semantic questions;
  code controls how answers change the state.
- **Track what is still true.** Distinguish earlier test success from current verification.
  Keep unresolved blockers even when their details do not fit in the displayed context.
- **Inspect the evidence. Replay the updates.** Trace state changes to execution events and
  recorded decisions. Replay recorded state transitions without calling Jev again.

**Alpha preview.** Context injection is opt-in. Append mode adds state without removing
conversation history. End-to-end cost and performance gains have not yet been established.
See [verification and limitations](#verification-and-limitations) for current coverage.

## Install the preview

The npm command requires the first preview release. Until it is available, use the local
checkout instructions below. With Pi installed and `TYPESAFE_API_KEY` set in your environment:

```sh
pi install npm:reflex-state@next
pi
```

Run `/state` to see the current goal, changed files, verification results, and blockers.
For a baseline using only deterministic code, start with `REFLEX_STATE_DISABLE_JEV=1 pi`;
that mode needs no TypeSafe key. Node.js 22.19 or later is required, and Pi 0.83.0 is the
verified host version.

## Run locally

Use Node.js 22.19 or later, pnpm 10.33.0, and Pi 0.83.0. Dependencies are pinned; Pi is a
development dependency and TypeSafe SDK 0.6.0 is the only runtime dependency. Set
`TYPESAFE_API_KEY` in your environment to run with Jev.

```sh
pnpm install --ignore-scripts
pnpm exec pi
```

Trust this checkout in Pi to load its `.pi/extensions/reflex_state.ts` entry automatically.
To load an explicit path, including from another project:

```sh
pnpm exec pi --no-extensions -e ./src/pi/index.ts
```

The explicit command disables discovery to avoid loading both entries in this checkout.
When running elsewhere, use the absolute path to `src/pi/index.ts`. No Pi patch is required.

To try the deterministic baseline, use `REFLEX_STATE_DISABLE_JEV=1 pnpm exec pi`.
The SDK reads `TYPESAFE_API_KEY` from the environment; keys are rejected in ReflexState config
files. Missing or rejected credentials disable Jev for that runtime and produce one notification;
deterministic state updates continue. `/state jev on` creates a fresh updater after credentials
are corrected.

## Architecture

| Component                                   | Responsibility                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/core/`                                 | Raw events, pure extraction, gated decisions, reducer, serialized engine, metrics |
| `src/typesafe/`                             | Atomic Choice/Noul questions, redaction, confidence gates, deadlines and circuit  |
| `src/pi/`                                   | Pi hooks, branch restoration, commands, widget, ephemeral context projection      |
| `src/replay/`                               | The same state pipeline applied to exported events and recorded decisions         |
| `src/composition.ts` and executable entries | Assemble adapters through core interfaces                                         |

Each processed event appends a `reflex-state.transition` custom entry containing the event,
resulting state, effective config, cwd, and decisions. Restoration follows only the active Pi
branch after its latest reset. IDs remain monotonic across resets and branch switches.
The reducer is shared by live execution and replay; core imports no Pi or TypeSafe code.

The SKILL.state paper supplies the latest observation at each step. ReflexState adapts this
to Pi by keeping execution state alongside the conversation.

Projection is disabled by default. `append` adds a bounded `<reflex-state>` block while keeping
every original message. Experimental `current-run` keeps the current run and the immediately
preceding ended run, including steers and matched tool exchanges, but may omit older ordinary
conversation. Neither mode removes messages from inside a run. Projection changes the outgoing
context only; it never rewrites or deletes the Pi session log. Incomplete exchanges, unknown
messages, missing goal text, compaction, or an insufficient block budget preserve the original
context.

## Configuration and controls

Precedence is defaults, global config, trusted project config, environment, then session toggles.
The global file is `~/.pi/agent/reflex-state.json`, or
`$PI_CODING_AGENT_DIR/reflex-state.json` when Pi's directory override is set. Project config is
`.pi/reflex-state.json` and is read only for trusted projects. Toggles are reapplied from config
and environment when the runtime is restored, including branch switches.

Example project config:

```json
{
  "projection": {
    "enabled": true,
    "mode": "append",
    "placement": "last-message"
  },
  "limits": { "maxProjectedBlockers": 8 },
  "verificationCommands": { "test": ["^make check$"] }
}
```

To try the experimental history selection explicitly:

```json
{
  "projection": { "enabled": true, "mode": "current-run" }
}
```

`limits.maxActiveBlockers` is accepted as a deprecated alias with a warning. It no longer
limits the unresolved blocker record; `maxProjectedBlockers` limits display only.

Additional command regexes extend built-in test/build/lint detection. Unknown keys warn;
invalid types, thresholds, limits, regexes, or credential fields reject the file and restore
defaults. Full defaults live in [core/config.ts](https://github.com/furedea/reflex-state/blob/main/src/core/config.ts).

| Control                      | Effect                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `/state`                     | Current goal reference, activity, files, verification, blockers and working set |
| `/state history [n]`         | Recent transitions and decision gates                                           |
| `/state stats`               | Measured usage, latency, projection counts and updater health                   |
| `/state debug`               | Latest semantic decisions, question IDs and raw probabilities                   |
| `/state reset`               | Confirm, append a reset marker, and clear hot state                             |
| `/state projection on\|off`  | Toggle context projection for the current runtime                               |
| `/state jev on\|off`         | Toggle semantic decisions for the current runtime                               |
| `REFLEX_STATE_DISABLE=1`     | Disable state recording and projection                                          |
| `REFLEX_STATE_DISABLE_JEV=1` | Start with deterministic updates only                                           |
| `REFLEX_STATE_PROJECTION=1`  | Enable the configured projection mode                                           |
| `REFLEX_STATE_PROJECTION=0`  | Start with original Pi context                                                  |

Default Jev limits are a 3-second SDK timeout, zero retries, and a 4-second outer deadline
linked to Pi cancellation. Three consecutive failures open a 60-second circuit; a subsequent
probe can close it. Authentication failures disable the updater until recreated. Uncertain
answers do not apply semantic changes. Phase questions run in shadow alongside required
questions and never control activity directly.

## What is sent to TypeSafe

When Jev is enabled, a bounded request plan selects each question together with the evidence it
needs. Inputs contain bounded user request text, the current typed state, file paths, relevant
bash/edit/write evidence, and bounded final assistant text when deciding completion. The JSON
input has a 24,000-byte ceiling; a question whose evidence cannot fit is omitted with a local
reason. Read/grep/find/ls results produce zero Jev calls and their output text is excluded from
other requests.

Common credential patterns, bearer credentials, private-key blocks and environment assignments
are redacted before sending. This is pattern-based filtering, not a guarantee that arbitrary
sensitive text is recognized. Source code can still appear in test errors or other tool output.
Raw local transition records retain bounded inputs and excerpts; outbound redaction does not
rewrite the original Pi history. SDK logging excludes request/response contents. Invalid
responses record expected field types, never unexpected response values.

## Export and replay

From a published package, run the commands without cloning this repository:

```sh
npm exec --package=reflex-state@next -- reflex-state-export /path/to/session.jsonl --out trace-output
npm exec --package=reflex-state@next -- reflex-state-replay trace-output/events.jsonl --updater noop --out replay-output
```

From a local checkout:

```sh
pnpm export-trace /path/to/session.jsonl --out trace-output
pnpm replay trace-output/events.jsonl --updater noop --out replay-output
pnpm replay trace-output/events.jsonl --updater recorded --out replay-recorded
```

Export follows the last stored leaf, or `--leaf <entry-id>`. Existing ReflexState transitions
provide their original events and decisions after the latest reset; sessions without them are
normalized from Pi message entries. A legacy state is marked as legacy and is never presented as
a v2 recording. Export writes `events.jsonl`, `transitions.jsonl`, and `trace_meta.json`, leaving
the source file unchanged.

Replay writes `final_state.json`, `transitions.jsonl`, `metrics.json`, and `summary.txt`.
`noop` is deterministic; `jev` makes live semantic requests. `recorded` reads the neighboring
`transitions.jsonl`, or use `--updater recorded:/path/to/transitions.jsonl`. It verifies matching
events and reuses each recorded configuration, cwd, timestamp, and decision to reproduce the
final state. It requires an existing decision log; a raw Pi session alone cannot supply one.

`--config <file>` and `--cwd <directory>` override defaults for ordinary replay. Exported
metadata supplies those defaults when present; recorded mode uses each transition's settings.
Missing usage stays unavailable (`n/a` in `/state stats`, omitted from JSON), never estimated.
Jev call counts mean client invocations, including failed attempts, not confirmed billable calls.

## Verification and limitations

```sh
pnpm check
pnpm build
pnpm package:check
REFLEX_STATE_LIVE_JEV=1 pnpm exec vitest run src/typesafe/live_contract.test.ts
```

The last command requires `TYPESAFE_API_KEY` and makes one live System One request. It is skipped
by default. Offline tests cover deterministic behavior, gating, redaction, deadlines, outage
handling, projection, branches, and exact replay. Pi smoke tests use the real 0.83.0 loader,
extension runner, local write/edit/bash tools, and on-disk session manager with model networking
disabled. Both explicit loading and trusted `.pi/extensions` discovery are exercised.

Current limitations:

- `append` retains history but does not reduce context size. `current-run` can omit runs older
  than the immediately preceding ended run; it is experimental and does not establish token
  savings or improved task success. Both modes preserve messages within a run.
- Bash is treated as a possible workspace change. Verification results become stale after
  edits, writes, file-change events, bash, resume, or branch switching; the project does not
  automatically rerun checks.
- Verification detection is conservative and heuristic, not a shell parser. Compound commands,
  truncated commands, and incomplete old events are unknown and cannot clear a blocker.
- A passed result describes that command's observed result and target, not every assertion or all
  checks in a project. Different commands and working directories remain different checks.
- Legacy v1 state is not automatically migrated. Stop state updates and projection, then use
  the confirmed `/state reset` to begin a v2 state interval. Recorded replay of legacy state is
  rejected; use the original implementation for strict legacy replay.
- Thresholds are heuristics without calibration. Live Jev outputs can vary; only recorded
  decisions provide exact semantic replay.
- State blocks and working sets are bounded. There is no recall tool, within-run pruning,
  benchmark framework, or adapter for another agent in v0.1.
- Pi delays creation of a new session file until its first assistant message. ReflexState uses
  Pi's append API and inherits that persistence behavior.
- Live TypeSafe requests, interactive provider runs, and multi-text tool-result round trips
  through Anthropic, OpenAI-compatible, and Google APIs have not been verified here. If a
  provider rejects the appended tool-result block, set `projection.placement` to `run-start`
  or disable projection. Run-start placement may reduce prompt-cache reuse.

[State safety contract](docs/state_safety_contract.md) defines the v2 state, freshness, blocker,
projection, budget, and legacy rules. [Validation notes](docs/state_safety_validation.md) map those
rules to regression tests and offline verification.

[ADR-0001](https://github.com/furedea/reflex-state/blob/main/docs/adr/0001_compose_adapters_at_entry_points.md) explains composition.
