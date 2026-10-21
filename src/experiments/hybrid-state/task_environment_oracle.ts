import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface EnvironmentOptions {
  readonly isolated: boolean;
  readonly oracleTimeoutMs?: number;
  readonly oracleOutputLimit?: number;
}

export interface OracleRun {
  readonly passed: boolean;
  readonly output: string;
  /** False when the oracle never ran (sandbox unavailable); the caller must
   * not count that as an artifact failure. */
  readonly ran?: boolean;
  readonly constraints?: Readonly<Record<string, boolean>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 65_536;

interface OracleVerdict {
  readonly passed: boolean;
  readonly detail?: string;
  readonly constraints?: Readonly<Record<string, boolean>>;
}

interface OracleLaunch {
  readonly command: string;
  readonly argv: readonly string[];
  readonly nodeBin: string;
}

export async function runScriptOracle(
  workspace: ReadonlyMap<string, string>,
  script: string,
  options: EnvironmentOptions,
): Promise<OracleRun> {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-oracle-"));
  try {
    await writeWorkspace(directory, workspace);
    return await executeOracle(directory, script, options);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeWorkspace(
  directory: string,
  workspace: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [path, content] of workspace) {
    const target = join(directory, path);
    await writeFile(target, content, { encoding: "utf8", flag: "w" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    });
  }
}

async function executeOracle(
  directory: string,
  script: string,
  options: EnvironmentOptions,
): Promise<OracleRun> {
  const timeoutMs = options.oracleTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.oracleOutputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const launch = oracleLaunch(directory, `${TRUSTED_PRELUDE}\n${script}`, options);
  if (!launch)
    return {
      passed: false,
      ran: false,
      output: "sandbox-exec unavailable on this host; oracle not run",
    };
  // The child environment is replaced, not merged: only the runtime directory
  // and the workspace TMPDIR are provided, so parent secrets are not inherited.
  const env = { PATH: dirname(launch.nodeBin), TMPDIR: directory };
  const run = await spawnOnce(launch.command, launch.argv, {
    cwd: directory,
    env,
    timeoutMs,
    maxBuffer: limit,
  });
  return interpretOracleRun(run, limit);
}

function oracleLaunch(
  directory: string,
  body: string,
  options: EnvironmentOptions,
): OracleLaunch | undefined {
  if (!options.isolated)
    return {
      command: process.execPath,
      argv: ["--experimental-vm-modules", "--input-type=module", "--eval", body],
      nodeBin: process.execPath,
    };
  const launcher = resolvedLauncher();
  if (!launcher) return undefined;
  return {
    command: launcher.sandbox,
    argv: [
      "-p",
      sandboxProfile(realpathSync(directory), launcher.node),
      launcher.node,
      "--experimental-vm-modules",
      "--input-type=module",
      "--eval",
      body,
    ],
    nodeBin: launcher.node,
  };
}

function interpretOracleRun(run: SpawnResult, limit: number): OracleRun {
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
    return oracleVerdict(JSON.parse(line.slice("oracle-result:".length)));
  } catch {
    return null;
  }
}

function oracleVerdict(value: unknown): OracleVerdict | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.passed !== "boolean") return null;
  const constraints = booleanVerdicts(record.constraints);
  const detail = record.detail;
  return {
    passed: record.passed,
    ...(typeof detail === "string" && detail ? { detail } : {}),
    ...(constraints && Object.keys(constraints).length ? { constraints } : {}),
  };
}

function booleanVerdicts(raw: unknown): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([, verdict]) => typeof verdict === "boolean",
    ),
  ) as Record<string, boolean>;
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

export interface ResolvedLauncher {
  /** Absolute, symlink-resolved sandbox launcher. */
  readonly sandbox: string;
  /** Absolute, symlink-resolved node binary. */
  readonly node: string;
}

let launcherCache: ResolvedLauncher | null | undefined;

/** Resolve the sandbox launcher and node binary once; preflight and the real
 * execution use the same absolute paths so PATH tricks cannot swap binaries. */
export function resolvedLauncher(): ResolvedLauncher | null {
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
export function sandboxProfile(workdir: string, nodeBin: string): string {
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

export interface SpawnResult {
  readonly error: Error | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
}

export function spawnOnce(
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
