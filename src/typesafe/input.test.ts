import { generateKeyPairSync } from "node:crypto";

import { extractFacts } from "../core/extraction.js";
import {
  callFixture,
  contextFixture,
  excerptFixture,
  resultFixture,
} from "../core/test_fixtures.js";
import { buildInput, redact } from "./input.js";

test("outbound input redacts secret shapes and excludes read outputs", () => {
  const secrets = "sk-test_123456789012345\nBearer token-secret\nAPI_KEY=local-secret";
  const context = contextFixture(
    resultFixture({ isError: true, excerpt: excerptFixture(secrets) }),
  );
  context.evidence.set("E0008", {
    ...resultFixture({ toolName: "read", excerpt: excerptFixture("DO NOT SEND THIS FILE") }),
    id: "E0008",
  });
  context.evidence.set("E0009", {
    ...callFixture(),
    id: "E0009",
    type: "user_prompt",
    text: "Fix this\nAPI_KEY=goal-secret",
  });
  context.state = { ...context.state, goal: "E0009", workingSet: ["E0008"] };
  const input = buildInput({ ...context, facts: extractFacts(context) });
  for (const secret of [
    "sk-test_",
    "token-secret",
    "local-secret",
    "goal-secret",
    "DO NOT SEND THIS FILE",
  ])
    expect(input).not.toContain(secret);
  expect(input).toContain("[REDACTED]");
  expect(redact("Bearer token-secret")).toBe("Bearer [REDACTED]");
});

test("ephemeral key material is redacted without storing credentials in fixtures", () => {
  const pem = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  expect(redact(pem) === "[REDACTED]").toBe(true);
  const syntheticAccessKeyId = "AKIA".padEnd(20, "0");
  expect(redact(syntheticAccessKeyId) === "[REDACTED]").toBe(true);
});

test("outbound input has a fixed byte budget even for large excerpts", () => {
  const context = contextFixture(
    resultFixture({ isError: true, excerpt: excerptFixture("大".repeat(100_000)) }),
  );
  const input = buildInput({ ...context, facts: extractFacts(context) });
  expect(Buffer.byteLength(input)).toBeLessThanOrEqual(24_000);
  expect(JSON.parse(input).latest_event.id).toBe("E0002");
});
