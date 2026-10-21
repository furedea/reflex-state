import type { ActorAction } from "./types.js";

export function actionInput(action: ActorAction): Record<string, unknown> {
  return { ...action };
}

export function operationKey(action: ActorAction): string {
  return JSON.stringify(actionInput(action));
}
