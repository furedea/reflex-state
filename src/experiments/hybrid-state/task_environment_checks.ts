import type { HotState } from "../../core/types.js";

type Blocker = HotState["activeBlockers"][number];

export type CheckStatus = "passed" | "failed";

/** Identity of one execution of an allowed test. */
export interface TestRun {
  readonly testId: string;
  readonly command: string;
  readonly checkKey: string;
  readonly generation: number;
  /** Execution order within a generation so the last run check is identifiable. */
  readonly seq: number;
  /** Evidence id tying this verification to the tool call that produced it. */
  readonly evidenceId?: string;
}

export interface VerificationObservation extends TestRun {
  readonly status: CheckStatus;
  /** Task-constraint verdicts reported by the oracle for this check. */
  readonly constraints?: Readonly<Record<string, boolean>>;
}

/** The recorded result of a test run, as the environment later reports it. */
export class RecordedCheck {
  readonly testId: string;
  readonly command: string;
  readonly checkKey: string;
  readonly generation: number;
  readonly seq: number;
  readonly evidenceId?: string;

  constructor(
    run: TestRun,
    readonly status: CheckStatus,
  ) {
    this.testId = run.testId;
    this.command = run.command;
    this.checkKey = run.checkKey;
    this.generation = run.generation;
    this.seq = run.seq;
    if (run.evidenceId) this.evidenceId = run.evidenceId;
  }

  isNewerThan(prior: RecordedCheck | undefined): boolean {
    return (
      !prior ||
      this.generation > prior.generation ||
      (this.generation === prior.generation && this.seq > prior.seq)
    );
  }

  isFailed(): boolean {
    return this.status === "failed";
  }

  freshness(currentGeneration: number): "current" | "stale" {
    return this.generation === currentGeneration ? "current" : "stale";
  }

  summary(): string {
    const evidence = this.evidenceId ? ` evidence=${this.evidenceId}` : "";
    return `test ${this.testId}: ${this.status} check=${this.checkKey} gen=${this.generation} seq=${this.seq}${evidence}`;
  }

  toObservation(constraints?: Readonly<Record<string, boolean>>): VerificationObservation {
    return {
      testId: this.testId,
      command: this.command,
      checkKey: this.checkKey,
      status: this.status,
      generation: this.generation,
      seq: this.seq,
      ...(this.evidenceId ? { evidenceId: this.evidenceId } : {}),
      ...(constraints ? { constraints } : {}),
    };
  }

  toBlocker(): Blocker {
    return {
      eventId: `env-${this.testId}` as Blocker["eventId"],
      origin: "verification",
      kind: "test",
      checkKey: this.checkKey,
      category: "test",
    };
  }
}
