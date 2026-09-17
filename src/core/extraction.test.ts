import { extractFacts } from "./extraction.js";
import { callFixture, contextFixture, excerptFixture, resultFixture } from "./test_fixtures.js";
import type { ToolCallEvent } from "./types.js";

test("a later successful change to a path supersedes that path's earlier evidence", () => {
  const old = { ...resultFixture({ id: "E0002", toolName: "edit" }) };
  const current = { ...resultFixture({ id: "E0004", toolName: "write", toolCallId: "call-2" }) };
  const context = contextFixture(current);
  context.evidence.set("E0001", { ...callFixture({ path: "src/main.ts" }), toolName: "edit" });
  context.evidence.set(old.id, old);
  context.evidence.set("E0003", {
    ...callFixture({ path: "src/main.ts" }),
    id: "E0003",
    toolCallId: "call-2",
    toolName: "write",
  });
  context.state = { ...context.state, workingSet: [old.id] };
  expect(extractFacts(context).supersededInWorkingSet).toEqual([old.id]);
});

test.each([
  ["pnpm test", "test", false],
  ["pytest -q", "test", false],
  ["cargo test", "test", false],
  ["tsc --noEmit", "build", false],
  ["oxlint .", "lint", false],
  ["a && pnpm test", "test", true],
  ["pnpm run lint; pnpm test", "test", true],
  ["ls", undefined, false],
  ["echo 'pnpm test'", undefined, false],
])("classifies verification commands: %s", (command, kind, compound) => {
  const facts = extractFacts(contextFixture(callFixture({ command })));
  if (!kind) {
    expect(facts.verification).toBeUndefined();
    return;
  }
  expect(facts.verification).toEqual({ kind, compound, command, status: "running" });
});

test.each([
  [false, "all passed", "passed"],
  [true, "Command exited with code 1", "failed"],
  [true, "cancelled", "unknown"],
])("joins results to the command and reports its observed outcome", (isError, text, status) => {
  const context = contextFixture(resultFixture({ isError, excerpt: excerptFixture(text) }));
  context.evidence.set("E0001", callFixture());
  expect(extractFacts(context).verification?.status).toBe(status);
});

test.each([
  [true, "failure\nCommand exited with code 2", 2],
  [false, "19 passed", undefined],
  [true, "Command exited with code 3\nnot the trailer", undefined],
  [true, "cancelled", undefined],
])("extracts only a trailing error exit code (%s, %s)", (isError, output, expected) => {
  const facts = extractFacts(
    contextFixture(resultFixture({ isError, excerpt: excerptFixture(output) })),
  );
  expect(facts.exitCode).toBe(expected);
});
test.each(["edit", "write"])("records %s paths only after a successful result", (toolName) => {
  const call: ToolCallEvent = {
    ...callFixture({ path: "/workspace/src/../src/main.ts" }),
    toolName,
  };
  expect(extractFacts(contextFixture(call)).fileChanges).toEqual([]);
  const context = contextFixture(resultFixture({ toolName }));
  context.evidence.set(call.id, call);
  expect(extractFacts(context).fileChanges).toEqual(["src/main.ts"]);
  expect(
    extractFacts({ ...context, event: resultFixture({ toolName, isError: true }) }).fileChanges,
  ).toEqual([]);
});

test("read paths are relevant files, never modified files", () => {
  const event: ToolCallEvent = { ...callFixture({ path: "./src/main.ts" }), toolName: "read" };
  const facts = extractFacts(contextFixture(event));
  expect(facts.filesRead).toEqual(["src/main.ts"]);
  expect(facts.fileChanges).toEqual([]);
  expect(facts.phaseProposal).toBe("exploring");
});
