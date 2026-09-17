import type { ReflexStateConfig } from "./core/config.js";
import { NoopStateUpdater } from "./core/updater.js";
import type { StateUpdater } from "./core/updater.js";
import { createTypeSafeClient } from "./typesafe/client.js";
import { JevStateUpdater } from "./typesafe/updater.js";

export function createUpdater(
  config: ReflexStateConfig,
  notify?: (message: string) => void,
): StateUpdater {
  if (!config.jev.enabled) return new NoopStateUpdater();
  return new JevStateUpdater(createTypeSafeClient(config), notify ? { notify } : {});
}
