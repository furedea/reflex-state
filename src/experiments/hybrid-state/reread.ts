import type { ActorAction } from "./types.js";

/** Bounded tag vocabulary for why a file was re-read. "observed" tags are
 * grounded in the step's recorded input; "inferred" ones cite a plausible
 * cause; "insufficient" means the records cannot support a classification.
 * Verbatim absence alone never produces "necessary_detail_missing": that tag
 * additionally requires named details the planned work needed that were
 * absent from the recorded input. */
export type RereadTag =
  | "not_saved"
  | "necessary_detail_missing"
  | "stale_or_conflicting"
  | "visible_information_rechecked"
  | "termination_overrun"
  | "unknown";

/** How much of the step's actual sent input the recorded texts cover. Old
 * runs stored only the user body, so claims derived from them are scoped to
 * that portion — never widened to "the whole input lacked it". */
export type EvidenceScope = "full" | "user_only" | "unavailable";

/** Per-step view of what the actor actually received. Callers must populate
 * each step strictly from that step's sent input — passing later memory or
 * observations inverts causality and is rejected as insufficient data. */
export interface RereadStepView {
  readonly step: number;
  /** The action the actor chose at this step, if recorded. */
  readonly action?: ActorAction;
  /** Memory item texts inside this step's sent input. */
  readonly memoryTexts?: readonly string[];
  /** Latest-observation item texts inside this step's sent input. */
  readonly observationTexts?: readonly string[];
  /** Which part of the sent input memoryTexts/observationTexts cover;
   * defaults to "user_only". */
  readonly inputScope?: "full" | "user_only";
  /** Verbatim details the work planned up to this step requires (e.g. an
   * exact replacement target or a concrete value the instruction demands).
   * Supplied by the caller from evidence visible at or before this step —
   * never from later outcomes. Omitted when the planned work is unclear. */
  readonly requiredDetails?: readonly string[];
  /** Validation errors recorded for this step's patch, if any. */
  readonly droppedReasons?: readonly string[];
  /** Test ids whose latest actor-side run passed before this step. */
  readonly testsPassedBefore?: readonly string[];
}

export interface RereadCase {
  readonly trialId: string;
  readonly step: number;
  readonly path: string;
  readonly firstReadStep: number;
  /** Whether the file changed between the earlier read and this one; null
   * when intermediate actions were not recorded. */
  readonly changedBetweenReads: boolean | null;
  /** Which portion of the sent input the recorded texts cover. */
  readonly evidenceScope: EvidenceScope;
  /** Whether the previously read content itself (verbatim or a distinctive
   * fragment) was inside the recorded input; null when the earlier content
   * or the input records are missing. */
  readonly verbatimPresent: boolean | null;
  /** Content-derived literals (key=value pairs, quoted strings, distinctive
   * numbers) found in the recorded input — values may be retained even when
   * the original text is not. */
  readonly markersFound: readonly string[];
  /** Required-detail check against the recorded input; null when the planned
   * work was not specified enough to name requirements. */
  readonly required: {
    readonly present: readonly string[];
    readonly missing: readonly string[];
  } | null;
  /** Whether the recorded input held enough for the planned work:
   * "sufficient" only when every named requirement is present, "missing"
   * when at least one is absent, "undetermined" otherwise. */
  readonly necessity: "sufficient" | "missing" | "undetermined";
  /** A patch was rejected earlier in the same trial (weak evidence that the
   * content failed: it may have been this file's content). */
  readonly patchDroppedBefore: boolean;
  readonly testsPassedBefore: boolean;
  readonly tags: readonly RereadTag[];
  readonly basis: "observed" | "inferred" | "insufficient";
}

/** Observed content of a path at a given read step, extracted by the caller
 * from the tool_result that followed that read. */
export interface ReadObservation {
  readonly step: number;
  readonly path: string;
  readonly content: string;
}

export function analyzeRereads(
  trialId: string,
  steps: readonly RereadStepView[],
  reads: readonly ReadObservation[],
): RereadCase[] {
  const firstRead = new Map<string, number>();
  for (const observation of reads)
    if (!firstRead.has(observation.path)) firstRead.set(observation.path, observation.step);
  const cases: RereadCase[] = [];
  for (const stepView of steps) {
    const path = rereadPath(stepView);
    if (path === undefined) continue;
    const earlier = firstRead.get(path);
    if (earlier === undefined || earlier === stepView.step) continue;
    cases.push(buildCase({ trialId, steps, reads }, stepView, { path, earlier }));
  }
  return cases;
}

function rereadPath(stepView: RereadStepView): string | undefined {
  const action = stepView.action;
  if (!action || action.tool !== "read") return undefined;
  return action.path;
}

interface CaseContext {
  readonly trialId: string;
  readonly steps: readonly RereadStepView[];
  readonly reads: readonly ReadObservation[];
}

function buildCase(
  context: CaseContext,
  stepView: RereadStepView,
  target: { readonly path: string; readonly earlier: number },
): RereadCase {
  const { trialId, steps, reads } = context;
  const { path, earlier } = target;
  const scope = evidenceScope(stepView);
  const inputs = inputTexts(stepView);
  const priorContent = contentBefore(reads, path, stepView.step);
  const changed = changedBetween(steps, path, { from: earlier, to: stepView.step });
  const usable = scope !== "unavailable" && priorContent !== null;
  const verbatim = usable ? contentVisible(inputs, priorContent) : null;
  const markersFound = usable
    ? extractMarkers(priorContent).filter((marker) =>
        inputs.some((input) => contains(input, marker)),
      )
    : [];
  const required = requiredCheck(scope, stepView.requiredDetails, inputs);
  const droppedBefore = steps.some(
    (candidate) => candidate.step < stepView.step && (candidate.droppedReasons?.length ?? 0) > 0,
  );
  const tested = testedBefore(steps, stepView);
  return {
    trialId,
    step: stepView.step,
    path,
    firstReadStep: earlier,
    changedBetweenReads: changed,
    evidenceScope: scope,
    verbatimPresent: verbatim,
    markersFound,
    required,
    necessity: necessityOf(required),
    patchDroppedBefore: droppedBefore,
    testsPassedBefore: tested,
    tags: classify({ changed, verbatim, markersFound, required, scope, droppedBefore, tested }),
    basis: basisFor({ changed, verbatim, required, scope, droppedBefore }),
  };
}

function requiredCheck(
  scope: EvidenceScope,
  requiredDetails: readonly string[] | undefined,
  inputs: readonly string[],
): RereadCase["required"] {
  if (scope === "unavailable" || requiredDetails === undefined) return null;
  const isPresent = (detail: string) => inputs.some((input) => contains(input, detail));
  return {
    present: requiredDetails.filter(isPresent),
    missing: requiredDetails.filter((detail) => !isPresent(detail)),
  };
}

function necessityOf(required: RereadCase["required"]): RereadCase["necessity"] {
  if (required === null) return "undetermined";
  return required.missing.length ? "missing" : "sufficient";
}

function testedBefore(steps: readonly RereadStepView[], stepView: RereadStepView): boolean {
  if (stepView.testsPassedBefore?.length) return true;
  return steps.some(
    (candidate) => candidate.step < stepView.step && (candidate.testsPassedBefore?.length ?? 0) > 0,
  );
}

function evidenceScope(step: RereadStepView): EvidenceScope {
  if (step.memoryTexts === undefined && step.observationTexts === undefined) return "unavailable";
  return step.inputScope ?? "user_only";
}

function inputTexts(step: RereadStepView): readonly string[] {
  return [...(step.memoryTexts ?? []), ...(step.observationTexts ?? [])];
}

function contentBefore(
  reads: readonly ReadObservation[],
  path: string,
  step: number,
): string | null {
  let content: string | null = null;
  for (const read of reads) if (read.path === path && read.step < step) content = read.content;
  return content;
}

/** A write or edit to the same path between two reads makes the earlier
 * content stale, so the re-read is legitimate verification. */
function changedBetween(
  steps: readonly RereadStepView[],
  path: string,
  range: { readonly from: number; readonly to: number },
): boolean | null {
  const { from, to } = range;
  let missing = false;
  for (const candidate of steps) {
    if (candidate.step <= from || candidate.step >= to) continue;
    if (!candidate.action) {
      missing = true;
      continue;
    }
    const action = candidate.action;
    if ((action.tool === "write" || action.tool === "edit") && action.path === path) return true;
  }
  return missing ? null : false;
}

/** Recorded inputs may carry JSON-escaped text; a literal `\n` two-byte
 * sequence must not hide real content. Both the raw and unescaped forms are
 * searched. */
function contains(input: string, needle: string): boolean {
  if (input.includes(needle)) return true;
  const unescaped = input.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  return unescaped !== input && unescaped.includes(needle);
}

/** The content counts as verbatim-present when the input carries it whole,
 * or a distinctive long-enough fragment of it (short contents must match
 * whole). */
function contentVisible(inputs: readonly string[], content: string): boolean {
  const fragment = content
    .trim()
    .split("\n")
    .find((line) => line.trim().length >= 24);
  return inputs.some(
    (input) =>
      contains(input, content) || (fragment !== undefined && contains(input, fragment.trim())),
  );
}

/** Distinctive literals in a file: key=value assignments, quoted strings,
 * and standalone numbers. Presence of these markers means the file's
 * concrete values are represented in the input even when the verbatim text
 * is not. This is literal matching, not semantic equivalence. */
function extractMarkers(content: string): readonly string[] {
  const markers = new Set<string>();
  for (const match of content.matchAll(/[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*[^\s,;]+/g))
    markers.add(match[0].replace(/\s+/g, ""));
  for (const match of content.matchAll(/["'`][^"'`\n]{3,64}["'`]/g)) markers.add(match[0]);
  for (const match of content.matchAll(/\b\d{3,}\b/g)) markers.add(match[0]);
  return [...markers].sort();
}

interface ClassifyFlags {
  readonly changed: boolean | null;
  readonly verbatim: boolean | null;
  readonly markersFound: readonly string[];
  readonly required: RereadCase["required"];
  readonly scope: EvidenceScope;
  readonly droppedBefore: boolean;
  readonly tested: boolean;
}

function classify(flags: ClassifyFlags): RereadTag[] {
  const tags: RereadTag[] = [];
  if (flags.changed === true) tags.push("stale_or_conflicting");
  tags.push(...contentTags(flags));
  if (flags.tested) tags.push("termination_overrun");
  if (!tags.length) tags.push("unknown");
  return [...new Set(tags)];
}

function contentTags(flags: ClassifyFlags): RereadTag[] {
  if (flags.scope === "unavailable") return ["unknown"];
  // Named details the planned work needed were absent from the recorded
  // input — the only case that earns "necessary_detail_missing".
  if (flags.required && flags.required.missing.length) return ["necessary_detail_missing"];
  if (flags.verbatim === false) return unseenContentTags(flags);
  if (flags.verbatim === true && flags.changed !== true) return ["visible_information_rechecked"];
  return [];
}

function unseenContentTags(flags: ClassifyFlags): RereadTag[] {
  // Every named requirement was present although the original text was
  // not — the re-read was not caused by missing required detail.
  if (flags.required) return ["visible_information_rechecked"];
  // Nothing derived from the file reached the input at all; whether the
  // planned work needed it stays undetermined without named requirements.
  if (flags.markersFound.length === 0) return ["not_saved", "unknown"];
  return ["unknown"];
}

function basisFor(flags: {
  readonly changed: boolean | null;
  readonly verbatim: boolean | null;
  readonly required: RereadCase["required"];
  readonly scope: EvidenceScope;
  readonly droppedBefore: boolean;
}): RereadCase["basis"] {
  if (flags.scope === "unavailable" || flags.verbatim === null || flags.changed === null)
    return "insufficient";
  if (flags.required === null && flags.verbatim === false) return "insufficient";
  if (flags.droppedBefore && flags.verbatim === false) return "inferred";
  return "observed";
}
