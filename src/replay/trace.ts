import { parseEvent, parseJsonLines, parseTransition } from "../core/serialization.js";

export function parseEvents(text: string) {
  return parseJsonLines(text, parseEvent);
}
export function parseRecording(text: string) {
  return parseJsonLines(text, parseTransition);
}
