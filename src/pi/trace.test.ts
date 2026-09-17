import { defaultConfig } from "../core/config.js";
import { exportSession } from "./trace.js";

test("cold-session export follows the selected branch and derives raw events without changing entries", () => {
  const entries = [
    { type: "session", cwd: "/project" },
    {
      type: "message",
      id: "u",
      parentId: null,
      message: { role: "user", content: "Fix tests", timestamp: 1 },
    },
    {
      type: "message",
      id: "a",
      parentId: "u",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call", name: "bash", arguments: { command: "pnpm test" } },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "r",
      parentId: "a",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        content: [{ type: "text", text: "passed" }],
        isError: false,
        timestamp: 3,
      },
    },
    {
      type: "message",
      id: "end",
      parentId: "r",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        stopReason: "stop",
        timestamp: 4,
      },
    },
    {
      type: "message",
      id: "other",
      parentId: "u",
      message: { role: "user", content: "Different branch", timestamp: 5 },
    },
  ];
  const before = JSON.stringify(entries);
  const result = exportSession(entries, { leaf: "end", config: defaultConfig() });
  expect(result.events.map((event) => event.type)).toEqual([
    "user_prompt",
    "tool_call",
    "tool_result",
    "agent_end",
  ]);
  expect(result.cwd).toBe("/project");
  expect(result.events[2]).toMatchObject({ toolCallId: "call", isError: false });
  expect(
    exportSession(entries, { config: defaultConfig() }).events.map((event) => event.type),
  ).toEqual(["user_prompt", "user_prompt"]);
  expect(JSON.stringify(entries)).toBe(before);
});
