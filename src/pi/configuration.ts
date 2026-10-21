import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../core/config.js";
import type { ReflexStateConfig } from "../core/config.js";
import { mergeConfig } from "../core/config_validation.js";
import { isRecord } from "../core/serialization.js";

interface ConfigOptions {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly globalPath?: string;
  readonly readText?: (path: string) => Promise<string>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

type Environment = Readonly<Record<string, string | undefined>>;
type ReadText = (path: string) => Promise<string>;

export async function loadConfig(options: ConfigOptions) {
  const env = options.environment ?? process.env;
  const readText = options.readText ?? ((file: string) => readFile(file, "utf8"));
  let config = defaultConfig();
  const warnings: string[] = [];
  for (const path of configPaths(options, env)) {
    const result = await mergeConfigFile(config, path, readText);
    config = result.config;
    warnings.push(...result.warnings);
  }
  return { config: applyEnvironment(config, env), warnings };
}

function configPaths(options: ConfigOptions, env: Environment): string[] {
  const files = [
    options.globalPath ??
      join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "reflex-state.json"),
  ];
  if (options.trusted) files.push(join(options.cwd, ".pi", "reflex-state.json"));
  return files;
}

async function mergeConfigFile(
  config: ReflexStateConfig,
  path: string,
  readText: ReadText,
): Promise<{ config: ReflexStateConfig; warnings: string[] }> {
  try {
    const raw: unknown = JSON.parse(await readText(path));
    const result = mergeConfig(config, raw);
    return {
      config: result.config,
      warnings: result.warnings.map((warning) => path + ": " + warning),
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { config, warnings: [] };
    return {
      config: defaultConfig(),
      warnings: ["Ignoring unreadable or malformed configuration: " + path],
    };
  }
}

function applyEnvironment(config: ReflexStateConfig, env: Environment): ReflexStateConfig {
  return {
    ...config,
    enabled: env.REFLEX_STATE_DISABLE === "1" ? false : config.enabled,
    jev: {
      ...config.jev,
      enabled: env.REFLEX_STATE_DISABLE_JEV === "1" ? false : config.jev.enabled,
    },
    projection: {
      ...config.projection,
      enabled: projectionEnabled(env.REFLEX_STATE_PROJECTION, config.projection.enabled),
    },
  };
}

function projectionEnabled(flag: string | undefined, fallback: boolean): boolean {
  if (flag === "1") return true;
  return flag === "0" ? false : fallback;
}
