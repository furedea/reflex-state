export { defaultConfig } from "./core/config.js";
export type { ReflexStateConfig } from "./core/config.js";
export { StateEngine } from "./core/engine.js";
export { extractFacts } from "./core/extraction.js";
export type { ExtractionContext } from "./core/extraction.js";
export {
  classifyVerification,
  normalizeCommand,
  normalizeCwd,
  verificationCheckKey,
} from "./core/verification.js";
export type { VerificationClassification } from "./core/verification.js";
export { blockerView, stateView, workingSetView } from "./core/state_view.js";
export { Metrics } from "./core/metrics.js";
export { initialState, reduce } from "./core/reducer.js";
export type * from "./core/types.js";
export { NoopStateUpdater, RecordedDecisionsUpdater } from "./core/updater.js";
export type { StateUpdater, StateUpdateContext, UpdaterHealth } from "./core/updater.js";
