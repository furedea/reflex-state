import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../core/config.js";
import { initialState } from "../core/reducer.js";
import { callFixture } from "../core/test_fixtures.js";
import type { AgentEvent, EventId } from "../core/types.js";
import { projectContext } from "./projection.js";

type Message = ContextEvent["messages"][number];
function user(text: string): Message {
  return { role: "user", content: text, timestamp: 1 };
}
function assistant(ids: string[], stopReason: "stop" | "toolUse" | "aborted" = "toolUse"): Message {
  return {
    role: "assistant",
    content: ids.map((id) => ({
      type: "toolCall",
      id,
      name: "bash",
      arguments: { command: "pnpm test" },
    })),
    api: "openai-completions",
    provider: "openai",
    model: "fixture",
    timestamp: 1,
    stopReason,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function result(id: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: "passed" }],
    isError: false,
    timestamp: 1,
  };
}
const context = () => ({ state: initialState(), evidence: new Map(), config: defaultConfig() });

test("projection preserves full context when compaction removed the latest recorded goal", () => {
  const prompt: AgentEvent = { ...callFixture(), type: "user_prompt", text: "latest goal" };
  const input = {
    ...context(),
    state: { ...initialState(), goal: prompt.id },
    evidence: new Map<EventId, AgentEvent>([[prompt.id, prompt]]),
  };
  const messages = [user("older retained prompt")];
  expect(projectContext(messages, input).messages).toBe(messages);
  expect(projectContext(messages, input).measurement.fallback).toBe("missing_user_prompt");
  expect(projectContext([user(prompt.text)], input).measurement.fallback).toBeUndefined();
});

test("projection retains the complete current run including multi-tool groups and steers", () => {
  const previous = [user("old task"), assistant(["old"]), result("old"), assistant([], "stop")];
  const run = [
    user("current task"),
    assistant(["a", "b"]),
    result("a"),
    result("b"),
    user("steer"),
    assistant(["c"]),
    result("c"),
  ];
  const messages = [...previous, ...run];
  const before = JSON.stringify(messages);
  const projected = projectContext(messages, context());
  expect(projected.messages.slice(0, -1)).toEqual(run.slice(0, -1));
  expect(projected.messages.at(-1)).toMatchObject({
    role: "toolResult",
    toolCallId: "c",
    content: [
      { type: "text", text: "passed" },
      { type: "text", text: expect.stringContaining("<reflex-state>") },
    ],
  });
  expect(projected.measurement.messagesAfter).toBe(run.length);
  expect(JSON.stringify(messages)).toBe(before);
});

test.each(["stop", "aborted"] as const)("a %s run ends before the next user prompt", (reason) => {
  const projected = projectContext([user("old"), assistant([], reason), user("new")], context());
  expect(projected.messages).toHaveLength(1);
  expect(projected.messages[0]).toMatchObject({
    role: "user",
    content: [
      { type: "text", text: "new" },
      { type: "text", text: expect.any(String) },
    ],
  });
});

test("disabled, compacting, and incomplete exchanges preserve the original context", () => {
  const messages = [user("keep"), assistant(["a", "b"]), result("a")];
  expect(projectContext(messages, context()).messages).toBe(messages);
  const valid = [user("keep")];
  const input = context();
  input.config = { ...input.config, projection: { ...input.config.projection, enabled: false } };
  expect(projectContext(valid, input).messages).toBe(valid);
  expect(projectContext(valid, { ...context(), compacting: true }).messages).toBe(valid);
  expect(projectContext([result("orphan")], context()).measurement.fallback).toBeDefined();
});

test("opaque messages remain in place and run-start placement preserves the latest tool output", () => {
  const messages: Message[] = [
    user("goal"),
    { role: "compactionSummary", summary: "prior summary", tokensBefore: 10, timestamp: 1 },
    assistant(["a"]),
    result("a"),
  ];
  const input = context();
  input.config = {
    ...input.config,
    projection: { ...input.config.projection, placement: "run-start" },
  };
  const projected = projectContext(messages, input);
  expect(projected.messages.slice(1)).toEqual(messages.slice(1));
  expect(projected.messages[0]).toMatchObject({
    content: [{ text: "goal" }, { text: expect.stringContaining("<reflex-state>") }],
  });
});
