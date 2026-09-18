import { readFile } from "node:fs/promises";

import type {
  AuditLabel,
  Candidate,
  CallRecord,
  ContextRecord,
  ExperimentMode,
  ExperimentSummary,
  EvaluationKind,
  RunScore,
} from "./types.js";

export interface AuditResult {
  readonly labels: readonly AuditLabel[];
  readonly candidates: readonly Candidate[];
  readonly selected: Readonly<Record<ExperimentMode, readonly string[]>>;
  readonly agreement: Readonly<Record<ExperimentMode, number>>;
}

export async function loadLabels(path: string): Promise<readonly AuditLabel[]> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value)) throw new Error("Invalid hybrid-state labels");
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.candidateId !== "string") return [];
    const kind = record.kind;
    if (
      kind !== "deterministic" &&
      kind !== "extractive" &&
      kind !== "generative" &&
      kind !== "insufficient"
    )
      return [];
    return [
      {
        candidateId: record.candidateId,
        kind,
        reviewed: record.reviewed === true,
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      },
    ];
  });
}

export function evaluateAudit(
  candidates: readonly Candidate[],
  labels: readonly AuditLabel[],
  selected: Readonly<Record<ExperimentMode, readonly string[]>>,
): AuditResult {
  const labelMap = new Map(labels.map((label) => [label.candidateId, label]));
  const agreement = Object.fromEntries(
    Object.entries(selected).map(([mode, ids]) => {
      const scored = ids.filter((id) => labelMap.has(id));
      const useful = scored.filter((id) => {
        const kind = labelMap.get(id)?.kind;
        return kind === "deterministic" || kind === "extractive";
      });
      return [mode, scored.length ? useful.length / scored.length : 0];
    }),
  ) as Record<ExperimentMode, number>;
  return { labels, candidates, selected, agreement };
}

export function summarize(
  evaluation: EvaluationKind,
  modes: readonly ExperimentMode[],
  scores: readonly RunScore[],
  calls: readonly CallRecord[],
  contexts: readonly ContextRecord[],
  generatedItems: number,
  retainedCandidates = 0,
): ExperimentSummary {
  const totalContextBytes = Object.fromEntries(
    modes.map((mode) => [
      mode,
      contexts
        .filter((record) => record.mode === mode)
        .reduce((sum, record) => sum + record.bytes.total, 0),
    ]),
  ) as Record<ExperimentMode, number>;
  const reviewedScores = scores.filter((score) => score.unavailable === undefined);
  const allPassed =
    reviewedScores.length > 0 &&
    reviewedScores.every((score) => score.completed && score.testPassed);
  const stateModes = scores.filter((score) => score.mode !== "history");
  const historyModes = scores.filter((score) => score.mode === "history");
  const qualityImproved =
    stateModes.some((score) => score.testPassed) && historyModes.some((score) => !score.testPassed);
  const judgement =
    reviewedScores.length === 0
      ? "insufficient_evidence"
      : qualityImproved && allPassed
        ? "promising"
        : scores.some((score) => score.unavailable)
          ? "insufficient_evidence"
          : "no_benefit_observed";
  return {
    evaluation,
    modes,
    calls: calls.length,
    scores,
    retainedCandidates,
    generatedItems,
    repairCalls: calls.filter((call) => call.kind === "repair").length,
    totalContextBytes,
    judgement,
    limitations: [
      "Fake and recorded providers do not measure real model task success.",
      "Synthetic labels are evaluator data and are never sent to a model.",
      "No claim about general performance follows from three small tasks.",
    ],
  };
}

export function reportMarkdown(summary: ExperimentSummary): string {
  const lines = [
    "# Hybrid state experiment report",
    "",
    `- evaluation: ${summary.evaluation}`,
    `- judgement: ${summary.judgement}`,
    `- calls: ${summary.calls}`,
    `- generated items: ${summary.generatedItems}`,
    `- repair calls: ${summary.repairCalls}`,
    "",
    "## Modes",
    "",
    "| mode | context bytes | completed | tests passed | unavailable |",
    "| --- | ---: | --- | --- | --- |",
  ];
  for (const mode of summary.modes) {
    const scores = summary.scores.filter((score) => score.mode === mode);
    const completed = scores.filter((score) => score.completed).length;
    const passed = scores.filter((score) => score.testPassed).length;
    const unavailable = scores.filter((score) => score.unavailable).length;
    lines.push(
      `| ${mode} | ${summary.totalContextBytes[mode] ?? 0} | ${completed}/${scores.length} | ${passed}/${scores.length} | ${unavailable} |`,
    );
  }
  lines.push("", "## Limitations", "", ...summary.limitations.map((item) => `- ${item}`), "");
  return lines.join("\n");
}
