# ADR-0002: Compose adapters at entry points

- Status: Accepted
- Date: 2026-09-17

In the context of Pi and replay sharing a replaceable semantic updater, facing the specification's
sibling-import prohibition, we decided to inject core interfaces into adapters and assemble concrete
implementations only at executable entry points and `src/composition.ts`, rather than make core
discover providers or let adapter internals import one another. This keeps extraction and reduction
independent of both providers, accepting explicit factory plumbing at the outer boundary.

`src/pi/index.ts` is the Pi composition entry; replay/export CLI entries live directly under `src/`.
The exception does not apply to core or other adapter modules.
