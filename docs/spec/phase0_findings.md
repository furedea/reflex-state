# Phase 0 findings

Verified on 2026-09-17 against the installed Pi 0.83.0 distribution, npm metadata, and installed
dependencies. This records verification evidence; the reviewed specification owns requirements.

- npm publishes `@earendil-works/pi-coding-agent@0.83.0` (2026-07-29) and
  `@typesafe-ai/sdk@0.6.0` (2026-09-15). Both are pinned. The latter has a version-specific
  `minimumReleaseAgeExclude` entry because it is explicitly required by the specification.
  The general seven-day rule remains enabled. Installation uses `--ignore-scripts`.
- Pi `SessionManager.getBranch()` returns **root to leaf**, despite the draft's leaf-to-root claim.
  Reconstruction must process the active branch in that order, respecting reset entries.
- Pi emits `session_tree` when navigating the existing session tree; `session_start` alone does
  not cover that operation. Both must reconstruct the runtime.
- `ExtensionContext` has `isProjectTrusted()` and `signal: AbortSignal | undefined`.
- Pi compaction calls its summarization function directly, outside the agent's `transformContext`
  hook. `session_compact` is emitted only on success. A failed/cancelled compaction must not leave
  projection permanently disabled; the next agent run clears the bypass flag.
- `buildSessionContext()` materializes the latest compaction as a `compactionSummary` message,
  followed by retained entries starting at `firstKeptEntryId`, then entries after compaction.
  Projection retains opaque messages inside the current run; it falls back if the recorded
  current goal no longer exists in the retained messages.
- Actual assistant types include `pending` as well as `toolUse`. Neither terminates a run for
  projection; an `agent_end` with either is normalized to `aborted`.
- Pi's global agent directory override is `PI_CODING_AGENT_DIR`. Its new-session persistence
  defers all writes until the first assistant message, then flushes pending entries. Custom
  ReflexState entries inherit this behavior.
- Offline integration checks load the explicit entry and discover the shipped wrapper in a
  trusted temporary project's `.pi/extensions`. They use Pi's real loader/runner and local
  write/edit/bash tools to observe a failed test, edit, and passing test. Disk reopening restores
  state; branch navigation and reset work; context projection leaves session bytes unchanged.
- CLI export followed by both noop and recorded replay reproduces a fixture's final state with
  custom command patterns from exported metadata. The source session remains byte-for-byte intact.
- Provider round trips and live Jev calls require explicit live-test opt-in and credentials.
  Static shape checks and mocked SDK calls do not count as live verification.

Outstanding live checks: TypeSafe Choice/Noul response and usage through the real service;
interactive Pi runs against configured providers; multi-text tool-result acceptance through
Anthropic, OpenAI-compatible, and Google APIs. Pre-release attempts on 2026-09-17 did not reach
the services successfully:

- The opt-in TypeSafe contract test stopped before a request because `TYPESAFE_API_KEY` was
  unavailable. It does not establish the live response or usage contract.
- Pi listed OpenAI Codex models through its normal CLI. A disposable edit/test fixture using
  `gpt-5.4-mini` was rejected as unsupported for the account; retrying with `gpt-5.5` stopped at
  the account usage limit. No successful provider round trip or interactive demo was observed.

These are environment blockers, not passing live checks. Repeat the live checks with working
credentials and provider quota before claiming support verified against those services.

Local primary sources: Pi `dist/core/session-manager.js`, `dist/core/extensions/types.d.ts`,
`dist/core/sdk.js`, `dist/core/agent-session.js`, `dist/core/compaction/compaction.js`.
External primary sources: [TypeSafe documentation](https://docs.typesafe.ai/introduction) and npm
package metadata obtained with `pnpm view`.
