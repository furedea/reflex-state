import { defaultConfig } from "../core/config.js";
import { PiEventNormalizer } from "./normalization.js";

test("Pi results retain stable joins and bounded text while ignoring images", () => {
  const normalizer = new PiEventNormalizer({
    eventCount: 41,
    turnIndex: 2,
    config: defaultConfig(),
    now: () => 1000,
  });
  const call = normalizer.call({
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command: "pnpm test" },
  });
  const result = normalizer.result({
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command: "pnpm test" },
    content: [
      { type: "text", text: "a".repeat(4000) },
      { type: "image", data: "not-text", mimeType: "image/png" },
    ],
    details: undefined,
    isError: true,
  });
  expect(call.id).toBe("E0042");
  expect(result.id).toBe("E0043");
  expect(result.source.toolCallId).toBe(call.toolCallId);
  expect(result.excerpt).toMatchObject({
    head: "a".repeat(1200),
    tail: "a".repeat(600),
    totalChars: 4000,
    truncated: true,
  });
  expect(result.excerpt.sha256).toHaveLength(64);
  expect(result.timestamp).toBe("1970-01-01T00:00:01.000Z");
});

test("each delivered user message advances the goal turn and preserves bounded verbatim text", () => {
  const normalizer = new PiEventNormalizer({
    eventCount: 0,
    turnIndex: 0,
    config: defaultConfig(),
    now: () => 1000,
  });
  expect(normalizer.prompt("original goal").turnIndex).toBe(1);
  expect(normalizer.prompt("steering instruction")).toMatchObject({
    type: "user_prompt",
    text: "steering instruction",
    turnIndex: 2,
  });
  expect(normalizer.prompt("z".repeat(5000)).text.length).toBeLessThanOrEqual(2000);
});
