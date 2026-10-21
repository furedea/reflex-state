import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolvedLauncher, sandboxProfile, spawnOnce } from "./task_environment_oracle.js";
import type { ResolvedLauncher, SpawnResult } from "./task_environment_oracle.js";

interface IsolationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface IsolationStatus {
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
