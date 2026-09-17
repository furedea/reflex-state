# ReflexState

**SKILL.state × Jev for Pi.**

English | [日本語](README_ja.md)

ReflexState adapts the explicit execution state idea from Google's
[SKILL.state](https://arxiv.org/abs/2608.26263) to
[Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
[TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) and deterministic
code maintain that state independently of the main reasoning LLM.

- **The main model reasons and acts.** It receives the current run and structured state:
  the goal, changed files, verification results, and active blockers.
- **Jev makes semantic decisions.** Typed answers determine whether an error is a blocker,
  whether new evidence resolves it, what remains relevant, and whether the task is complete.
- **Code extracts facts and applies updates.** File changes and command results come from
  execution events. Gated Jev decisions update state through deterministic code.

The aim is to make repeated state maintenance cheaper and faster while preserving agent
performance. This alpha provides the runtime and measurements to test that hypothesis.
State inspection and recorded replay make those updates traceable and reproducible.

**Alpha preview:** [Try it locally](#run-locally) with a TypeSafe API key for Jev.
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
to Pi by retaining the complete current run alongside its execution state.

Projection keeps the complete current run, including steers and matched tool exchanges, then
appends a bounded `<reflex-state>` text block to its newest user or tool-result message. The
block includes state, recent requests, and verbatim failure evidence. Projection changes the
outgoing context only; it never rewrites or deletes the Pi session log. Incomplete exchanges,
missing goal text, compaction, or an insufficient block budget preserve the original context.

## Configuration and controls

Precedence is defaults, global config, trusted project config, environment, then session toggles.
The global file is `~/.pi/agent/reflex-state.json`, or
`$PI_CODING_AGENT_DIR/reflex-state.json` when Pi's directory override is set. Project config is
`.pi/reflex-state.json` and is read only for trusted projects. Toggles are reapplied from config
and environment when the runtime is restored, including branch switches.

Example project config:

```json
{
  "projection": { "placement": "last-message" },
  "verificationCommands": { "test": ["^make check$"] }
}
```

Additional command regexes extend built-in test/build/lint detection. Unknown keys warn;
invalid types, thresholds, limits, regexes, or credential fields reject the file and restore
defaults. Full defaults live in [core/config.ts](https://github.com/furedea/reflex-state/blob/main/src/core/config.ts) and the
[configuration specification](https://github.com/furedea/reflex-state/blob/main/docs/spec/reflex_state_v0.1_spec_claude.md#21-configuration).

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
| `REFLEX_STATE_PROJECTION=0`  | Start with original Pi context                                                  |

Default Jev limits are a 3-second SDK timeout, zero retries, and a 4-second outer deadline
linked to Pi cancellation. Three consecutive failures open a 60-second circuit; a subsequent
probe can close it. Authentication failures disable the updater until recreated. Uncertain
answers do not apply semantic changes. Phase questions run in shadow alongside required
questions and never control activity directly.

## What is sent to TypeSafe

When Jev is enabled, a required decision sends bounded user request text, the current typed
state, file paths, relevant bash/edit/write result excerpts, and bounded final assistant text
when deciding completion. The JSON input has a 24,000-byte ceiling. Read/grep/find/ls results
produce zero Jev calls and their output text is excluded from other requests.

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
normalized from Pi message entries. Export writes `events.jsonl`, `transitions.jsonl`, and
`trace_meta.json`, leaving the source file unchanged.

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

- Earlier runs are omitted from projected context. Only retained state and bounded excerpts
  carry their information forward; this may lose useful context and does not establish token
  savings or improved task success.
- Bash-driven file changes are not tracked. Only successful Pi edit/write results and explicit
  `file_change` events update modified files.
- Verification detection is heuristic, not a shell parser. Compound commands report the overall
  outcome for one kind with test > build > lint precedence, without proving every segment ran.
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

The [reviewed specification](https://github.com/furedea/reflex-state/blob/main/docs/spec/reflex_state_v0.1_spec_claude.md) owns requirements.
The [original draft](https://github.com/furedea/reflex-state/blob/main/docs/spec/reflex_state_v0.1_spec_gpt6_pro.md) is archival.
[Phase 0 findings](https://github.com/furedea/reflex-state/blob/main/docs/spec/phase0_findings.md) record compatibility evidence and outstanding
live checks; [ADR-0002](https://github.com/furedea/reflex-state/blob/main/docs/adr/0002_compose_adapters_at_entry_points.md) explains composition.
