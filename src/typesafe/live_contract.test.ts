import { defaultConfig } from "../core/config.js";
import { isRecord } from "../core/serialization.js";
import { createTypeSafeClient } from "./client.js";

test.skipIf(process.env.REFLEX_STATE_LIVE_JEV !== "1")(
  "live System One returns a Choice, a Noul, and measured input usage",
  async () => {
    const response = await createTypeSafeClient(defaultConfig()).systemOne(
      {
        model: "jev-latest",
        state: "A local unit test ran and exited with status 0. All assertions passed.",
        questions: {
          outcome: {
            type: "choice",
            instructions: "Classify the observed test result.",
            criteria: { passed: "All assertions passed.", failed: "An assertion failed." },
          },
          succeeded: { type: "noul", instructions: "Did the test succeed?" },
        },
      },
      { signal: AbortSignal.timeout(4000) },
    );
    expect(response).toMatchObject({
      answers: {
        outcome: {
          choice: expect.any(String),
          confidence: expect.any(Number),
          probabilities: { passed: expect.any(Number), failed: expect.any(Number) },
        },
        succeeded: { noul: expect.any(Number) },
      },
      usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number) },
    });
    if (!isRecord(response) || !isRecord(response.usage)) throw new Error("Missing usage");
    expect(response.usage.input_tokens).toBeGreaterThan(0);
  },
  10_000,
);
