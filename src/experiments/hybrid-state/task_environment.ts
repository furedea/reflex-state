import type { HotState } from "../../core/types.js";
import { normalizeCwd, verificationCheckKey } from "../../core/verification.js";
import { runScriptOracle } from "./task_environment_oracle.js";
import type { EnvironmentOptions, OracleRun } from "./task_environment_oracle.js";
import type {
  ActorAction,
  ExperimentCheckFact,
  FactsView,
  HybridTask,
  TaskScoring,
} from "./types.js";

export { checkIsolation } from "./task_environment_isolation.js";

const EXPERIMENT_CWD = "/experiment";
const EXPERIMENT_TEST_COMMAND = "experiment test";

interface VerificationObservation {
  readonly testId: string;
  readonly command: string;
  readonly checkKey: string;
  readonly status: "passed" | "failed";
  readonly generation: number;
  /** Execution order within a generation so the last run check is identifiable. */
  readonly seq: number;
  /** Evidence id tying this verification to the tool call that produced it. */
  readonly evidenceId?: string;
  /** Task-constraint verdicts reported by the oracle for this check. */
  readonly constraints?: Readonly<Record<string, boolean>>;
}

interface ExecutionResult {
  readonly text: string;
  readonly passed: boolean;
  readonly violation?: string;
  readonly verification?: VerificationObservation;
}

interface OracleRunResult {
  readonly testId: string;
  readonly status: "passed" | "failed" | "not_run";
  readonly output?: string;
  /** Task-constraint verdicts reported by the oracle. */
  readonly constraints?: Readonly<Record<string, boolean>>;
}

interface RecordedCheck {
  readonly testId: string;
  readonly status: "passed" | "failed";
  readonly generation: number;
  readonly command: string;
  readonly seq: number;
  readonly evidenceId?: string;
}

interface CheckEntry extends RecordedCheck {
  readonly checkKey: string;
}

type TestOracle = NonNullable<TaskScoring["oracles"]>[number];

interface CheckOutcome {
  readonly status: "passed" | "failed";
  readonly text: string;
  readonly constraints?: Readonly<Record<string, boolean>>;
}

type TestRun = Omit<VerificationObservation, "status" | "constraints">;

export class TaskEnvironment {
  private readonly workspace = new Map<string, string>();
  private readonly checks = new Map<string, RecordedCheck>();
  private generation = 0;
  private seq = 0;

  constructor(
    private readonly task: HybridTask,
    private readonly scoring: TaskScoring | undefined,
    private readonly options: EnvironmentOptions,
  ) {
    for (const [path, content] of Object.entries(task.files)) this.workspace.set(path, content);
  }

  get files(): ReadonlyMap<string, string> {
    return this.workspace;
  }

  get observationGeneration(): number {
    return this.generation;
  }

  async execute(action: ActorAction, evidenceId?: string): Promise<ExecutionResult> {
    if (action.path !== undefined && !safePath(action.path))
      return { text: "path rejected", passed: false, violation: "path_escape" };
    switch (action.tool) {
      case "read":
        return this.read(action);
      case "write":
        return this.write(action);
      case "edit":
        return this.edit(action);
      case "test":
        return this.executeTest(action, evidenceId);
      case "finish":
        return { text: "finished", passed: true };
    }
  }

  async evaluateFinal(): Promise<readonly OracleRunResult[]> {
    const results: OracleRunResult[] = [];
    for (const testId of this.task.allowedTests) results.push(await this.finalResult(testId));
    return results;
  }

  verificationFacts(): {
    readonly verification: FactsView["verification"];
    readonly blockers: readonly HotState["activeBlockers"][number][];
  } {
    const entries: CheckEntry[] = [...this.checks].map(([checkKey, check]) => ({
      ...check,
      checkKey,
    }));
    const latest = entries.reduce<CheckEntry | undefined>(newestCheck, undefined);
    const verification: FactsView["verification"] = {
      build: { status: "not_run", freshness: "unknown" },
      lint: { status: "not_run", freshness: "unknown" },
      test: latest
        ? {
            status: latest.status,
            freshness: this.freshness(latest),
            command: latest.command,
            cwd: normalizeCwd(EXPERIMENT_CWD),
            checkKey: latest.checkKey,
            observedGeneration: latest.generation,
            attributable: true,
          }
        : { status: "not_run", freshness: "unknown" },
      tests: this.latestTestFacts(entries),
    };
    return { verification, blockers: entries.filter(isFailed).map(blockerFor) };
  }

  private read(action: ActorAction): ExecutionResult {
    if (action.path === undefined)
      return { text: "invalid read", passed: false, violation: "invalid_action" };
    const content = this.workspace.get(action.path);
    if (content === undefined) return { text: `file not found: ${action.path}`, passed: false };
    return { text: content, passed: true };
  }

  private write(action: ActorAction): ExecutionResult {
    if (action.path === undefined || action.content === undefined)
      return { text: "invalid write", passed: false, violation: "invalid_action" };
    this.workspace.set(action.path, action.content);
    this.generation++;
    return { text: `write ok: ${action.path} (gen=${this.generation})`, passed: true };
  }

  private edit(action: ActorAction): ExecutionResult {
    if (action.path === undefined || action.old === undefined || action.new === undefined)
      return { text: "invalid edit", passed: false, violation: "invalid_action" };
    const content = this.workspace.get(action.path);
    if (content === undefined) return { text: `file not found: ${action.path}`, passed: false };
    const index = content.indexOf(action.old);
    if (index < 0) return { text: `edit target not found in ${action.path}`, passed: false };
    this.workspace.set(
      action.path,
      content.slice(0, index) + action.new + content.slice(index + action.old.length),
    );
    this.generation++;
    return { text: `edit ok: ${action.path} (gen=${this.generation})`, passed: true };
  }

  private async executeTest(action: ActorAction, evidenceId?: string): Promise<ExecutionResult> {
    const testId = action.command;
    if (!testId || !this.task.allowedTests.includes(testId)) return testNotAllowed(testId);
    const oracle = this.oracleFor(testId);
    const command = `${EXPERIMENT_TEST_COMMAND} ${testId}`;
    const run: TestRun = {
      testId,
      command,
      checkKey: verificationCheckKey("test", EXPERIMENT_CWD, command),
      generation: this.generation,
      seq: this.seq++,
      ...(evidenceId ? { evidenceId } : {}),
    };
    if (oracle?.kind === "script" && oracle.script) return this.runScriptTest(run, oracle.script);
    // A task with a scoring file never falls back to the task's expectedFiles;
    // every allowed test needs an explicitly declared oracle.
    if (this.usesExpectedFiles(oracle)) return this.runExpectedFilesTest(run, oracle);
    return {
      text: `test ${testId}: no oracle registered`,
      passed: false,
      violation: "test_no_oracle",
    };
  }

  private async runScriptTest(run: TestRun, script: string): Promise<ExecutionResult> {
    const result = await runScriptOracle(this.workspace, script, this.options);
    const status = result.passed ? "passed" : "failed";
    return this.recordCheck(run, {
      status,
      text: `${testSummary(run, status)}${result.output ? `\n${result.output}` : ""}`,
      ...(result.constraints ? { constraints: result.constraints } : {}),
    });
  }

  private runExpectedFilesTest(run: TestRun, oracle: TestOracle | undefined): ExecutionResult {
    const mismatches = Object.entries(this.expectedFilesFor(oracle)).filter(
      ([path, content]) => this.workspace.get(path) !== content,
    );
    const status = mismatches.length ? "failed" : "passed";
    return this.recordCheck(run, {
      status,
      text: mismatches.length
        ? `test ${run.testId}: failed (files differ: ${mismatches.map(([path]) => path).join(", ")})`
        : testSummary(run, status),
    });
  }

  private recordCheck(run: TestRun, outcome: CheckOutcome): ExecutionResult {
    const { status, text, constraints } = outcome;
    this.checks.set(run.checkKey, {
      testId: run.testId,
      status,
      generation: run.generation,
      command: run.command,
      seq: run.seq,
      ...(run.evidenceId ? { evidenceId: run.evidenceId } : {}),
    });
    return {
      text,
      passed: status === "passed",
      verification: {
        testId: run.testId,
        command: run.command,
        checkKey: run.checkKey,
        status,
        generation: run.generation,
        seq: run.seq,
        ...(run.evidenceId ? { evidenceId: run.evidenceId } : {}),
        ...(constraints ? { constraints } : {}),
      },
    };
  }

  private async finalResult(testId: string): Promise<OracleRunResult> {
    const oracle = this.oracleFor(testId);
    if (oracle?.kind === "script" && oracle.script)
      return this.scriptFinalResult(testId, oracle.script);
    if (this.usesExpectedFiles(oracle))
      return {
        testId,
        status: this.matchesFiles(this.expectedFilesFor(oracle)) ? "passed" : "failed",
      };
    return { testId, status: "not_run" };
  }

  private async scriptFinalResult(testId: string, script: string): Promise<OracleRunResult> {
    const run = await runScriptOracle(this.workspace, script, this.options);
    return {
      testId,
      status: scriptStatus(run),
      output: run.output,
      ...(run.constraints ? { constraints: run.constraints } : {}),
    };
  }

  private oracleFor(testId: string): TestOracle | undefined {
    return this.scoring?.oracles?.find((candidate) => candidate.testId === testId);
  }

  private usesExpectedFiles(oracle: TestOracle | undefined): boolean {
    return (
      oracle?.kind === "expected_files" || (!oracle && !this.scoring && !!this.task.expectedFiles)
    );
  }

  private expectedFilesFor(oracle: TestOracle | undefined): Readonly<Record<string, string>> {
    return oracle ? (this.scoring?.expectedFiles ?? {}) : (this.task.expectedFiles ?? {});
  }

  private matchesFiles(expected: Readonly<Record<string, string>>): boolean {
    return Object.entries(expected).every(
      ([path, content]) => this.workspace.get(path) === content,
    );
  }

  /** Per-test facts let scoring compare each declared test's latest result;
   * a different check's success can never masquerade as this test's. */
  private latestTestFacts(entries: readonly CheckEntry[]): Record<string, ExperimentCheckFact> {
    const latestPerTest = new Map<string, CheckEntry>();
    for (const entry of entries)
      if (isNewerCheck(entry, latestPerTest.get(entry.testId)))
        latestPerTest.set(entry.testId, entry);
    const tests: Record<string, ExperimentCheckFact> = {};
    for (const entry of latestPerTest.values())
      tests[entry.testId] = {
        testId: entry.testId,
        status: entry.status,
        freshness: this.freshness(entry),
        command: entry.command,
        checkKey: entry.checkKey,
        observedGeneration: entry.generation,
      };
    return tests;
  }

  private freshness(check: RecordedCheck): "current" | "stale" {
    return check.generation === this.generation ? "current" : "stale";
  }
}

export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..") &&
    !path.includes("\\") &&
    !path.includes("\0")
  );
}

function testNotAllowed(testId: string | undefined): ExecutionResult {
  return {
    text: `test not allowed: ${testId ?? "missing"}`,
    passed: false,
    violation: "test_not_allowed",
  };
}

function testSummary(run: TestRun, status: "passed" | "failed"): string {
  const evidence = run.evidenceId ? ` evidence=${run.evidenceId}` : "";
  return `test ${run.testId}: ${status} check=${run.checkKey} gen=${run.generation} seq=${run.seq}${evidence}`;
}

// An oracle that never executed is "not_run", not a failure of the artifact
// (e.g. required sandbox unavailable on this host).
function scriptStatus(run: OracleRun): OracleRunResult["status"] {
  if (run.ran === false) return "not_run";
  return run.passed ? "passed" : "failed";
}

function isNewerCheck(check: RecordedCheck, prior: RecordedCheck | undefined): boolean {
  return (
    !prior ||
    check.generation > prior.generation ||
    (check.generation === prior.generation && check.seq > prior.seq)
  );
}

function newestCheck(latest: CheckEntry | undefined, check: CheckEntry): CheckEntry {
  return isNewerCheck(check, latest) ? check : (latest as CheckEntry);
}

function isFailed(check: CheckEntry): boolean {
  return check.status === "failed";
}

function blockerFor(check: CheckEntry): HotState["activeBlockers"][number] {
  return {
    eventId: `env-${check.testId}` as HotState["activeBlockers"][number]["eventId"],
    origin: "verification",
    kind: "test",
    checkKey: check.checkKey,
    category: "test",
  };
}
