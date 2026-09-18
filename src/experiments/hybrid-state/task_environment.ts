import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { HotState } from "../../core/types.js";
import { normalizeCwd, verificationCheckKey } from "../../core/verification.js";
import type { ActorAction, HybridTask, TaskScoring } from "./types.js";

const EXPERIMENT_CWD = "/experiment";
const EXPERIMENT_TEST_COMMAND = "experiment test";

interface VerificationObservation {
  readonly testId: string;
  readonly command: string;
  readonly checkKey: string;
  readonly status: "passed" | "failed";
  readonly generation: number;
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
}

interface EnvironmentOptions {
  readonly isolated: boolean;
  readonly oracleTimeoutMs?: number;
  readonly oracleOutputLimit?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 65_536;

export class TaskEnvironment {
  private readonly workspace = new Map<string, string>();
  private readonly checks = new Map<
    string,
    {
      readonly testId: string;
      readonly status: "passed" | "failed";
      readonly generation: number;
      readonly command: string;
    }
  >();
  private generation = 0;

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

  async execute(action: ActorAction): Promise<ExecutionResult> {
    if (action.path !== undefined && !safePath(action.path))
      return { text: "path rejected", passed: false, violation: "path_escape" };
    switch (action.tool) {
      case "read": {
        if (action.path === undefined)
          return { text: "invalid read", passed: false, violation: "invalid_action" };
        const content = this.workspace.get(action.path);
        if (content === undefined) return { text: `file not found: ${action.path}`, passed: false };
        return { text: content, passed: true };
      }
      case "write": {
        if (action.path === undefined || action.content === undefined)
          return { text: "invalid write", passed: false, violation: "invalid_action" };
        this.workspace.set(action.path, action.content);
        this.generation++;
        return { text: `write ok: ${action.path}`, passed: true };
      }
      case "edit": {
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
        return { text: `edit ok: ${action.path}`, passed: true };
      }
      case "test":
        return this.executeTest(action);
      case "finish":
        return { text: "finished", passed: true };
    }
  }

  private async executeTest(action: ActorAction): Promise<ExecutionResult> {
    const testId = action.command;
    if (!testId || !this.task.allowedTests.includes(testId))
      return {
        text: `test not allowed: ${testId ?? "missing"}`,
        passed: false,
        violation: "test_not_allowed",
      };
    const oracle = this.scoring?.oracles?.find((candidate) => candidate.testId === testId);
    const command = `${EXPERIMENT_TEST_COMMAND} ${testId}`;
    const checkKey = verificationCheckKey("test", EXPERIMENT_CWD, command);
    const generation = this.generation;
    if (oracle?.kind === "script" && oracle.script) {
      const run = await runScriptOracle(this.workspace, oracle.script, this.options);
      const status = run.passed ? "passed" : "failed";
      this.checks.set(checkKey, { testId, status, generation, command });
      return {
        text: `test ${testId}: ${status}${run.output ? `\n${run.output}` : ""}`,
        passed: run.passed,
        verification: { testId, command, checkKey, status, generation },
      };
    }
    if (oracle?.kind === "expected_files" || (!oracle && this.expectedFiles())) {
      const expected = this.scoring?.expectedFiles ?? this.task.expectedFiles ?? {};
      const mismatches = Object.entries(expected).filter(
        ([path, content]) => this.workspace.get(path) !== content,
      );
      const status = mismatches.length ? "failed" : "passed";
      this.checks.set(checkKey, { testId, status, generation, command });
      return {
        text: mismatches.length
          ? `test ${testId}: failed (files differ: ${mismatches.map(([path]) => path).join(", ")})`
          : `test ${testId}: passed`,
        passed: !mismatches.length,
        verification: { testId, command, checkKey, status, generation },
      };
    }
    return {
      text: `test ${testId}: no oracle registered`,
      passed: false,
      violation: "test_no_oracle",
    };
  }

  async evaluateFinal(): Promise<readonly OracleRunResult[]> {
    const results: OracleRunResult[] = [];
    for (const testId of this.task.allowedTests) {
      const oracle = this.scoring?.oracles?.find((candidate) => candidate.testId === testId);
      if (oracle?.kind === "script" && oracle.script) {
        const run = await runScriptOracle(this.workspace, oracle.script, this.options);
        results.push({ testId, status: run.passed ? "passed" : "failed", output: run.output });
      } else if (oracle?.kind === "expected_files") {
        const expected = this.scoring?.expectedFiles ?? {};
        const ok = Object.entries(expected).every(
          ([path, content]) => this.workspace.get(path) === content,
        );
        results.push({ testId, status: ok ? "passed" : "failed" });
      } else if (!oracle && this.expectedFiles()) {
        const expected = this.expectedFiles()!;
        const ok = Object.entries(expected).every(
          ([path, content]) => this.workspace.get(path) === content,
        );
        results.push({ testId, status: ok ? "passed" : "failed" });
      } else results.push({ testId, status: "not_run" });
    }
    return results;
  }

  verificationFacts(): {
    readonly verification: HotState["verification"];
    readonly blockers: readonly HotState["activeBlockers"][number][];
  } {
    let latest:
      | {
          readonly testId: string;
          readonly status: "passed" | "failed";
          readonly generation: number;
          readonly command: string;
          readonly checkKey: string;
        }
      | undefined;
    const blockers: HotState["activeBlockers"][number][] = [];
    for (const [checkKey, check] of this.checks) {
      if (!latest || check.generation >= latest.generation) latest = { ...check, checkKey };
      if (check.status === "failed")
        blockers.push({
          eventId: `env-${check.testId}` as HotState["activeBlockers"][number]["eventId"],
          origin: "verification",
          kind: "test",
          checkKey,
          category: "test",
        });
    }
    const verification: HotState["verification"] = {
      build: { status: "not_run", freshness: "unknown" },
      lint: { status: "not_run", freshness: "unknown" },
      test: latest
        ? {
            status: latest.status,
            freshness: latest.generation === this.generation ? "current" : "stale",
            command: latest.command,
            cwd: normalizeCwd(EXPERIMENT_CWD),
            checkKey: latest.checkKey,
            observedGeneration: latest.generation,
            attributable: true,
          }
        : { status: "not_run", freshness: "unknown" },
    };
    return { verification, blockers };
  }

  private expectedFiles(): Readonly<Record<string, string>> | undefined {
    return this.scoring?.expectedFiles ?? this.task.expectedFiles;
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

async function runScriptOracle(
  workspace: ReadonlyMap<string, string>,
  script: string,
  options: EnvironmentOptions,
): Promise<{ readonly passed: boolean; readonly output: string }> {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-oracle-"));
  try {
    for (const [path, content] of workspace) {
      const target = join(directory, path);
      await writeFile(target, content, { encoding: "utf8", flag: "w" }).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, content, "utf8");
      });
    }
    const timeoutMs = options.oracleTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const limit = options.oracleOutputLimit ?? DEFAULT_OUTPUT_LIMIT;
    const env = { PATH: dirname(process.execPath), TMPDIR: directory };
    const argv = options.isolated
      ? ["-p", SANDBOX_PROFILE, process.execPath, "--input-type=module", "--eval", script]
      : ["--input-type=module", "--eval", script];
    const command = options.isolated ? "sandbox-exec" : process.execPath;
    return await new Promise((resolvePromise) => {
      execFile(
        command,
        argv,
        {
          cwd: directory,
          env,
          timeout: timeoutMs,
          maxBuffer: limit,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          const output = (stdout + stderr).slice(0, limit).trim();
          if (error && (error as { killed?: boolean }).killed)
            resolvePromise({ passed: false, output: `oracle timeout: ${output}` });
          else resolvePromise({ passed: !error, output });
        },
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

const SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny network*)",
  '(deny file-write* (subpath "/Users") (subpath "/private/etc") (subpath "/nix"))',
].join("\n");

interface IsolationStatus {
  readonly available: boolean;
  readonly mechanism: "sandbox-exec" | "none";
  readonly detail: string;
}

export async function checkIsolation(): Promise<IsolationStatus> {
  if (process.platform !== "darwin")
    return { available: false, mechanism: "none", detail: "no sandbox mechanism on this platform" };
  return new Promise((resolvePromise) => {
    execFile(
      "sandbox-exec",
      ["-p", "(version 1)(allow default)", "/usr/bin/true"],
      { timeout: 5000 },
      (error) => {
        if (error)
          resolvePromise({
            available: false,
            mechanism: "none",
            detail: `sandbox-exec probe failed: ${error.message}`,
          });
        else
          resolvePromise({
            available: true,
            mechanism: "sandbox-exec",
            detail: "sandbox-exec seatbelt profile available",
          });
      },
    );
  });
}
