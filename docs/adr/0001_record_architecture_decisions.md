# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-09-17

In the context of an experimental state manager with replaceable adapters, facing decisions
whose rationale spans components, we decided to record broad decisions in `docs/adr/` rather
than repeat their rationale in implementation comments, to preserve alternatives and trade-offs,
accepting the small maintenance cost of immutable decision records. Requirements remain in the
[v0.1 specification](../spec/reflex_state_v0.1_spec_claude.md).
