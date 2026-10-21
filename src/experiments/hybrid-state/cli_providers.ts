import type { CliOptions } from "./cli_options.js";
import {
  createLiveProviders,
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  FakeUpdateProvider,
  readRecordedProviders,
  type ProviderSet,
} from "./providers.js";
import type { HybridConfig, HybridTask } from "./types.js";

interface ProviderNeeds {
  readonly actor: boolean;
  readonly jev: boolean;
  readonly repair: boolean;
  readonly update: boolean;
}

export async function providerSet(
  config: HybridConfig,
  values: CliOptions,
  tasks: readonly HybridTask[] = [],
): Promise<ProviderSet> {
  if (config.provider.mode === "fake") return fakeProviders(config, tasks);
  if (config.provider.mode === "recorded") {
    if (typeof values.recorded !== "string")
      throw new Error("Recorded provider requires --recorded <file>");
    return readRecordedProviders(values.recorded);
  }
  return liveProviders(config);
}

function providerNeeds(config: HybridConfig): ProviderNeeds {
  return {
    actor: config.evaluation === "closed_loop",
    jev: config.modes.includes("jev"),
    repair: config.modes.some((mode) => mode === "rules" || mode === "jev"),
    update: config.evaluation === "trace_audit" && config.modes.includes("llm"),
  };
}

function fakeProviders(config: HybridConfig, tasks: readonly HybridTask[]): ProviderSet {
  const needs = providerNeeds(config);
  return {
    ...(needs.jev ? { jev: new FakeJevProvider() } : {}),
    ...(needs.repair ? { repair: new FakeRepairProvider() } : {}),
    ...(needs.actor ? { actor: new FakeActorProvider(tasks) } : {}),
    ...(needs.update ? { update: new FakeUpdateProvider() } : {}),
  };
}

async function liveProviders(config: HybridConfig): Promise<ProviderSet> {
  const needs = providerNeeds(config);
  const providers = await createLiveProviders({
    ...(config.provider.actorModel ? { actorModel: config.provider.actorModel } : {}),
    ...(config.provider.jevModel ? { jevModel: config.provider.jevModel } : {}),
    ...(config.provider.repairModel ? { repairModel: config.provider.repairModel } : {}),
    ...(config.provider.updateModel ? { updateModel: config.provider.updateModel } : {}),
    needs,
  });
  const missing = (Object.keys(needs) as (keyof ProviderNeeds)[]).filter(
    (key) => needs[key] && !providers[key],
  );
  if (missing.length)
    throw new Error(`Live configuration is missing providers for: ${missing.join(", ")}`);
  return providers;
}
