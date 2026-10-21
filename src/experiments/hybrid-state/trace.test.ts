import { describe, expect, it } from "vitest";

import { candidateId, generateCandidates, parseTraceEntries } from "./trace.js";

describe("hybrid trace", () => {
  it("keeps visible text and ignores private thinking blocks", () => {
    const trace = parseTraceEntries(
      [
        { id: "root", type: "session" },
        {
          id: "u",
          parentId: "root",
          type: "message",
          message: { role: "user", content: "keep API" },
        },
        {
          id: "a",
          parentId: "u",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden conclusion" },
              { type: "text", text: "visible proposal" },
            ],
          },
        },
      ],
      { synthetic: true },
    );
    expect(trace.messages.map((message) => message.text)).toEqual(["keep API", "visible proposal"]);
    expect(trace.messages.map((message) => message.text).join(" ")).not.toContain(
      "hidden conclusion",
    );
  });

  it("uses UTF-16 offsets that reproduce each candidate source slice", () => {
    const trace = parseTraceEntries(
      [
        { id: "root", type: "session" },
        {
          id: "u",
          parentId: "root",
          type: "message",
          message: { role: "user", content: "制約\nsecond" },
        },
      ],
      { synthetic: true },
    );
    const candidate = generateCandidates(trace.messages)[0];
    expect(candidate).toBeDefined();
    expect(trace.messages[0]?.text.slice(candidate?.start, candidate?.end)).toBe(candidate?.text);
  });

  it("requires the explicit leaf branch when a session has multiple leaves", () => {
    const entries = [
      { id: "root", type: "session" },
      { id: "u", parentId: "root", type: "message", message: { role: "user", content: "base" } },
      { id: "left", parentId: "u", type: "message", message: { role: "user", content: "left" } },
      { id: "right", parentId: "u", type: "message", message: { role: "user", content: "right" } },
    ];
    expect(
      parseTraceEntries(entries, { synthetic: true, leaf: "left" }).messages.at(-1)?.text,
    ).toBe("left");
    expect(
      parseTraceEntries(entries, { synthetic: true, leaf: "right" }).messages.at(-1)?.text,
    ).toBe("right");
  });

  it("accepts event-only input without pretending missing assistant text was recovered", () => {
    const trace = parseTraceEntries([
      { id: "E1", type: "user_prompt", text: "run tests" },
      {
        id: "E2",
        type: "tool_call",
        toolCallId: "call",
        toolName: "bash",
        input: { command: "pnpm test" },
      },
      {
        id: "E3",
        type: "tool_result",
        toolCallId: "call",
        toolName: "bash",
        isError: false,
        excerpt: { head: "passed", truncated: false },
      },
    ]);
    expect(trace.format).toBe("event-only");
    expect(trace.messages.map((message) => message.role)).toEqual([
      "user",
      "tool_call",
      "tool_result",
    ]);
    expect(trace.missingText).toEqual([]);
  });

  it("parses pi tool calls and results with their identifiers", () => {
    const trace = parseTraceEntries([
      {
        id: "a",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "plan" },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } },
            { type: "toolCall", arguments: "bad" },
          ],
        },
      },
      {
        id: "r",
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: "c1",
          isError: true,
          content: [{ type: "text", text: "boom" }],
        },
      },
    ]);
    expect(trace.messages).toEqual([
      {
        id: "a:text:0",
        role: "assistant",
        text: "plan",
        sequence: 0,
        sourceId: "a",
        truncated: false,
      },
      {
        id: "a:call:1",
        role: "tool_call",
        text: '{"path":"x"}',
        sequence: 1,
        sourceId: "a",
        toolName: "read",
        toolCallId: "c1",
        truncated: false,
      },
      {
        id: "a:call:2",
        role: "tool_call",
        text: "{}",
        sequence: 2,
        sourceId: "a",
        truncated: false,
      },
      {
        id: "r:result",
        role: "tool_result",
        text: "boom",
        sequence: 3,
        sourceId: "r",
        toolName: "read",
        toolCallId: "c1",
        isError: true,
        truncated: false,
      },
    ]);
  });

  it("parses agent_end final text and records entries without text", () => {
    const trace = parseTraceEntries([
      { id: "e1", type: "agent_end", finalText: { head: "done", truncated: true } },
      { id: "e2", type: "agent_end", finalText: { head: "" } },
      { id: "e3", type: "tool_result", excerpt: { truncated: true } },
    ]);
    expect(trace.messages.map((message) => [message.id, message.text, message.truncated])).toEqual([
      ["e1:text", "done", true],
      ["e3:result", "", true],
    ]);
    expect(trace.missingText).toEqual(["e2"]);
  });

  it("derives a candidate id from its message and the text between start and end", () => {
    const trace = parseTraceEntries([
      { id: "u", type: "message", message: { role: "user", content: "first unit\n\nsecond unit" } },
    ]);
    const message = trace.messages[0]!;
    const [first, second] = generateCandidates(trace.messages);
    expect(first!.id).toBe(candidateId(message, first!.start, first!.end));
    expect(second!.id).toBe(candidateId(message, second!.start, second!.end));
    expect(first!.id).not.toBe(second!.id);
  });
});
