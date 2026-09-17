# State safety validation

## Review baseline

- Repository: `furedea/reflex-state`
- Review target: `1768e4c56e2faa3f87e40a9bfd15e271e5b3e60d`
- Implementation branch is based on that commit; the target was not force-reset.

## Regression mapping

| ID  | Executable evidence                                                                        |
| --- | ------------------------------------------------------------------------------------------ |
| P1  | `src/pi/projection.test.ts`: default disabled and append preservation                      |
| P2  | `src/pi/projection.test.ts`: previous proposal retained for current-run                    |
| P3  | `src/pi/projection.test.ts`: two-run retention and immutable input                         |
| P4  | `src/pi/projection.test.ts`: opaque and incomplete fallback                                |
| V1  | `src/core/reducer.test.ts`: possible changes stale prior verification                      |
| V2  | `src/core/reducer.test.ts`: different check keys retain blockers                           |
| V3  | `src/core/reducer.test.ts`: matching re-check resolves after a new generation              |
| V4  | `src/core/verification.test.ts`: shell compounds are not attributable                      |
| V5  | `src/core/verification.test.ts`, `src/pi/normalization.test.ts`: truncation is unknown     |
| V6  | `src/core/reducer.test.ts`: pending/intervening edit prevents current freshness            |
| V7  | `src/pi/persistence.test.ts`: resume invalidation and branch restoration                   |
| B1  | `src/core/state_view.test.ts`: nine blockers persist, eight are displayed                  |
| B2  | `src/core/reducer.test.ts`: an unresolved blocker prevents completion                      |
| B3  | `src/core/reducer.test.ts`: semantic relevance does not delete blockers                    |
| W1  | `src/pi/state_block.test.ts`: recorded working-set error content                           |
| W2  | `src/pi/state_block.test.ts`: unavailable evidence and omitted totals                      |
| J1  | `src/typesafe/request_plan.test.ts`: one plan drives questions and evidence                |
| J2  | `src/typesafe/input.test.ts`, `src/typesafe/updater.test.ts`: redaction and failure gates  |
| R1  | `src/replay/runner.test.ts`, `src/pi/trace.test.ts`: recorded state and trace behavior     |
| R2  | `src/pi/persistence.test.ts`, `src/pi/smoke.test.ts`: legacy reset path                    |
| R3  | `src/core/serialization.test.ts`, `src/replay/trace.test.ts`: invalid and legacy rejection |
| M1  | `src/pi/projection.test.ts`, `src/core/metrics.test.ts`: no within-run deletion            |

## Commands

The following offline checks are the required final gates:

```sh
pnpm check
pnpm build
pnpm package:check
```

Additional focused regression commands used during implementation are:

```sh
pnpm exec vitest run src/core/verification.test.ts src/core/state_view.test.ts
pnpm exec vitest run src/pi/projection.test.ts src/pi/state_block.test.ts
pnpm exec vitest run src/typesafe/request_plan.test.ts
```

The real Pi smoke test is offline and uses the pinned loader and local tools. It must be included
in the final `pnpm test` result. No live Jev or provider request is part of this validation.

## Results (2026-09-18)

- `pnpm check`: passed. Format, lint, typecheck, 24 offline test files (136 passed, 1 skipped),
  14 release-script tests, and knip all passed.
- `pnpm build`: passed with TypeScript 6.0.3.
- `pnpm run package:check`: passed. The package contents and export/replay commands were checked;
  npm printed environment-option warnings that do not affect the result.
- The skipped test is the opt-in live Jev contract. It remains unexecuted because this task does
  not use `TYPESAFE_API_KEY` or an external service.

## Not executed

`REFLEX_STATE_LIVE_JEV=1 pnpm exec vitest run src/typesafe/live_contract.test.ts` was not run.
It requires `TYPESAFE_API_KEY` and a live external service. npm publication, GitHub Release,
secrets, and billing settings were not changed. This document does not treat those checks as
successful.
