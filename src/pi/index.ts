import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createUpdater } from "../composition.js";
import { registerExtension } from "./extension.js";

export default function reflexState(pi: ExtensionAPI): void {
  registerExtension(pi, createUpdater);
}
