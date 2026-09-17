# ReflexState v0.1.0-alpha.1 — draft release notes

This is publication copy for review, not an announcement that a release is available. Update
the validation status before publishing these notes.

ReflexState brings the explicit execution state idea from Google's
[SKILL.state](https://arxiv.org/abs/2608.26263) to Pi, with
[TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) making semantic
state decisions and deterministic code applying updates. The main LLM handles reasoning
and actions; Jev and code maintain the execution state independently.

## Try the preview

After this version has been published, with Pi installed and `TYPESAFE_API_KEY` set:

```sh
pi install npm:reflex-state@next
pi
```

Ask Pi to fix a small failing test, then inspect `/state` before and after the fix. Use
`/state debug` to inspect Jev's decisions and `/state history` to trace state updates.
For a baseline without Jev or TypeSafe credentials, start with `REFLEX_STATE_DISABLE_JEV=1 pi`.

Node.js 22.19 or later is required. Pi 0.83.0 is the host version used by the offline integration
and package smoke tests. See the [README](../README.md) for local installation, configuration,
export, and replay commands, or [日本語の README](../README_ja.md).

## Included in this preview

- Jev decisions for blockers, relevance, and task completion, applied through deterministic code.
- Typed state derived from Pi events, with bounded source evidence and no generated summaries.
- Branch-aware session restoration, state inspection, and configurable context projection.
- Export and replay commands; recorded decisions reproduce the saved state pipeline exactly.
- One tested npm tarball used for npm and GitHub distribution, with a checksum and GitHub artifact
  attestation. The first npm publication is manual; subsequent versions use OIDC and also include
  npm provenance.

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
