import { defaultConfig } from "./config.js";
import { classifyVerification, normalizeCommand, verificationCheckKey } from "./verification.js";

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
    const result = classifyVerification({ command, cwd: "/workspace" }, defaultConfig());
    expect(result).toMatchObject({ attributable: true, compound: false });
    expect(result?.checkKey).toMatch(/^check:[a-f0-9]{64}$/);
  },
);

test.each(["pytest || true", "pytest; echo done", "false && pytest", "pytest | tee out.log"])(
  "does not attribute a shell compound to one verification: %s",
  (command) => {
    expect(classifyVerification({ command, cwd: "/workspace" }, defaultConfig())).toMatchObject({
      compound: true,
      attributable: false,
      unknownReason: "compound_command",
    });
    expect(
      classifyVerification({ command, cwd: "/workspace" }, defaultConfig())?.checkKey,
    ).toBeUndefined();
  },
);

test("truncated commands are unknown even when the visible prefix matches", () => {
  expect(
    classifyVerification(
      { command: "pytest tests/unit", cwd: "/workspace", truncated: true },
      defaultConfig(),
    ),
  ).toMatchObject({
    attributable: false,
    unknownReason: "command_truncated",
  });
});

test("normalization does not change quoted whitespace", () => {
  expect(normalizeCommand("echo   'a  b'   ")).toBe("echo 'a  b'");
});

test("unclosed shell syntax is unknown", () => {
  const result = classifyVerification(
    { command: "pytest 'unterminated", cwd: "/workspace" },
    defaultConfig(),
  );
  expect(result).toMatchObject({ attributable: false, compound: true });
  expect(result?.checkKey).toBeUndefined();
});
