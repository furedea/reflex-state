#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { jsonLines, readConfigFile, writeArtifacts } from "./cli_io.js";
import { isRecord, parseJsonLines } from "./core/serialization.js";
import { exportSession } from "./pi/trace.js";
import { redact } from "./typesafe/input.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      leaf: { type: "string" },
      config: { type: "string" },
      out: { type: "string", default: "trace-output" },
    },
  });
  const input = positionals[0];
  if (!input || positionals.length !== 1)
    throw new Error(
      "Usage: reflex-state-export <session.jsonl> [--leaf id] [--out dir] [--config file]",
    );
  const entries = parseJsonLines(await readFile(input, "utf8"), (value) => {
    if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid Pi entry");
    return value;
  });
  const result = exportSession(entries, {
    config: await readConfigFile(values.config),
    ...(values.leaf ? { leaf: values.leaf } : {}),
  });
  await writeArtifacts(
    values.out,
    {
      "events.jsonl": jsonLines(result.events),
      "transitions.jsonl": jsonLines(result.transitions),
      "trace_meta.json":
        JSON.stringify(
          {
            cwd: result.cwd,
            config: result.config,
            leaf: result.leaf,
            formatVersion: result.formatVersion,
            legacy: result.legacy,
          },
          null,
          2,
        ) + "\n",
    },
    [input],
  );
  console.log(result.events.length + " events exported to " + values.out);
}

await main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : "Trace export failed"));
  process.exitCode = 1;
});
