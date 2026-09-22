import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { HotState } from "../../core/types.js";
import { normalizeCwd, verificationCheckKey } from "../../core/verification.js";
import type {
  ActorAction,
  ExperimentCheckFact,
  FactsView,
  HybridTask,
  TaskScoring,
} from "./types.js";

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
      readonly seq: number;
      readonly evidenceId?: string;
    }
  >();
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
        return { text: `write ok: ${action.path} (gen=${this.generation})`, passed: true };
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
        return { text: `edit ok: ${action.path} (gen=${this.generation})`, passed: true };
      }
      case "test":
        return this.executeTest(action, evidenceId);
      case "finish":
        return { text: "finished", passed: true };
    }
  }

  private async executeTest(action: ActorAction, evidenceId?: string): Promise<ExecutionResult> {
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
    const seq = this.seq++;
    const record = (
      status: "passed" | "failed",
      text: string,
      constraints?: Readonly<Record<string, boolean>>,
    ) => {
      this.checks.set(checkKey, {
        testId,
        status,
        generation,
        command,
        seq,
        ...(evidenceId ? { evidenceId } : {}),
      });
      return {
        text,
        passed: status === "passed",
        verification: {
          testId,
          command,
          checkKey,
          status,
          generation,
          seq,
          ...(evidenceId ? { evidenceId } : {}),
          ...(constraints ? { constraints } : {}),
        },
      };
    };
    if (oracle?.kind === "script" && oracle.script) {
      const run = await runScriptOracle(this.workspace, oracle.script, this.options);
      const status = run.passed ? "passed" : "failed";
      return record(
        status,
        `test ${testId}: ${status} check=${checkKey} gen=${generation} seq=${seq}${evidenceId ? ` evidence=${evidenceId}` : ""}${run.output ? `\n${run.output}` : ""}`,
        run.constraints,
      );
    }
    // A task with a scoring file never falls back to the task's expectedFiles;
    // every allowed test needs an explicitly declared oracle.
    if (
      oracle?.kind === "expected_files" ||
      (!oracle && !this.scoring && this.task.expectedFiles)
    ) {
      const expected = oracle
        ? (this.scoring?.expectedFiles ?? {})
        : (this.task.expectedFiles ?? {});
      const mismatches = Object.entries(expected).filter(
        ([path, content]) => this.workspace.get(path) !== content,
      );
      const status = mismatches.length ? "failed" : "passed";
      return record(
        status,
        mismatches.length
          ? `test ${testId}: failed (files differ: ${mismatches.map(([path]) => path).join(", ")})`
          : `test ${testId}: passed check=${checkKey} gen=${generation} seq=${seq}${evidenceId ? ` evidence=${evidenceId}` : ""}`,
      );
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
        results.push({
          testId,
          // An oracle that never executed is "not_run", not a failure of the
          // artifact (e.g. required sandbox unavailable on this host).
          status: run.ran === false ? "not_run" : run.passed ? "passed" : "failed",
          output: run.output,
          ...(run.constraints ? { constraints: run.constraints } : {}),
        });
      } else if (oracle?.kind === "expected_files") {
        const expected = this.scoring?.expectedFiles ?? {};
        const ok = Object.entries(expected).every(
          ([path, content]) => this.workspace.get(path) === content,
        );
        results.push({ testId, status: ok ? "passed" : "failed" });
      } else if (!oracle && !this.scoring && this.task.expectedFiles) {
        const ok = Object.entries(this.task.expectedFiles).every(
          ([path, content]) => this.workspace.get(path) === content,
        );
        results.push({ testId, status: ok ? "passed" : "failed" });
      } else results.push({ testId, status: "not_run" });
    }
    return results;
  }

  verificationFacts(): {
    readonly verification: FactsView["verification"];
    readonly blockers: readonly HotState["activeBlockers"][number][];
  } {
    let latest:
      | {
          readonly testId: string;
          readonly status: "passed" | "failed";
          readonly generation: number;
          readonly command: string;
          readonly checkKey: string;
          readonly seq: number;
        }
      | undefined;
    const latestPerTest = new Map<string, { generation: number; seq: number; checkKey: string }>();
    const blockers: HotState["activeBlockers"][number][] = [];
    for (const [checkKey, check] of this.checks) {
      if (
        !latest ||
        check.generation > latest.generation ||
        (check.generation === latest.generation && check.seq > latest.seq)
      )
        latest = { ...check, checkKey };
      const prior = latestPerTest.get(check.testId);
      if (
        !prior ||
        check.generation > prior.generation ||
        (check.generation === prior.generation && check.seq > prior.seq)
      )
        latestPerTest.set(check.testId, {
          generation: check.generation,
          seq: check.seq,
          checkKey,
        });
      if (check.status === "failed")
        blockers.push({
          eventId: `env-${check.testId}` as HotState["activeBlockers"][number]["eventId"],
          origin: "verification",
          kind: "test",
          checkKey,
          category: "test",
        });
    }
    // Per-test facts let scoring compare each declared test's latest result;
    // a different check's success can never masquerade as this test's.
    const tests: Record<string, ExperimentCheckFact> = {};
    for (const [checkKey, check] of this.checks) {
      const latestForTest = latestPerTest.get(check.testId);
      if (!latestForTest || latestForTest.checkKey !== checkKey) continue;
      tests[check.testId] = {
        testId: check.testId,
        status: check.status,
        freshness: check.generation === this.generation ? "current" : "stale",
        command: check.command,
        checkKey,
        observedGeneration: check.generation,
      };
    }
    const verification: FactsView["verification"] = {
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
      tests,
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

interface OracleVerdict {
  readonly passed: boolean;
  readonly detail?: string;
  readonly constraints?: Readonly<Record<string, boolean>>;
}

/** The oracle result protocol: the last `oracle-result:` line must be a JSON
 * object with a boolean `passed`; it may also carry a `constraints` map of
 * per-constraint boolean verdicts. A clean exit or a "passed" print without
 * the verdict line is not evidence of success. */
function parseOracleResult(stdout: string): OracleVerdict | null {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith("oracle-result:"))
    .at(-1);
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line.slice("oracle-result:".length));
    if (
      value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).passed === "boolean"
    ) {
      const record = value as Record<string, unknown>;
      const constraints =
        record.constraints && typeof record.constraints === "object"
          ? Object.fromEntries(
              Object.entries(record.constraints as Record<string, unknown>).filter(
                ([, verdict]) => typeof verdict === "boolean",
              ),
            )
          : undefined;
      const detail = record.detail;
      return {
        passed: record.passed as boolean,
        ...(typeof detail === "string" && detail ? { detail } : {}),
        ...(constraints && Object.keys(constraints).length
          ? { constraints: constraints as Record<string, boolean> }
          : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Trusted prelude prepended to every script oracle. `loadModule` evaluates a
 * workspace module as untrusted code inside a fresh vm context. The context is
 * created from a null-prototype sandbox and receives no host values — the
 * console is built inside the candidate realm — so candidate code cannot reach
 * a host-realm Function/process through a constructor chain, and only this
 * trusted script can emit the `oracle-result:` verdict. Candidate code only
 * produces return values and exceptions; pass/fail is decided outside it. */
const TRUSTED_PRELUDE = `import { readFileSync as __oracleReadFileSync } from "node:fs";
import vm from "node:vm";
async function loadModule(path) {
  const source = __oracleReadFileSync(path, "utf8");
  const context = vm.createContext(Object.create(null));
  new vm.Script(
    "globalThis.__oracleLogs = [];" +
      "const __write = (level) => (...args) => {" +
      "  if (globalThis.__oracleLogs.length < 100)" +
      "    globalThis.__oracleLogs.push(level + \\": \\" + args.map(String).join(\\" \\"));" +
      "};" +
      "globalThis.console = { log: __write(\\"log\\"), info: __write(\\"info\\")," +
      " warn: __write(\\"warn\\"), error: __write(\\"error\\"), debug: __write(\\"debug\\") };",
  ).runInContext(context);
  const mod = new vm.SourceTextModule(source, { context, identifier: String(path) });
  await mod.link(() => {
    throw new Error("candidate imports are not allowed");
  });
  await mod.evaluate();
  return mod.namespace;
}
`;

interface ResolvedLauncher {
  /** Absolute, symlink-resolved sandbox launcher. */
  readonly sandbox: string;
  /** Absolute, symlink-resolved node binary. */
  readonly node: string;
}

let launcherCache: ResolvedLauncher | null | undefined;

/** Resolve the sandbox launcher and node binary once; preflight and the real
 * execution use the same absolute paths so PATH tricks cannot swap binaries. */
function resolvedLauncher(): ResolvedLauncher | null {
  if (launcherCache !== undefined) return launcherCache;
  if (process.platform !== "darwin") {
    launcherCache = null;
    return null;
  }
  try {
    launcherCache = {
      sandbox: realpathSync("/usr/bin/sandbox-exec"),
      node: realpathSync(process.execPath),
    };
  } catch {
    launcherCache = null;
  }
  return launcherCache;
}

/** Default-deny seatbelt profile: the oracle process may exec only the resolved
 * node binary, read the workspace and runtime dependencies, and write inside
 * the workspace. Network, user trees, and inherited secrets are denied.
 * Ancestor literals of the workspace are required because dyld/stat walks the
 * path chain; without them the child aborts during startup. */
function sandboxProfile(workdir: string, nodeBin: string): string {
  const ancestors: string[] = [];
  let parent = dirname(workdir);
  while (parent && parent !== "/") {
    ancestors.push(parent);
    parent = dirname(parent);
  }
  const nodeRoot = dirname(dirname(nodeBin));
  const runtimeRoots = [nodeRoot, "/nix/store"].filter((path) => path !== "/" && path !== "/usr");
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal "${nodeBin}"))`,
    "(allow process-fork)",
    '(allow file-read* (literal "/")',
    ...ancestors.map((path) => `  (literal "${path}")`),
    `  (subpath "${workdir}")`,
    ...runtimeRoots.map((path) => `  (subpath "${path}")`),
    '  (subpath "/usr/lib")',
    '  (subpath "/usr/share")',
    '  (subpath "/System/Library")',
    '  (subpath "/Library/Apple")',
    '  (literal "/private/etc/localtime")',
    '  (literal "/dev/null")',
    '  (literal "/dev/urandom")',
    '  (literal "/dev/random"))',
    `(allow file-write* (subpath "${workdir}") (literal "/dev/null"))`,
    "(allow file-ioctl)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
  ].join("\n");
}

interface SpawnResult {
  readonly error: Error | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
}

function spawnOnce(
  command: string,
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly maxBuffer: number;
  },
): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      [...argv],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        resolvePromise({
          error,
          stdout,
          stderr,
          killed: Boolean(error && (error as { killed?: boolean }).killed),
        });
      },
    );
  });
}

async function runScriptOracle(
  workspace: ReadonlyMap<string, string>,
  script: string,
  options: EnvironmentOptions,
): Promise<{
  readonly passed: boolean;
  readonly output: string;
  /** False when the oracle never ran (sandbox unavailable); the caller must
   * not count that as an artifact failure. */
  readonly ran?: boolean;
  readonly constraints?: Readonly<Record<string, boolean>>;
}> {
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
    const body = `${TRUSTED_PRELUDE}\n${script}`;
    let command: string;
    let argv: string[];
    if (options.isolated) {
      const launcher = resolvedLauncher();
      if (!launcher)
        return {
          passed: false,
          ran: false,
          output: "sandbox-exec unavailable on this host; oracle not run",
        };
      command = launcher.sandbox;
      argv = [
        "-p",
        sandboxProfile(realpathSync(directory), launcher.node),
        launcher.node,
        "--experimental-vm-modules",
        "--input-type=module",
        "--eval",
        body,
      ];
    } else {
      command = process.execPath;
      argv = ["--experimental-vm-modules", "--input-type=module", "--eval", body];
    }
    // The child environment is replaced, not merged: only the runtime directory
    // and the workspace TMPDIR are provided, so parent secrets are not inherited.
    const env = {
      PATH: dirname(options.isolated ? resolvedLauncher()!.node : process.execPath),
      TMPDIR: directory,
    };
    const run = await spawnOnce(command, argv, {
      cwd: directory,
      env,
      timeoutMs,
      maxBuffer: limit,
    });
    const output = (run.stdout + run.stderr).slice(0, limit).trim();
    if (run.killed) return { passed: false, output: `oracle stopped by limits: ${output}` };
    const verdict = run.error ? null : parseOracleResult(run.stdout);
    if (!verdict)
      return {
        passed: false,
        output: `invalid_result_protocol: ${run.error ? `${run.error.message} ` : ""}${output}`,
      };
    return {
      passed: verdict.passed,
      output: verdict.detail ?? output,
      ...(verdict.constraints ? { constraints: verdict.constraints } : {}),
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface IsolationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface IsolationStatus {
  readonly available: boolean;
  readonly mechanism: "sandbox-exec" | "none";
  readonly detail: string;
  readonly checks?: readonly IsolationCheck[];
  readonly profileHash?: string;
}

const PROBE_TIMEOUT_MS = 5000;
const PROBE_OUTPUT_LIMIT = 32_768;

async function runProbe(
  launcher: ResolvedLauncher,
  workdir: string,
  script: string,
): Promise<SpawnResult> {
  return spawnOnce(
    launcher.sandbox,
    [
      "-p",
      sandboxProfile(realpathSync(workdir), launcher.node),
      launcher.node,
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: workdir,
      env: { PATH: dirname(launcher.node), TMPDIR: workdir },
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_OUTPUT_LIMIT,
    },
  );
}

/**
 * Verify the real isolation boundary on this host using the same launcher,
 * profile, runtime resolution, and environment as actual oracle runs. This is
 * a boundary check, not a proof against unknown OS vulnerabilities.
 */
export async function checkIsolation(): Promise<IsolationStatus> {
  const launcher = resolvedLauncher();
  if (!launcher) {
    const reason =
      process.platform === "darwin"
        ? "sandbox-exec not found at /usr/bin/sandbox-exec"
        : "no sandbox mechanism on this platform";
    return { available: false, mechanism: "none", detail: reason };
  }
  const workdir = await mkdtemp(join(tmpdir(), "hybrid-isolation-"));
  const outside = await mkdtemp(join(tmpdir(), "hybrid-sentinel-"));
  try {
    await writeFile(join(outside, "sentinel.txt"), "probe-secret", "utf8");
    const outsideSentinel = realpathSync(join(outside, "sentinel.txt"));
    await writeFile(join(workdir, "inside.txt"), "workspace-file", "utf8");
    await symlink(outsideSentinel, join(workdir, "escape.txt"));
    const profile = sandboxProfile(realpathSync(workdir), launcher.node);
    const profileHash = createHash("sha256").update(profile).digest("hex").slice(0, 16);
    const checks: IsolationCheck[] = [];
    const check = async (name: string, run: () => Promise<IsolationCheck>) => {
      try {
        checks.push(await run());
      } catch (error) {
        checks.push({
          name,
          passed: false,
          detail: error instanceof Error ? error.message : "probe error",
        });
      }
    };
    await check("allowed_write_and_oracle", async () => {
      const run = await runProbe(
        launcher,
        workdir,
        `import { writeFileSync } from "node:fs";
         writeFileSync("probe-out.txt", "ok");
         console.log("oracle-result: " + JSON.stringify({ passed: true }));`,
      );
      return {
        name: "allowed_write_and_oracle",
        passed: !run.error && run.stdout.includes("oracle-result:"),
        detail: run.error ? run.error.message : "workspace write + verdict protocol ok",
      };
    });
    await check("outside_read_denied", async () => {
      const run = await runProbe(
        launcher,
        workdir,
        `import { readFileSync } from "node:fs";
         try { readFileSync(${JSON.stringify(outsideSentinel)}); process.exit(3); }
         catch { process.exit(0); }`,
      );
      return {
        name: "outside_read_denied",
        passed: !run.error,
        detail: run.error ? `probe error: ${run.error.message}` : "out-of-scope read denied",
      };
    });
    await check("symlink_escape_denied", async () => {
      const run = await runProbe(
        launcher,
        workdir,
        `import { readFileSync } from "node:fs";
         try { readFileSync("escape.txt"); process.exit(3); }
         catch { process.exit(0); }`,
      );
      return {
        name: "symlink_escape_denied",
        passed: !run.error,
        detail: run.error ? `probe error: ${run.error.message}` : "symlink escape denied",
      };
    });
    await check("env_not_inherited", async () => {
      // A secret-like marker in the parent environment must not reach the
      // child: the spawn env is a fixed replacement, not a merge.
      const previous = process.env.HYBRID_PROBE_SECRET;
      process.env.HYBRID_PROBE_SECRET = "should-not-leak";
      try {
        const run = await runProbe(
          launcher,
          workdir,
          `process.exit(process.env.HYBRID_PROBE_SECRET === undefined ? 0 : 4);`,
        );
        return {
          name: "env_not_inherited",
          passed: !run.error,
          detail: run.error ? `probe error: ${run.error.message}` : "parent env not inherited",
        };
      } finally {
        if (previous === undefined) delete process.env.HYBRID_PROBE_SECRET;
        else process.env.HYBRID_PROBE_SECRET = previous;
      }
    });
    await check("network_denied", async () => {
      const server = createServer();
      await new Promise<void>((resolvePromise) =>
        server.listen(0, "127.0.0.1", () => resolvePromise()),
      );
      const port = (server.address() as { port: number }).port;
      try {
        const run = await runProbe(
          launcher,
          workdir,
          `import { connect } from "node:net";
           const socket = connect(${port}, "127.0.0.1");
           socket.on("connect", () => { socket.destroy(); process.exit(5); });
           socket.on("error", () => process.exit(0));
           setTimeout(() => process.exit(0), 2000);`,
        );
        return {
          name: "network_denied",
          passed: !run.error,
          detail: run.error ? `probe error: ${run.error.message}` : "loopback connect denied",
        };
      } finally {
        server.close();
      }
    });
    await check("timeout_enforced", async () => {
      const started = performance.now();
      const run = await runProbe(launcher, workdir, "while (true) {}");
      return {
        name: "timeout_enforced",
        passed: run.killed && performance.now() - started < PROBE_TIMEOUT_MS + 4000,
        detail: run.killed ? "infinite loop killed by timeout" : "timeout not enforced",
      };
    });
    const available = checks.every((entry) => entry.passed);
    return {
      available,
      mechanism: "sandbox-exec",
      detail: available
        ? "sandbox-exec boundary verified on this host"
        : `sandbox boundary failed: ${checks
            .filter((entry) => !entry.passed)
            .map((entry) => entry.name)
            .join(", ")}`,
      checks,
      profileHash,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
  }
}
