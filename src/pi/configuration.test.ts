import { defaultConfig } from "../core/config.js";
import { mergeConfig } from "../core/config_validation.js";
import { loadConfig } from "./configuration.js";

test("configuration layers respect trust and environment overrides", async () => {
  const readText = vi.fn<(path: string) => Promise<string>>(async (path) =>
    path === "/global/config.json"
      ? JSON.stringify({ jev: { enabled: false }, limits: { maxWorkingSetEvents: 20 } })
      : JSON.stringify({ jev: { enabled: true }, limits: { maxWorkingSetEvents: 24 } }),
  );
  const options = {
    cwd: "/project",
    globalPath: "/global/config.json",
    readText,
    environment: { REFLEX_STATE_PROJECTION: "0" },
  };
  const untrusted = await loadConfig({ ...options, trusted: false });
  expect(readText).toHaveBeenCalledTimes(1);
  expect(untrusted.config.jev.enabled).toBe(false);
  expect(untrusted.config.limits.maxWorkingSetEvents).toBe(20);
  const trusted = await loadConfig({ ...options, trusted: true });
  expect(trusted.config.jev.enabled).toBe(true);
  expect(trusted.config.limits.maxWorkingSetEvents).toBe(24);
  expect(trusted.config.projection.enabled).toBe(false);
});

test.each([
  { thresholds: { noulReject: 0.9 } },
  { thresholds: { minChoiceConfidence: -1 } },
  { apiKey: null },
  { jev: { deadlineMs: -1 } },
  { limits: { maxWorkingSetEvents: 0 } },
  { verificationCommands: { test: ["["] } },
])("invalid configuration is rejected", (input) => {
  const result = mergeConfig(defaultConfig(), input);
  expect(result.valid).toBe(false);
  expect(result.config).toEqual(defaultConfig());
});

test("unknown keys warn while known settings are retained", () => {
  const result = mergeConfig(defaultConfig(), { unknownSetting: 1, jev: { enabled: false } });
  expect(result.valid).toBe(true);
  expect(result.warnings).toHaveLength(1);
  expect(result.config.jev.enabled).toBe(false);
});

test("projection defaults off and the legacy blocker key aliases the projection limit", () => {
  const base = defaultConfig();
  expect(base.projection).toMatchObject({ enabled: false, mode: "append" });
  const legacy = mergeConfig(base, { limits: { maxActiveBlockers: 3 } });
  expect(legacy.valid).toBe(true);
  expect(legacy.config.limits.maxProjectedBlockers).toBe(3);
  expect(legacy.config.limits.maxActiveBlockers).toBe(3);
  expect(legacy.warnings.join(" ")).toContain("deprecated");
  const both = mergeConfig(base, {
    limits: { maxActiveBlockers: 3, maxProjectedBlockers: 5 },
  });
  expect(both.config.limits.maxProjectedBlockers).toBe(5);
});
