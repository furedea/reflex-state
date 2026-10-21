import { callFixture } from "./core/test_fixtures.js";
import { classifyToolCall, classifyVerification, defaultConfig } from "./index.js";

test("the package entry exposes classifyToolCall as the way to classify truncated commands", () => {
  const call = { ...callFixture({ command: "pytest tests/unit" }), commandTruncated: true };
  expect(classifyToolCall(call, defaultConfig())).toMatchObject({
    attributable: false,
    unknownReason: "command_truncated",
  });
  expect(classifyVerification("pytest tests/unit", "/workspace", defaultConfig())).toMatchObject({
    attributable: true,
  });
});
