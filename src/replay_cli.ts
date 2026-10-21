#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { jsonLines, readConfigFile, traceMetadata, writeArtifacts } from "./cli_io.js";
import { createUpdater } from "./composition.js";
import type { ReflexStateConfig } from "./core/config.js";
import { NoopStateUpdater, RecordedDecisionsUpdater } from "./core/updater.js";
import type { StateUpdater } from "./core/updater.js";
import { replay } from "./replay/runner.js";
import { parseEvents, parseRecording } from "./replay/trace.js";
import { redact } from "./typesafe/input.js";

interface CliArguments {
  readonly input: string;
  readonly mode: string;
  readonly config?: string | undefined;
  readonly cwd?: string | undefined;
  readonly out: string;
}

type ReplayResult = Awaited<ReturnType<typeof replay>>;

async function main(): Promise<void> {
  const args = parseCliArguments();
  const recordedPath = recordedPathFor(args);
  const recording = recordedPath ? parseRecording(await readFile(recordedPath, "utf8")) : undefined;
  const metadata = await traceMetadata(join(dirname(args.input), "trace_meta.json"));
  const config = withEnvironment(await baseConfig(args.config, metadata.config));
  const updater = recording
    ? new RecordedDecisionsUpdater(recording)
    : createReplayUpdater(args.mode, config);
  const result = await replay(parseEvents(await readFile(args.input, "utf8")), {
    cwd: args.cwd ?? metadata.cwd ?? process.cwd(),
    config,
    updater,
    ...(recording ? { recording } : {}),
  });
  await writeReplayArtifacts(args, recordedPath, result);
  console.log(JSON.stringify(result.state, null, 2));
  console.error(summarize(result) + " Artifacts: " + args.out);
}

function parseCliArguments(): CliArguments {
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
  return { input, mode, config: values.config, cwd: values.cwd, out: values.out };
}

function recordedPathFor({ mode, input }: CliArguments): string | undefined {
  return mode.startsWith("recorded")
    ? mode.slice(9) || join(dirname(input), "transitions.jsonl")
    : undefined;
}

async function baseConfig(
  path: string | undefined,
  traceConfig: ReflexStateConfig | undefined,
): Promise<ReflexStateConfig> {
  if (path) return readConfigFile(path);
  return traceConfig ?? (await readConfigFile(undefined));
}

function withEnvironment(base: ReflexStateConfig): ReflexStateConfig {
  return {
    ...base,
    jev: {
      ...base.jev,
      enabled: process.env.REFLEX_STATE_DISABLE_JEV === "1" ? false : base.jev.enabled,
    },
  };
}

function createReplayUpdater(mode: string, config: ReflexStateConfig): StateUpdater {
  return mode === "jev" ? createUpdater(config, console.error) : new NoopStateUpdater();
}

function summarize(result: ReplayResult): string {
  return (
    result.transitions.length +
    " events; task " +
    result.state.taskStatus +
    "; Jev calls " +
    result.metrics.jevCalls +
    "."
  );
}

async function writeReplayArtifacts(
  args: CliArguments,
  recordedPath: string | undefined,
  result: ReplayResult,
): Promise<void> {
  await writeArtifacts(
    args.out,
    {
      "final_state.json": JSON.stringify(result.state, null, 2) + "\n",
      "transitions.jsonl": jsonLines(result.transitions),
      "metrics.json": JSON.stringify(result.metrics, null, 2) + "\n",
      "summary.txt": summarize(result) + "\n",
    },
    [args.input, ...(recordedPath ? [recordedPath] : [])],
  );
}

await main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : "Replay failed"));
  process.exitCode = 1;
});
