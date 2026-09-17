# ReflexState v0.1.0-alpha.1 — draft release notes

This is publication copy for review, not an announcement that a release is available. Update
the validation status before publishing these notes.

ReflexState adds execution state to Pi coding sessions: the current goal, changed files,
verification results, and blockers. Inspect them with `/state`, review transitions with
`/state history`, and export a session for deterministic replay.

## Try the preview

After this version has been published, with Pi installed:

```sh
pi install npm:reflex-state@next
REFLEX_STATE_DISABLE_JEV=1 pi
```

Ask Pi to fix a small failing test, then inspect `/state` before and after the fix. The preview
works without TypeSafe credentials. Jev is optional and adds semantic decisions to deterministic
state extraction.

Node.js 22.19 or later is required. Pi 0.83.0 is the host version used by the offline integration
and package smoke tests. See the [README](../README.md) for local installation, configuration,
export, and replay commands, or [日本語の README](../README_ja.md).

## Included in this preview

- Typed state derived from Pi events, with bounded source evidence and no generated summaries.
- Branch-aware session restoration, state inspection, and configurable context projection.
- Export and replay commands; recorded decisions reproduce the saved state pipeline exactly.
- One tested npm tarball used for npm and GitHub distribution, with checksums and build provenance
  produced by the release workflow.

## Validation and limits

Offline checks cover Pi's real extension loader, local tools, session persistence, branches,
projection, packaged command execution, and recorded replay. Successful live provider and Jev
checks are still outstanding; see the [verification record](spec/phase0_findings.md).

This alpha does not establish token savings or better task completion. Context projection omits
earlier runs and may omit useful information. Bash-driven file changes are not tracked, and
verification detection is heuristic. Keep projection disabled if it does not suit a task.

## Feedback

Report installation failures, missing state, or replay mismatches in
[GitHub Issues](https://github.com/furedea/reflex-state/issues). Include Pi, Node.js, and ReflexState
versions, the relevant command, and a minimal reproduction. Review and redact any session excerpts
before sharing them; raw local traces can include source code and tool output.
