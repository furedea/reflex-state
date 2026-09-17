import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { defaultConfig } from "./core/config.js";
import type { ReflexStateConfig } from "./core/config.js";
import { mergeConfig } from "./core/config_validation.js";
import { isRecord } from "./core/serialization.js";

export async function readConfigFile(path: string | undefined) {
  if (!path) return defaultConfig();
  const result = mergeConfig(defaultConfig(), JSON.parse(await readFile(path, "utf8")));
  for (const warning of result.warnings) console.error(warning);
  return result.config;
}

export async function traceMetadata(
  path: string,
): Promise<{ cwd?: string; config?: ReflexStateConfig }> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new Error("Invalid trace metadata");
    const result =
      value.config === undefined ? undefined : mergeConfig(defaultConfig(), value.config);
    for (const warning of result?.warnings ?? []) console.error(warning);
    return {
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(result ? { config: result.config } : {}),
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw new Error("Invalid trace metadata");
  }
}

export async function writeArtifacts(
  directory: string,
  artifacts: Readonly<Record<string, string>>,
  inputs: readonly string[],
): Promise<void> {
  const sources = new Set(inputs.map((path) => resolve(path)));
  for (const name of Object.keys(artifacts)) {
    if (sources.has(resolve(directory, name)))
      throw new Error("Output would overwrite an input file");
  }
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(artifacts))
    await writeFile(join(directory, name), content);
}

export function jsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
}
