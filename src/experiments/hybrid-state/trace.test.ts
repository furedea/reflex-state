import { describe, expect, it } from "vitest";

import { generateCandidates, parseTraceEntries } from "./trace.js";

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
});
