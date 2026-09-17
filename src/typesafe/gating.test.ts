import { defaultConfig } from "../core/config.js";
import { gateChoice, gateNoul } from "./gating.js";

test.each([
  [0.85, true, "applied"],
  [0.1, false, "applied"],
  [0.5, null, "uncertain"],
  [0.8, true, "applied"],
  [0.2, false, "applied"],
])("gates Noul at the specified inclusive thresholds: %s", (probability, value, gate) => {
  expect(gateNoul({ noul: probability }, defaultConfig().thresholds)).toMatchObject({
    value,
    gate,
    probability,
  });
});

test("choice confidence and optional margin both have to pass", () => {
  const answer = {
    choice: "network",
    confidence: 0.5,
    probabilities: { network: 0.7, unknown: 0.3 },
  };
  const thresholds = defaultConfig().thresholds;
  expect(gateChoice(answer, ["network", "unknown"], thresholds).gate).toBe("uncertain");
  expect(gateChoice({ ...answer, confidence: 0.9 }, ["network", "unknown"], thresholds).value).toBe(
    "network",
  );
  expect(
    gateChoice({ ...answer, confidence: 0.9 }, ["network", "unknown"], {
      ...thresholds,
      minChoiceMargin: 0.5,
    }).gate,
  ).toBe("uncertain");
});

test.each([undefined, { noul: -1 }, { noul: NaN }, { noul: 2 }])(
  "rejects malformed probabilities",
  (answer) => {
    expect(() => gateNoul(answer, defaultConfig().thresholds)).toThrow("Invalid response");
  },
);
