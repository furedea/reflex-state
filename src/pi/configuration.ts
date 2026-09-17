import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../core/config.js";
import { mergeConfig } from "../core/config_validation.js";
import { isRecord } from "../core/serialization.js";

interface ConfigOptions {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly globalPath?: string;
  readonly readText?: (path: string) => Promise<string>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export async function loadConfig(options: ConfigOptions) {
  const env = options.environment ?? process.env;
  let config = defaultConfig();
  const warnings: string[] = [];
  const files = [
    options.globalPath ??
      join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "reflex-state.json"),
  ];
  if (options.trusted) files.push(join(options.cwd, ".pi", "reflex-state.json"));
  for (const path of files) {
    try {
      const raw: unknown = JSON.parse(
        await (options.readText ?? ((file) => readFile(file, "utf8")))(path),
      );
      const result = mergeConfig(config, raw);
      config = result.config;
      warnings.push(...result.warnings.map((warning) => path + ": " + warning));
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      config = defaultConfig();
      warnings.push("Ignoring unreadable or malformed configuration: " + path);
    }
  }
  config = {
    ...config,
    enabled: env.REFLEX_STATE_DISABLE === "1" ? false : config.enabled,
    jev: {
      ...config.jev,
      enabled: env.REFLEX_STATE_DISABLE_JEV === "1" ? false : config.jev.enabled,
    },
    projection: {
      ...config.projection,
      enabled: env.REFLEX_STATE_PROJECTION === "0" ? false : config.projection.enabled,
    },
  };
  return { config, warnings };
}
