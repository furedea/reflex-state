# Hybrid state validation

The implementation was started from the existing `feat/state-safety` checkout at commit
`88e059d0169239c59e9c6cba2cd0d89d306c00d4` after checking the working tree, package scripts, TypeScript configuration, and installed
Pi SDK. The requested reference commit was not checked out or reset.

The prototype is isolated under `src/experiments/hybrid-state/`. It reuses the core `HotState`
shape and `blockerView`, and it uses `StateEngine` with the existing normalizer at the closed-loop
action boundary. No Pi extension import starts the experiment automatically.

## Offline evidence

| Evidence                  | Command                                                                                                                 | Result                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| TypeScript build contract | `pnpm exec tsc -p tsconfig.build.json --noEmit`                                                                         | passed                                                                                                |
| Hybrid regression tests   | `pnpm exec vitest run src/experiments/hybrid-state`                                                                     | 4 files, 12 tests passed                                                                              |
| Trace audit               | `pnpm experiment:hybrid -- audit --config experiments/hybrid-state/config.offline.json --out .local/hybrid-state/audit` | fake/recorded-free run completed; output includes manifest, updates, calls, contexts, summary, report |
| Closed loop               | `pnpm experiment:hybrid -- run --config experiments/hybrid-state/config.offline.json --out .local/hybrid-state/run`     | 3 synthetic tasks × 4 modes completed with fake actor                                                 |
| Report rendering          | `pnpm experiment:hybrid -- report --input .local/hybrid-state/run`                                                      | report generated from `summary.json`                                                                  |

The offline run is not a real model evaluation. The fake actor follows task actions so the safe
workspace boundary, per-exchange projection, branch separation, and output accounting can be
checked without network access. The audit fixture is synthetic and its labels are marked
`reviewed: false`.

## Required acceptance evidence

The tests cover visible-only trace extraction, UTF-16 source offsets, explicit leaf selection,
history growth, state-first removal of old conversation, Facts budget failure, trust separation,
Jev selection of existing candidates, invalid patch preservation, and the four-mode closed loop.
The generated `contexts.jsonl` records the input parts and byte sizes; when privacy text recording
is disabled it does not contain the raw prompt.

## Not performed

No live Jev, actor, or repair request was made. No private session was supplied. No human review of
the synthetic labels was performed. No claim about real task success, cost, latency, statistical
non-inferiority, or general superiority is supported. The regular repository `pnpm check`, build,
and package check remain required final gates after this change; any dependency or environment
failure in those gates must remain visible rather than being treated as an experiment result.
