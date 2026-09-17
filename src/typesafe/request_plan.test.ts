import { extractFacts } from "../core/extraction.js";
import { contextFixture, resultFixture } from "../core/test_fixtures.js";
import type { EventId } from "../core/types.js";
import { buildInput } from "./input.js";
import { buildQuestions } from "./questions.js";
import { buildRequestPlan } from "./request_plan.js";

test("a blocker resolution question is skipped when its required evidence is unavailable", () => {
  const event = resultFixture();
  const context = contextFixture(event);
  context.state = {
    ...context.state,
    activeBlockers: [{ eventId: "E0099", origin: "tool_error", category: "network" }],
  };
  const plan = buildRequestPlan({ ...context, facts: extractFacts(context) });
  expect(plan.items).toEqual([]);
  expect(plan.skipped).toContainEqual({ id: "resolves_E0099", reason: "evidence_unavailable" });
  expect(buildQuestions({ ...context, facts: extractFacts(context) })).toEqual({});
});

test("questions and input use one evidence plan and keep within the byte budget", () => {
  const event = resultFixture({ isError: true });
  const context = contextFixture(event);
  const ids = Array.from({ length: 9 }, (_, index) => ("E" + index) as EventId);
  context.state = {
    ...context.state,
    workingSet: ids,
    activeBlockers: ids.map((eventId) => ({ eventId, origin: "tool_error", category: "unknown" })),
  };
  for (const id of ids)
    context.evidence.set(
      id,
      resultFixture({ id, excerpt: { ...event.excerpt, head: "x".repeat(8000) } }),
    );
  const facts = extractFacts(context);
  const plan = buildRequestPlan({ ...context, facts });
  const questions = buildQuestions({ ...context, facts });
  const input = JSON.parse(buildInput({ ...context, facts })) as {
    request_plan: { questions: { id: string }[] };
  };
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(24_000);
  expect(Object.keys(questions).sort()).toEqual(
    input.request_plan.questions.map((item) => item.id).sort(),
  );
  expect(plan.items.map((item) => item.id)).toEqual(
    input.request_plan.questions.map((item) => item.id),
  );
});

test("the plan drops whole question-evidence pairs that cannot fit the byte budget", () => {
  const event = resultFixture({ isError: true });
  const context = contextFixture(event);
  const ids = Array.from({ length: 16 }, (_, index) => ("E" + index) as EventId);
  context.state = { ...context.state, workingSet: ids };
  for (const id of ids)
    context.evidence.set(
      id,
      resultFixture({ id, excerpt: { ...event.excerpt, head: "x".repeat(8000) } }),
    );
  const plan = buildRequestPlan({ ...context, facts: extractFacts(context) });
  expect(plan.skipped.some((item) => item.reason === "input_budget")).toBe(true);
  expect(plan.items.every((item) => item.requiredEvidence.length > 0)).toBe(true);
});
