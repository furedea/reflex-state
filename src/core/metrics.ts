import type {
  GatedDecision,
  ProjectionMeasurement,
  SemanticDecisions,
  StateTransitionRecord,
} from "./types.js";

export function decisionEntries(decisions: SemanticDecisions): [string, GatedDecision<unknown>][] {
  const entries: [string, GatedDecision<unknown> | undefined][] = [
    ["blocker_introduced", decisions.blockerIntroduced],
    ["failure_category", decisions.failureCategory],
    ["task_complete", decisions.taskComplete],
    ["phase_shadow", decisions.phaseShadow],
    ...decisions.resolvedBlockers.map((item): [string, GatedDecision<unknown>] => [
      "resolves_" + item.eventId,
      item.decision,
    ]),
    ...decisions.relevance.map((item): [string, GatedDecision<unknown>] => [
      "relevant_" + item.eventId,
      item.decision,
    ]),
  ];
  return entries.filter(
    (entry): entry is [string, GatedDecision<unknown>] => entry[1] !== undefined,
  );
}

export class Metrics {
  private readonly records: StateTransitionRecord[] = [];
  private readonly projections: ProjectionMeasurement[] = [];
  private readonly providerUsage: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  }[] = [];

  transition(record: StateTransitionRecord): void {
    this.records.push(record);
  }
  projection(measurement: ProjectionMeasurement): void {
    this.projections.push(measurement);
  }
  get lastProjection(): ProjectionMeasurement | undefined {
    return this.projections.at(-1);
  }
  provider(usage: { input: number; cacheRead: number; cacheWrite: number; output: number }): void {
    this.providerUsage.push(usage);
  }

  snapshot() {
    const telemetry = this.records.map((record) => record.decisions.telemetry);
    const decisions = this.records.flatMap((record) => decisionEntries(record.decisions));
    const latencies = numbers(telemetry.map((entry) => entry.latencyMs)).sort((a, b) => a - b);
    const shadows = this.records.filter(
      (record) =>
        record.decisions.phaseShadow?.value != null && record.deterministicPhase !== undefined,
    );
    return {
      events: this.records.length,
      transitions: this.records.length,
      jevCalls: telemetry.filter((entry) => entry.questionsAsked > 0).length,
      jevFailures: counts(
        telemetry.flatMap((entry) =>
          entry.error && entry.questionsAsked > 0 ? [entry.error] : [],
        ),
      ),
      questions: counts(telemetry.flatMap((entry) => entry.questionIds)),
      applied: decisions.filter(([, decision]) => decision.gate === "applied" && !decision.shadow)
        .length,
      uncertain: decisions.filter(([, decision]) => decision.gate === "uncertain").length,
      shadowAgreement: shadows.length
        ? shadows.filter(
            (record) => record.decisions.phaseShadow?.value === record.deterministicPhase,
          ).length / shadows.length
        : undefined,
      jevLatencyMs: {
        mean: mean(latencies),
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
      },
      jevInputTokens: sumAvailable(telemetry.map((entry) => entry.inputTokens)),
      jevOutputTokens: sumAvailable(telemetry.map((entry) => entry.outputTokens)),
      projection: {
        calls: this.projections.length,
        last: this.lastProjection,
        meanMessagesBefore: mean(this.projections.map((entry) => entry.messagesBefore)),
        meanMessagesAfter: mean(this.projections.map((entry) => entry.messagesAfter)),
        meanCharsBefore: mean(this.projections.map((entry) => entry.charsBefore)),
        meanCharsAfter: mean(this.projections.map((entry) => entry.charsAfter)),
        fallbacks: counts(
          this.projections.flatMap((entry) => (entry.fallback ? [entry.fallback] : [])),
        ),
      },
      provider: this.providerUsage.length
        ? {
            calls: this.providerUsage.length,
            input: sumAvailable(this.providerUsage.map((usage) => usage.input)),
            cacheRead: sumAvailable(this.providerUsage.map((usage) => usage.cacheRead)),
            cacheWrite: sumAvailable(this.providerUsage.map((usage) => usage.cacheWrite)),
            output: sumAvailable(this.providerUsage.map((usage) => usage.output)),
          }
        : undefined,
    };
  }
}

function numbers(values: readonly (number | undefined)[]): number[] {
  return values.filter((value): value is number => value !== undefined && Number.isFinite(value));
}
function sumAvailable(values: readonly (number | undefined)[]): number | undefined {
  const available = numbers(values);
  return available.length ? available.reduce((sum, value) => sum + value, 0) : undefined;
}
function mean(values: readonly number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}
function percentile(sorted: readonly number[], fraction: number): number | undefined {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function counts(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
