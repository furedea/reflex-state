#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { jsonLines, readConfigFile, traceMetadata, writeArtifacts } from "./cli_io.js";
import { createUpdater } from "./composition.js";
import { NoopStateUpdater, RecordedDecisionsUpdater } from "./core/updater.js";
import { replay } from "./replay/runner.js";
import { parseEvents, parseRecording } from "./replay/trace.js";
import { redact } from "./typesafe/input.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      updater: { type: "string", default: "noop" },
      config: { type: "string" },
      cwd: { type: "string" },
      out: { type: "string", default: "replay-output" },
    },
  });
  const input = positionals[0];
  if (!input || positionals.length !== 1)
    throw new Error(
      "Usage: reflex-state-replay <events.jsonl> --updater noop|jev|recorded[:path] [--config file] [--cwd dir] [--out dir]",
    );
  const mode = values.updater;
  if (mode !== "noop" && mode !== "jev" && mode !== "recorded" && !mode.startsWith("recorded:"))
    throw new Error("Unknown updater");
  const recordedPath = mode.startsWith("recorded")
    ? mode.slice(9) || join(dirname(input), "transitions.jsonl")
    : undefined;
  const recording = recordedPath ? parseRecording(await readFile(recordedPath, "utf8")) : undefined;
  const metadata = await traceMetadata(join(dirname(input), "trace_meta.json"));
  const base = values.config
    ? await readConfigFile(values.config)
    : (metadata.config ?? (await readConfigFile(undefined)));
  const config = {
    ...base,
    jev: {
      ...base.jev,
      enabled: process.env.REFLEX_STATE_DISABLE_JEV === "1" ? false : base.jev.enabled,
    },
  };
  const updater = recording
    ? new RecordedDecisionsUpdater(recording)
    : mode === "jev"
      ? createUpdater(config, console.error)
      : new NoopStateUpdater();
  const result = await replay(parseEvents(await readFile(input, "utf8")), {
    cwd: values.cwd ?? metadata.cwd ?? process.cwd(),
    config,
    updater,
    ...(recording ? { recording } : {}),
  });
  const summary =
    result.transitions.length +
    " events; task " +
    result.state.taskStatus +
    "; Jev calls " +
    result.metrics.jevCalls +
    ".";
  await writeArtifacts(
    values.out,
    {
      "final_state.json": JSON.stringify(result.state, null, 2) + "\n",
      "transitions.jsonl": jsonLines(result.transitions),
      "metrics.json": JSON.stringify(result.metrics, null, 2) + "\n",
      "summary.txt": summary + "\n",
    },
    [input, ...(recordedPath ? [recordedPath] : [])],
  );
  console.log(JSON.stringify(result.state, null, 2));
  console.error(summary + " Artifacts: " + values.out);
}

await main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : "Replay failed"));
  process.exitCode = 1;
});
