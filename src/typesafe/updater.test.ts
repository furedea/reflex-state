import {
  AuthenticationError,
  RateLimitError,
  APITimeoutError,
  APIConnectionError,
  BadRequestError,
  UnprocessableEntityError,
  InternalServerError,
  TypeSafeError,
} from "@typesafe-ai/sdk";

import { defaultConfig } from "../core/config.js";
import { StateEngine } from "../core/engine.js";
import { extractFacts } from "../core/extraction.js";
import { callFixture, excerptFixture } from "../core/test_fixtures.js";
import { contextFixture, resultFixture } from "../core/test_fixtures.js";
import type { StateTransitionRecord, SemanticDecisions } from "../core/types.js";
import type { TypeSafeSystemOneClient } from "./client.js";
import { JevStateUpdater } from "./updater.js";

test("the outer deadline aborts a stuck request and still reduces the event", async () => {
  vi.useFakeTimers();
  try {
    let receivedSignal: AbortSignal | undefined;
    const client: TypeSafeSystemOneClient = {
      systemOne(_request, { signal }) {
        receivedSignal = signal;
        return new Promise(() => {});
      },
    };
    const engine = new StateEngine({
      cwd: "/workspace",
      config: defaultConfig(),
      updater: new JevStateUpdater(client),
    });
    await engine.process(callFixture());
    const completed = vi.fn<(record: StateTransitionRecord) => void>();
    const pending = engine
      .process(
        resultFixture({ isError: true, excerpt: excerptFixture("Command exited with code 1") }),
      )
      .then(completed);
    await vi.advanceTimersByTimeAsync(4000);
    expect(completed).toHaveBeenCalledOnce();
    expect(receivedSignal?.aborted).toBe(true);
    expect(engine.state.verification.test.status).toBe("failed");
    expect(completed.mock.calls[0]?.[0].decisions.telemetry.error).toBe("timeout");
    await pending;
  } finally {
    vi.useRealTimers();
  }
});

test("a user abort cancels Jev without opening the outage circuit", async () => {
  vi.useFakeTimers();
  try {
    const updater = new JevStateUpdater({ systemOne: () => new Promise(() => {}) });
    const context = contextFixture(resultFixture({ isError: true }));
    const controller = new AbortController();
    const completed = vi.fn<(decisions: SemanticDecisions) => void>();
    const pending = updater
      .evaluate({ ...context, facts: extractFacts(context) }, controller.signal)
      .then(completed);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0]?.[0].telemetry.error).toBe("aborted");
    expect(updater.health.status).toBe("ok");
    await pending;
  } finally {
    vi.useRealTimers();
  }
});

function responseFixture() {
  return {
    model: "fixture",
    usage: { input_tokens: 123, output_tokens: 7 },
    answers: {
      blocker_introduced: { noul: 0.95 },
      failure_category: {
        choice: "network",
        confidence: 0.9,
        probabilities: {
          implementation: 0,
          environment: 0,
          dependency: 0,
          test: 0,
          permissions: 0,
          network: 0.95,
          unknown: 0.05,
        },
      },
      phase_shadow: {
        choice: "debugging",
        confidence: 0.9,
        probabilities: {
          planning: 0,
          exploring: 0,
          editing: 0,
          testing: 0,
          debugging: 0.95,
          done: 0,
          unknown: 0.05,
        },
      },
    },
  };
}

test("an already cancelled event records no Jev calls or latency", async () => {
  const client = { systemOne: vi.fn<TypeSafeSystemOneClient["systemOne"]>() };
  const updater = new JevStateUpdater(client);
  const context = contextFixture(resultFixture({ isError: true }));
  const result = await updater.evaluate(
    { ...context, facts: extractFacts(context) },
    AbortSignal.abort(),
  );
  expect(client.systemOne).not.toHaveBeenCalled();
  expect(result.telemetry).toMatchObject({ error: "aborted", questionsAsked: 0, questionIds: [] });
  expect(result.telemetry.latencyMs).toBeUndefined();
});

test.each([
  [new AuthenticationError(401, {}, new Headers()), "auth_error"],
  [new RateLimitError(429, {}, new Headers()), "rate_limit"],
  [new APITimeoutError(3000), "timeout"],
  [new APIConnectionError(), "connection_error"],
  [new BadRequestError(400, {}, new Headers()), "bad_request"],
  [new UnprocessableEntityError(422, {}, new Headers()), "unprocessable"],
  [new InternalServerError(500, {}, new Headers()), "server_error"],
  [new TypeSafeError("SDK failure"), "sdk_error"],
])("Jev failure still applies deterministic verification facts: %s", async (error, kind) => {
  const updater = new JevStateUpdater({
    systemOne: vi.fn<TypeSafeSystemOneClient["systemOne"]>().mockRejectedValue(error),
  });
  const engine = new StateEngine({ cwd: "/workspace", config: defaultConfig(), updater });
  await engine.process(callFixture());
  const record = await engine.process(
    resultFixture({ isError: true, excerpt: excerptFixture("Command exited with code 1") }),
  );
  expect(record.after.verification.test.status).toBe("failed");
  expect(record.after.activeBlockers[0]?.category).toBe("unknown");
  expect(record.decisions.telemetry.error).toBe(kind);
});

test("three failures open the circuit; a successful cooldown probe closes it", async () => {
  vi.useFakeTimers();
  try {
    const client = {
      systemOne: vi
        .fn<TypeSafeSystemOneClient["systemOne"]>()
        .mockRejectedValue(new APIConnectionError()),
    };
    const updater = new JevStateUpdater(client);
    const context = contextFixture(resultFixture({ isError: true }));
    const input = { ...context, facts: extractFacts(context) };
    for (let index = 0; index < 4; index++) await updater.evaluate(input);
    expect(client.systemOne).toHaveBeenCalledTimes(3);
    expect(updater.health.circuit).toBe("open");
    client.systemOne.mockResolvedValue(responseFixture());
    await vi.advanceTimersByTimeAsync(60_000);
    await updater.evaluate(input);
    expect(updater.health.circuit).toBe("closed");
  } finally {
    vi.useRealTimers();
  }
});

test("authentication disables the session once and malformed answers fail open", async () => {
  const notify = vi.fn<(message: string) => void>();
  const client = {
    systemOne: vi
      .fn<TypeSafeSystemOneClient["systemOne"]>()
      .mockRejectedValue(new AuthenticationError(401, {}, new Headers())),
  };
  const updater = new JevStateUpdater(client, { notify });
  const context = contextFixture(resultFixture({ isError: true }));
  const input = { ...context, facts: extractFacts(context) };
  await updater.evaluate(input);
  await updater.evaluate(input);
  expect(client.systemOne).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledOnce();
  expect(updater.health.status).toBe("disabled");
  const invalid = await new JevStateUpdater({ systemOne: async () => ({ answers: {} }) }).evaluate(
    input,
  );
  expect(invalid.telemetry.error).toBe("invalid_response");
  expect(invalid.blockerIntroduced?.gate).toBe("error");
});

test("one System One response becomes gated decisions with measured usage", async () => {
  const client = {
    systemOne: vi.fn<TypeSafeSystemOneClient["systemOne"]>().mockResolvedValue(responseFixture()),
  };
  const context = contextFixture(resultFixture({ isError: true }));
  const decisions = await new JevStateUpdater(client).evaluate({
    ...context,
    facts: extractFacts(context),
  });
  expect(client.systemOne).toHaveBeenCalledOnce();
  expect(decisions.blockerIntroduced).toMatchObject({
    gate: "applied",
    value: true,
    probability: 0.95,
  });
  expect(decisions.failureCategory).toMatchObject({ value: "network", confidence: 0.9 });
  expect(decisions.phaseShadow).toMatchObject({ value: "debugging", shadow: true });
  expect(decisions.telemetry).toMatchObject({
    inputTokens: 123,
    outputTokens: 7,
    questionsAsked: 3,
  });
  expect(decisions.telemetry.latencyMs).toBeGreaterThanOrEqual(0);
});

test("invalid responses retain only field types for debugging", async () => {
  const context = contextFixture(resultFixture({ isError: true }));
  const result = await new JevStateUpdater({
    systemOne: async () => ({
      answers: { blocker_introduced: { noul: "private response content" } },
      unexpected: "private response content",
    }),
  }).evaluate({ ...context, facts: extractFacts(context) });
  expect(result.telemetry).toMatchObject({
    error: "invalid_response",
    responseShape: { "answers.blocker_introduced.noul": "string" },
  });
  expect(JSON.stringify(result)).not.toContain("private response content");
});
