import { defaultConfig } from "./config.js";
import type { ReflexStateConfig } from "./config.js";
import { isRecord } from "./serialization.js";

class InvalidConfigError extends Error {}

export function mergeConfig(base: ReflexStateConfig, input: unknown) {
  const warnings: string[] = [];
  try {
    if (containsCredential(input))
      throw new InvalidConfigError("Credentials are not allowed in configuration files");
    const normalized = normalizeAliases(input, warnings);
    const merged = mergeValue(base, normalized, { path: "config", warnings }) as ReflexStateConfig;
    const config = {
      ...merged,
      limits: {
        ...merged.limits,
        maxActiveBlockers: merged.limits.maxProjectedBlockers,
      },
    };
    validateConfig(config);
    return { config, warnings, valid: true };
  } catch (error) {
    warnings.push(error instanceof InvalidConfigError ? error.message : "Invalid configuration");
    return { config: defaultConfig(), warnings, valid: false };
  }
}

function mergeValue(
  base: unknown,
  input: unknown,
  context: { path: string; warnings: string[] },
): unknown {
  if (input === undefined) return base;
  if (Array.isArray(base)) {
    if (!Array.isArray(input) || !input.every((value) => typeof value === "string"))
      throw new InvalidConfigError("Expected string array at " + context.path);
    return [...input];
  }
  if (!isRecord(base)) {
    if (typeof input !== typeof base)
      throw new InvalidConfigError("Invalid value type at " + context.path);
    return input;
  }
  if (!isRecord(input)) throw new InvalidConfigError("Expected object at " + context.path);
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(base, key))
      context.warnings.push("Unknown configuration key: " + context.path + "." + key.slice(0, 80));
  }
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      mergeValue(value, input[key], { path: context.path + "." + key, warnings: context.warnings }),
    ]),
  );
}

function validateConfig(config: ReflexStateConfig): void {
  for (const value of Object.values(config.thresholds)) {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new InvalidConfigError("Thresholds must be between zero and one");
  }
  if (config.thresholds.noulReject >= config.thresholds.noulAccept)
    throw new InvalidConfigError("noulReject must be below noulAccept");
  for (const [key, value] of Object.entries(config.limits)) {
    if (!Number.isSafeInteger(value) || value < (key === "maxExcerptTailChars" ? 0 : 1))
      throw new InvalidConfigError("Invalid limit: " + key);
  }
  for (const key of ["timeoutMs", "deadlineMs", "cooldownMs"] as const) {
    if (
      !Number.isSafeInteger(config.jev[key]) ||
      config.jev[key] < 1 ||
      config.jev[key] > 2_147_483_647
    )
      throw new InvalidConfigError("Invalid Jev duration: " + key);
  }
  if (!Number.isSafeInteger(config.jev.maxRetries) || config.jev.maxRetries < 0)
    throw new InvalidConfigError("Invalid retry count");
  if (!config.jev.model.trim()) throw new InvalidConfigError("Jev model must not be empty");
  if (
    !["append", "current-run"].includes(config.projection.mode) ||
    !["last-message", "run-start"].includes(config.projection.placement)
  )
    throw new InvalidConfigError("Unsupported projection configuration");
  if (config.shadowQuestions.some((question) => question !== "phase"))
    throw new InvalidConfigError("Unsupported shadow question");
  for (const expressions of Object.values(config.verificationCommands)) {
    for (const expression of expressions) {
      try {
        new RegExp(expression);
      } catch {
        throw new InvalidConfigError("Invalid verification command expression");
      }
    }
  }
}

function normalizeAliases(input: unknown, warnings: string[]): unknown {
  if (!isRecord(input) || !isRecord(input.limits)) return input;
  const limits = input.limits;
  if (!Object.hasOwn(limits, "maxActiveBlockers")) return input;
  warnings.push("limits.maxActiveBlockers is deprecated; use limits.maxProjectedBlockers");
  const nextLimits = { ...limits };
  if (!Object.hasOwn(limits, "maxProjectedBlockers"))
    nextLimits.maxProjectedBlockers = limits.maxActiveBlockers;
  delete nextLimits.maxActiveBlockers;
  return { ...input, limits: nextLimits };
}

function containsCredential(value: unknown): boolean {
  if (typeof value === "string")
    return /\bsk-[a-zA-Z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN [^-]*PRIVATE KEY|\bBearer\s+\S+/i.test(
      value,
    );
  if (Array.isArray(value)) return value.some(containsCredential);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) => /api[_-]?key/i.test(key) || containsCredential(item),
  );
}
