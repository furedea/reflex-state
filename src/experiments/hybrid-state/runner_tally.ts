import type { CommittedPatch } from "./runner_patch.js";
import type { ActorTestRun } from "./runner_scoring.js";
import type { TaskEnvironment } from "./task_environment.js";
import type {
  ActionForm,
  ActorAction,
  PatchOperation,
  PatchStats,
  UpdateFeedback,
} from "./types.js";

type Execution = Awaited<ReturnType<TaskEnvironment["execute"]>>;
type ConstraintVerdicts = Readonly<Record<string, boolean>>;

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

  trackExecution(actionKey: string, execution: Execution): void {
    if (this.lastFailedKey !== undefined && this.lastFailedKey === actionKey) this.retries++;
    this.lastFailedKey = execution.passed ? undefined : actionKey;
    if (!execution.passed) this.failureObserved = true;
  }

  trackRead(action: ActorAction, generation: number): void {
    if (action.tool !== "read") return;
    const key = `${action.path}|${generation}`;
    if (this.readKeys.has(key)) this.rereads++;
    this.readKeys.add(key);
  }

  trackVerification(step: number, execution: Execution): void {
    if (!execution.verification) return;
    this.actorTests.push({
      testId: execution.verification.testId,
      step,
      passed: execution.passed,
      generation: execution.verification.generation,
    });
    this.mergeConstraints(execution.verification.constraints);
  }

  mergeConstraints(verdicts?: ConstraintVerdicts): void {
    for (const [key, verdict] of Object.entries(verdicts ?? {}))
      this.constraintVerdicts.set(key, (this.constraintVerdicts.get(key) ?? true) && verdict);
  }
}
