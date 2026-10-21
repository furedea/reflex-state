import type {
  CallRecord,
  ContextRecord,
  EvaluationKind,
  ExperimentEnvironment,
  ExperimentMode,
  ExperimentSummary,
  ModeMetrics,
  ProviderMode,
  SkippedTrial,
  TrialScore,
  UsageFieldSummary,
} from "./types.js";
import { PROTOCOL_ID, RESULT_SCHEMA_VERSION } from "./types.js";

export const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

export function summarize(options: {
  readonly runId: string;
  readonly evaluation: EvaluationKind;
  readonly provider: ProviderMode;
  readonly modes: readonly ExperimentMode[];
  readonly scores: readonly TrialScore[];
  readonly plannedTrials: number;
  readonly skipped: readonly SkippedTrial[];
  readonly calls: readonly CallRecord[];
  readonly contexts: readonly ContextRecord[];
  readonly uniqueCandidates: ReadonlyMap<ExperimentMode, ReadonlySet<string>>;
  readonly decisionCounts: ReadonlyMap<ExperimentMode, number>;
  readonly appliedCounts: ReadonlyMap<
    ExperimentMode,
    { readonly extractive: number; readonly generated: number }
  >;
  readonly environment?: ExperimentEnvironment;
  readonly limitations?: readonly string[];
}): ExperimentSummary {
  const metrics = Object.fromEntries(
    options.modes.map((mode) => {
      const modeCalls = options.calls.filter((call) => call.mode === mode && call.providerInvoked);
      const fieldSummary = (field: (typeof USAGE_FIELDS)[number]): UsageFieldSummary => {
        const observed = modeCalls
          .map((call) => call.usage?.[field])
          .filter((value): value is number => typeof value === "number");
        return {
          observedSubtotal: observed.length
            ? observed.reduce((total, value) => total + value, 0)
            : null,
          completeTotal:
            modeCalls.length > 0 && observed.length === modeCalls.length
              ? observed.reduce((total, value) => total + value, 0)
              : null,
          coverage: modeCalls.length ? observed.length / modeCalls.length : 0,
        };
      };
      const scores = options.scores.filter((score) => score.mode === mode);
      const metric: ModeMetrics = {
        uniqueCandidates: options.uniqueCandidates.get(mode)?.size ?? 0,
        decisionCount: options.decisionCounts.get(mode) ?? 0,
        appliedExtractive: options.appliedCounts.get(mode)?.extractive ?? 0,
        appliedGenerated: options.appliedCounts.get(mode)?.generated ?? 0,
        invocations: {
          actor: modeCalls.filter((call) => call.kind === "actor").length,
          jev: modeCalls.filter((call) => call.kind === "jev").length,
          repair: modeCalls.filter((call) => call.kind === "repair").length,
          update: modeCalls.filter((call) => call.kind === "update").length,
        },
        sentBytes: modeCalls.reduce((total, call) => total + call.requestBytes, 0),
        usage: {
          inputTokens: fieldSummary("inputTokens"),
          outputTokens: fieldSummary("outputTokens"),
          cacheReadTokens: fieldSummary("cacheReadTokens"),
          cacheWriteTokens: fieldSummary("cacheWriteTokens"),
        },
        wallMs: scores.reduce((total, score) => total + score.wallMs, 0),
        contextBytes: options.contexts
          .filter((context) => context.mode === mode)
          .reduce((total, context) => total + context.sentBytes, 0),
      };
      return [mode, metric];
    }),
  ) as Record<ExperimentMode, ModeMetrics>;
  const scores = options.scores;
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    protocolId: PROTOCOL_ID,
    runId: options.runId,
    evaluation: options.evaluation,
    provider: options.provider,
    modes: [...options.modes],
    efficacyStatus: options.provider === "live" ? "descriptive_only" : "not_evaluated",
    wiring: {
      passed: scores.filter((score) => score.wiringStatus === "passed").length,
      failed: scores.filter((score) => score.wiringStatus === "failed").length,
      notEvaluated: scores.filter((score) => score.wiringStatus === "not_evaluated").length,
    },
    scores,
    plannedTrials: options.plannedTrials,
    skippedTrials: options.skipped,
    metrics,
    ...(options.environment ? { environment: options.environment } : {}),
    limitations: [...(options.limitations ?? defaultLimitations(options))],
  };
}

function defaultLimitations(options: {
  readonly provider: ProviderMode;
  readonly evaluation: EvaluationKind;
}): readonly string[] {
  const limitations: string[] = [];
  if (options.provider === "fake")
    limitations.push(
      "fake providers establish wiring only; efficacy is not evaluated",
      "task completion by scripted actors is not task performance",
    );
  if (options.provider === "recorded")
    limitations.push("recorded providers replay captured responses; efficacy is not evaluated");
  if (options.provider === "live")
    limitations.push(
      "descriptive measurements only; no automatic winner is declared",
      "usage coverage depends on provider-reported fields",
    );
  if (options.evaluation === "trace_audit")
    limitations.push("audit replays a fixed trace; update calls are diagnostic, not closed-loop");
  return limitations;
}
