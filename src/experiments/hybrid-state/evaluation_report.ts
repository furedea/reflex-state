import { USAGE_FIELDS } from "./evaluation_summary.js";
import type {
  CheckpointItemResult,
  ExperimentManifest,
  ExperimentSummary,
  TrialScore,
} from "./types.js";
import { RESULT_SCHEMA_VERSION } from "./types.js";

export function reportMarkdown(value: unknown, manifest?: ExperimentManifest | null): string {
  const summary = value as ExperimentSummary;
  const schemaVersion = (summary as { schemaVersion?: unknown }).schemaVersion;
  if (!summary || (schemaVersion !== 2 && schemaVersion !== RESULT_SCHEMA_VERSION))
    return legacyReport(value);
  const lines: string[] = [
    ...headerLines(summary, manifest),
    ...modeMetricLines(summary),
    ...trialLines(summary),
    ...skippedLines(summary),
    ...limitationLines(summary),
    "",
  ];
  return lines.join("\n");
}

function legacyReport(value: unknown): string {
  return [
    "# Hybrid-state experiment report",
    "",
    "> legacy_metrics_untrusted: this result predates schema version 2.",
    "> Its measurements and judgements are not reliable; do not compare it",
    "> with corrected runs.",
    "",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
    "",
  ].join("\n");
}

function manifestLine(manifest: ExperimentManifest): string {
  const finished = manifest.finishedAt ? `, finished ${manifest.finishedAt}` : "";
  const failed = manifest.failedStage ? ` (failed stage: ${manifest.failedStage})` : "";
  return `- manifest: started ${manifest.startedAt}, status ${manifest.status}${finished}${failed}`;
}

function headerLines(summary: ExperimentSummary, manifest?: ExperimentManifest | null): string[] {
  const env = summary.environment;
  return [
    "# Hybrid-state experiment report",
    "",
    `- run: \`${summary.runId}\``,
    `- evaluation: ${summary.evaluation}`,
    `- provider: ${summary.provider}`,
    ...(summary.protocolId ? [`- protocol: \`${summary.protocolId}\``] : []),
    ...(manifest ? [manifestLine(manifest)] : []),
    `- efficacy_status: **${summary.efficacyStatus}**`,
    `- wiring: ${summary.wiring.passed} passed / ${summary.wiring.failed} failed / ${summary.wiring.notEvaluated} not_evaluated`,
    `- trials: ${summary.scores.length}/${summary.plannedTrials} executed, ${summary.skippedTrials.length} skipped`,
    ...(env
      ? [`- environment: node ${env.node}, ${env.platform}, isolation: ${env.isolation}`]
      : []),
    "- sent bytes are application-side request bodies (system + user), not HTTP bytes or token counts",
    "",
    "## Per-mode metrics",
    "",
    "| mode | actor | jev | repair | update | sent bytes | unique candidates | decisions | applied ex/gen | wall ms | usage fields reported |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
}

function modeMetricLines(summary: ExperimentSummary): string[] {
  return summary.modes.map((mode) => {
    const metric = summary.metrics[mode];
    const usageCoverage = USAGE_FIELDS.map(
      (field) =>
        `${field.replace("Tokens", "")}:${(metric.usage[field].coverage * 100).toFixed(0)}%`,
    ).join(" ");
    return `| ${mode} | ${metric.invocations.actor} | ${metric.invocations.jev} | ${metric.invocations.repair} | ${metric.invocations.update} | ${metric.sentBytes} | ${metric.uniqueCandidates} | ${metric.decisionCount} | ${metric.appliedExtractive}/${metric.appliedGenerated} | ${metric.wallMs} | ${usageCoverage} |`;
  });
}

function trialLines(summary: ExperimentSummary): string[] {
  if (!summary.scores.length) return [];
  const v3 = summary.schemaVersion === RESULT_SCHEMA_VERSION;
  const lines = [
    "",
    "## Trials",
    "",
    v3
      ? "| trial | task | mode | status | wiring | termination | finished | final artifact | actor verify | patch a/u/r | checkpoints |"
      : "| trial | task | mode | status | wiring | completed | tests | actor tests | checkpoints |",
    v3
      ? "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
      : "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summary.scores.map((score) => (v3 ? trialRowV3(score) : trialRowV2(score))),
  ];
  if (!v3)
    lines.push(
      "",
      "> schema v2 result: termination, final-artifact, and update-feedback fields",
      "> did not exist yet; missing values are shown as `-` and never inferred.",
    );
  return lines;
}

function reasonSuffix(item: CheckpointItemResult): string {
  return item.reason ? `(${item.reason})` : "";
}

function checkpointsCell(score: TrialScore): string {
  return score.checkpoints
    .flatMap((checkpoint) => checkpoint.items)
    .map((item) => {
      if (item.retained === null) return `n/a${reasonSuffix(item)}`;
      return item.retained ? "ok" : `miss${reasonSuffix(item)}`;
    })
    .join(",");
}

function statusEntries(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries)
    .map(([id, status]) => `${id}:${status}`)
    .join(",");
}

function trialRowV2(score: TrialScore): string {
  const tests = statusEntries(score.tests);
  const actorTests = score.actorTests
    .map((test) => `${test.testId}@${test.step}:${test.passed ? "pass" : "fail"}`)
    .join(",");
  return `| ${score.trialId} | ${score.taskId} | ${score.mode} | ${score.executionStatus} | ${score.wiringStatus} | ${score.completed} | ${tests || "-"} | ${actorTests || "-"} | ${checkpointsCell(score) || "-"} |`;
}

function finalTestsCell(score: TrialScore): string {
  if (!score.finalArtifact) return "-";
  return statusEntries(score.finalArtifact.tests) || score.finalArtifact.status;
}

function actorVerifyCell(score: TrialScore): string {
  if (!score.actorVerificationAtStop) return "-";
  return Object.entries(score.actorVerificationAtStop)
    .map(([id, entry]) => `${id}:${entry.status}${entry.freshness === "stale" ? "(stale)" : ""}`)
    .join(",");
}

function patchCell(score: TrialScore): string {
  if (!score.patchStats) return "-";
  return `${score.patchStats.applied}/${score.patchStats.unchanged}/${score.patchStats.rejected}`;
}

function trialRowV3(score: TrialScore): string {
  const finalTests = finalTestsCell(score);
  const actorVerify = actorVerifyCell(score);
  return `| ${score.trialId} | ${score.taskId} | ${score.mode} | ${score.executionStatus} | ${score.wiringStatus} | ${score.terminationReason ?? "-"} | ${score.finishedWithinBudget ?? "-"} | ${finalTests || "-"} | ${actorVerify || "-"} | ${patchCell(score)} | ${checkpointsCell(score) || "-"} |`;
}

function skippedLines(summary: ExperimentSummary): string[] {
  if (!summary.skippedTrials.length) return [];
  return [
    "",
    "## Skipped trials",
    "",
    ...summary.skippedTrials.map(
      (skipped) => `- ${skipped.trialId} (${skipped.taskId}/${skipped.mode}): ${skipped.reason}`,
    ),
  ];
}

function limitationLines(summary: ExperimentSummary): string[] {
  if (!summary.limitations.length) return [];
  return ["", "## Limitations", "", ...summary.limitations.map((entry) => `- ${entry}`)];
}
