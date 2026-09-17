import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { traceMetadata } from "./cli_io.js";
import { defaultConfig } from "./core/config.js";

test("exported configuration and cwd are available as replay defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reflex-state-meta-"));
  try {
    const path = join(directory, "trace_meta.json");
    const config = {
      ...defaultConfig(),
      verificationCommands: { test: ["^make check$"], build: [], lint: [] },
    };
    await writeFile(path, JSON.stringify({ cwd: "/original/worktree", config }));
    expect(await traceMetadata(path)).toEqual({ cwd: "/original/worktree", config });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
