import { defaultConfig } from "./config.js";
import { callFixture } from "./test_fixtures.js";
import {
  classifyToolCall,
  classifyVerification,
  normalizeCommand,
  verificationCheckKey,
} from "./verification.js";

test("check keys include kind, normalized cwd, and the complete command", () => {
  expect(verificationCheckKey("test", "/workspace", "pytest tests/unit")).toBe(
    verificationCheckKey("test", "/workspace", "  pytest   tests/unit  "),
  );
  expect(verificationCheckKey("test", "/workspace", "pytest tests/integration")).not.toBe(
    verificationCheckKey("test", "/workspace", "pytest tests/unit"),
  );
  expect(verificationCheckKey("test", "/other", "pytest tests/unit")).not.toBe(
    verificationCheckKey("test", "/workspace", "pytest tests/unit"),
  );
});

test.each(["pytest tests/unit", "pnpm test", "pnpm run lint", "tsc --noEmit"])(
  "classifies a single verification command as attributable: %s",
  (command) => {
    const result = classifyVerification(command, "/workspace", defaultConfig());
    expect(result).toMatchObject({ attributable: true, compound: false });
    expect(result?.checkKey).toMatch(/^check:[a-f0-9]{64}$/);
  },
);

test.each(["pytest || true", "pytest; echo done", "false && pytest", "pytest | tee out.log"])(
  "does not attribute a shell compound to one verification: %s",
  (command) => {
    expect(classifyVerification(command, "/workspace", defaultConfig())).toMatchObject({
      compound: true,
      attributable: false,
      unknownReason: "compound_command",
    });
    expect(classifyVerification(command, "/workspace", defaultConfig())?.checkKey).toBeUndefined();
  },
);

test("truncated commands are unknown even when the visible prefix matches", () => {
  const call = { ...callFixture({ command: "pytest tests/unit" }), commandTruncated: true };
  const result = classifyToolCall(call, defaultConfig());
  expect(result).toMatchObject({ attributable: false, unknownReason: "command_truncated" });
  expect(result?.checkKey).toBeUndefined();
});

test("normalization does not change quoted whitespace", () => {
  expect(normalizeCommand("echo   'a  b'   ")).toBe("echo 'a  b'");
});

test("unclosed shell syntax is unknown", () => {
  const result = classifyVerification("pytest 'unterminated", "/workspace", defaultConfig());
  expect(result).toMatchObject({ attributable: false, compound: true });
  expect(result?.checkKey).toBeUndefined();
});

test("truncation is not a classifyVerification argument", () => {
  const withTruncation = () =>
    // @ts-expect-error truncation belongs to the tool call; use classifyToolCall
    classifyVerification("pytest", "/workspace", defaultConfig(), true);
  expect(withTruncation).toBeTypeOf("function");
});
