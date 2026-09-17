# ADR-0003: Publish one verified package

- Status: Accepted
- Date: 2026-09-17

In the context of distributing ReflexState as a Pi extension and Node.js commands, facing the
risk that repository tests pass while a published package is incomplete or differs between
distribution channels, we decided to build and verify one npm tarball and publish those same
bytes with provenance through one release workflow, against independently rebuilding each
distribution or using source archives as the installable product, to make downloaded artifacts
traceable to the tested package and source commit, accepting coordinated publication and
explicit recovery when one distribution service succeeds before the other.
