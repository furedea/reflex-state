import { describe, expect, it } from "vitest";

import { decodeActorResponse, decodeOperationsArray } from "./providers_decode.js";

const operation = {
  operation: "add",
  kind: "findings",
  text: "a",
  sourceIds: ["s"],
  origin: "extracted",
};

describe("decodeActorResponse actions", () => {
  it("decodes each action form with its required fields only", () => {
    expect(
      decodeActorResponse('{"action":{"tool":"edit","path":"p","old":"a","new":"b"}}', "history"),
    ).toMatchObject({
      action: { tool: "edit", path: "p", old: "a", new: "b" },
      actionForm: "canonical",
    });
    expect(decodeActorResponse('{"action":"test","command":"c"}', "history")).toMatchObject({
      action: { tool: "test", command: "c" },
      actionForm: "shorthand",
    });
    expect(
      decodeActorResponse('{"tool":"write","path":"p","content":"x"}', "history"),
    ).toMatchObject({ action: { tool: "write", path: "p", content: "x" }, actionForm: "bare" });
  });

  it("rejects missing required fields and unknown fields", () => {
    for (const body of [
      '{"action":{"tool":"read"}}',
      '{"action":{"tool":"write","path":"p"}}',
      '{"action":{"tool":"edit","path":"p","old":"a"}}',
      '{"action":{"tool":"test"}}',
      '{"action":{"tool":"finish","extra":1}}',
      '{"action":[]}',
    ])
      expect(() => decodeActorResponse(body, "history")).toThrow("actor_action_invalid");
  });
});

describe("decodeOperationsArray", () => {
  it("defaults trust and keeps optional ids", () => {
    expect(decodeOperationsArray([{ ...operation, itemId: "i", replaces: "r" }])).toEqual([
      { ...operation, itemId: "i", replaces: "r", trust: "unknown" },
    ]);
  });

  it("reports the first failing field in a fixed order", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...operation, operation: "x" }, "operations[0].operation_invalid"],
      [{ ...operation, kind: "nope" }, "operations[0].kind_invalid"],
      [{ ...operation, text: " " }, "operations[0].text_invalid"],
      [{ ...operation, sourceIds: [] }, "operations[0].sourceIds_invalid"],
      [{ ...operation, sourceIds: [" "] }, "operations[0].sourceIds_invalid"],
      [{ ...operation, origin: "x" }, "operations[0].origin_invalid"],
      [{ ...operation, trust: "x" }, "operations[0].trust_invalid"],
      [{ ...operation, extra: 1 }, "operations[0].unknown_field:extra"],
    ];
    for (const [value, message] of cases)
      expect(() => decodeOperationsArray([value])).toThrow(message);
    expect(() => decodeOperationsArray([null])).toThrow("operations[0]_invalid");
    expect(() => decodeOperationsArray({})).toThrow("operations_not_array");
  });
});
