import type { CommittedPatch } from "./runner_patch.js";
import type { ActorTestRun } from "./runner_scoring.js";
import type {
  ActionForm,
  ActorAction,
  ActorVerificationEntry,
  PatchOperation,
  PatchStats,
  UpdateFeedback,
} from "./types.js";

/** Per-trial counters and observations that feed the final score. */
export class TrialTally {
  readonly policyViolations: string[] = [];
  readonly actorTests: ActorTestRun[] = [];
  readonly sentTexts: string[] = [];
  readonly actionForms: Record<ActionForm, number> = { canonical: 0, shorthand: 0, bare: 0 };
  lastUpdateResult: UpdateFeedback | null = null;
  rereads = 0;
  retries = 0;
  failureObserved = false;
  appliedExtractive = 0;
  appliedGenerated = 0;
  private readonly constraintVerdicts = new Map<string, boolean>();
  private readonly patchInputCounts = { missing: 0, empty: 0, present: 0 };
  private patchProposed = 0;
  private patchApplied = 0;
  private patchUnchanged = 0;
  private patchRejected = 0;
  private readonly readKeys = new Set<string>();
  private lastFailedKey: string | undefined;

  patchStats(): PatchStats {
    return {
      input: this.patchInputCounts,
      proposed: this.patchProposed,
      applied: this.patchApplied,
      unchanged: this.patchUnchanged,
      rejected: this.patchRejected,
    };
  }

  constraints(): Record<string, boolean> {
    return Object.fromEntries(this.constraintVerdicts);
  }

  /** Per declared test: the actor's latest own run at stop time and whether the
   * workspace still matched the generation that run verified. */
  actorVerificationAtStop(
    allowedTests: readonly string[],
    finalGeneration: number,
  ): Record<string, ActorVerificationEntry> {
    const result: Record<string, ActorVerificationEntry> = {};
    for (const testId of allowedTests) {
      const latest = [...this.actorTests].reverse().find((run) => run.testId === testId);
      if (!latest) {
        result[testId] = { status: "not_run" };
        continue;
      }
      result[testId] = {
        status: latest.passed ? "passed" : "failed",
        step: latest.step,
        freshness: latest.generation === finalGeneration ? "current" : "stale",
      };
    }
    return result;
  }

  tallyApplied(applied: readonly PatchOperation[]): void {
    this.appliedExtractive += applied.filter((op) => op.origin === "extracted").length;
    this.appliedGenerated += applied.filter((op) => op.origin === "generated").length;
  }

  tallyPatch(patch: CommittedPatch): void {
    this.lastUpdateResult = patch.feedback;
    this.patchInputCounts[patch.patchInput] += 1;
    this.patchProposed += patch.proposed;
    this.patchApplied += patch.applied.length;
    this.patchUnchanged += patch.unchanged.length;
    this.patchRejected += patch.errors.length;
    this.tallyApplied(patch.applied);
  }

  trackExecution(actionKey: string, passed: boolean): void {
    if (this.lastFailedKey !== undefined && this.lastFailedKey === actionKey) this.retries++;
    this.lastFailedKey = passed ? undefined : actionKey;
    if (!passed) this.failureObserved = true;
  }

  trackRead(action: ActorAction, generation: number): void {
    if (action.tool !== "read") return;
    const key = `${action.path}|${generation}`;
    if (this.readKeys.has(key)) this.rereads++;
    this.readKeys.add(key);
  }

  trackVerification(run: ActorTestRun, constraints?: Readonly<Record<string, boolean>>): void {
    this.actorTests.push(run);
    this.mergeConstraints(constraints);
  }

  mergeConstraints(verdicts?: Readonly<Record<string, boolean>>): void {
    for (const [key, verdict] of Object.entries(verdicts ?? {}))
      this.constraintVerdicts.set(key, (this.constraintVerdicts.get(key) ?? true) && verdict);
  }
}
