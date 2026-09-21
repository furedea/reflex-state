import { describe, expect, it } from "vitest";

import {
  analyzeRereads,
  type EvidenceScope,
  type ReadObservation,
  type RereadCase,
  type RereadStepView,
  type RereadTag,
} from "./reread.js";

const read = (path: string) => ({ tool: "read" as const, path });

describe("re-read analysis", () => {
  it("L-14: content that only entered memory after the re-read is not counted as visible", () => {
    const steps: RereadStepView[] = [
      { step: 0, action: read("docs/policy.md"), memoryTexts: [], observationTexts: [] },
      { step: 1, action: read("src/a.ts"), memoryTexts: [], observationTexts: [] },
      // The re-read: this step's own input carried neither the file content
      // nor a memory of it.
      { step: 2, action: read("docs/policy.md"), memoryTexts: [], observationTexts: [] },
      // The content lands in memory only AFTER the re-read. If the analysis
      // peeked at later steps it would wrongly claim "already visible".
      {
        step: 3,
        action: { tool: "write", path: "src/b.ts", content: "x" },
        memoryTexts: ["policy text: use A unless occupied"],
        observationTexts: [],
      },
    ];
    const reads: ReadObservation[] = [
      { step: 0, path: "docs/policy.md", content: "policy text: use A unless occupied" },
      { step: 2, path: "docs/policy.md", content: "policy text: use A unless occupied" },
    ];
    const cases: RereadCase[] = analyzeRereads("trial", steps, reads);
    expect(cases).toHaveLength(1);
    const [found] = cases;
    expect(found?.step).toBe(2);
    expect(found?.verbatimPresent).toBe(false);
    expect(found?.tags).not.toContain("visible_information_rechecked");
    // Nothing of the file reached the input, but with no named requirements
    // the necessity of that absence cannot be asserted.
    expect(found?.tags).toContain("not_saved");
    expect(found?.necessity).toBe("undetermined");
    expect(found?.basis).toBe("insufficient");
  });

  it("L-14: unchanged content already in the step input is a visible recheck", () => {
    const steps: RereadStepView[] = [
      { step: 0, action: read("docs/policy.md"), memoryTexts: [], observationTexts: [] },
      {
        step: 1,
        action: read("src/a.ts"),
        memoryTexts: ["policy text: use A unless occupied"],
        observationTexts: [],
      },
      {
        step: 2,
        action: read("docs/policy.md"),
        memoryTexts: ["policy text: use A unless occupied"],
        observationTexts: [],
      },
    ];
    const reads = [
      { step: 0, path: "docs/policy.md", content: "policy text: use A unless occupied" },
    ];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.verbatimPresent).toBe(true);
    expect(found?.changedBetweenReads).toBe(false);
    expect(found?.tags).toContain("visible_information_rechecked");
  });

  it("L-14: a write between the two reads makes the re-read a stale check", () => {
    const steps: RereadStepView[] = [
      { step: 0, action: read("src/a.ts"), memoryTexts: [], observationTexts: [] },
      { step: 1, action: { tool: "edit", path: "src/a.ts", old: "x", new: "y" } },
      {
        step: 2,
        action: read("src/a.ts"),
        memoryTexts: ["export const a = 1;"],
        observationTexts: [],
      },
    ];
    const reads = [{ step: 0, path: "src/a.ts", content: "export const a = 1;" }];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.changedBetweenReads).toBe(true);
    expect(found?.tags).toContain("stale_or_conflicting");
    expect(found?.tags).not.toContain("visible_information_rechecked");
  });

  it("L-14: a rejected patch before the re-read grounds not_saved as inferred", () => {
    const steps: RereadStepView[] = [
      { step: 0, action: read("src/a.ts"), memoryTexts: [], observationTexts: [] },
      {
        step: 1,
        action: read("src/b.ts"),
        memoryTexts: [],
        observationTexts: [],
        droppedReasons: ["missing_source:obs-9#0"],
      },
      {
        step: 2,
        action: read("src/a.ts"),
        memoryTexts: [],
        observationTexts: [],
        requiredDetails: ["export const a = 1;"],
      },
    ];
    const reads = [{ step: 0, path: "src/a.ts", content: "export const a = 1;" }];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.patchDroppedBefore).toBe(true);
    expect(found?.tags).toContain("necessary_detail_missing");
    expect(found?.basis).toBe("inferred");
  });

  it("L-14: missing per-step input records classify as unknown, never as recheck", () => {
    const steps: RereadStepView[] = [
      { step: 0, action: read("src/a.ts") },
      { step: 1 },
      // No memoryTexts/observationTexts: the sent input is not recorded.
      { step: 2, action: read("src/a.ts") },
    ];
    const reads = [{ step: 0, path: "src/a.ts", content: "export const a = 1;" }];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.verbatimPresent).toBeNull();
    expect(found?.evidenceScope).toBe("unavailable");
    expect(found?.tags).toEqual(["unknown"]);
    expect(found?.basis).toBe("insufficient");
  });

  it("G-01: verbatim absence with the needed values visible is not necessary_detail_missing", () => {
    const content = [
      "# Network policy",
      "If the primary port is occupied, fall back.",
      "FALLBACK_PORT=8080",
      "Check `lsof -i :8080` before binding.",
    ].join("\n");
    const steps: RereadStepView[] = [
      { step: 0, action: read("docs/net-policy.md"), memoryTexts: [], observationTexts: [] },
      {
        step: 1,
        action: { tool: "test", command: "check" },
        memoryTexts: [
          "net-policy: fallback port is 8080 when the primary is occupied; verify with lsof -i :8080",
        ],
        observationTexts: [],
      },
      {
        step: 2,
        action: read("docs/net-policy.md"),
        memoryTexts: [
          "net-policy: fallback port is 8080 when the primary is occupied; verify with lsof -i :8080",
        ],
        observationTexts: [],
        requiredDetails: ["8080", "occupied"],
      },
    ];
    const reads = [{ step: 0, path: "docs/net-policy.md", content }];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.verbatimPresent).toBe(false);
    expect(found?.required?.missing).toEqual([]);
    expect(found?.necessity).toBe("sufficient");
    expect(found?.tags).not.toContain("necessary_detail_missing");
    expect(found?.tags).toContain("visible_information_rechecked");
  });

  it("G-01: a missing concrete edit detail is necessary_detail_missing", () => {
    const steps: RereadStepView[] = [
      { step: 0, action: read("src/config.js"), memoryTexts: [], observationTexts: [] },
      {
        step: 1,
        action: read("src/config.js"),
        // Memory summarizes the file but the exact literal the planned edit
        // must match is absent from the recorded input.
        memoryTexts: ["config.js defines the deployment settings"],
        observationTexts: [],
        requiredDetails: ["RETRY_LIMIT = 3"],
      },
    ];
    const reads = [
      {
        step: 0,
        path: "src/config.js",
        content: "module.exports = { RETRY_LIMIT = 3, REGION: 'us' };",
      },
    ];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.verbatimPresent).toBe(false);
    expect(found?.required?.missing).toEqual(["RETRY_LIMIT = 3"]);
    expect(found?.necessity).toBe("missing");
    expect(found?.tags).toContain("necessary_detail_missing" satisfies RereadTag);
    expect(found?.basis).toBe("observed");
  });

  it("G-01: unclear planned work leaves necessity undetermined", () => {
    const steps: RereadStepView[] = [
      { step: 0, action: read("src/config.js"), memoryTexts: [], observationTexts: [] },
      // No requiredDetails: what the actor planned to do next is unknown, so
      // the analysis must not assert the re-read was necessary or pointless.
      {
        step: 1,
        action: read("src/config.js"),
        memoryTexts: ["config.js defines deployment settings"],
        observationTexts: [],
      },
    ];
    const reads = [
      {
        step: 0,
        path: "src/config.js",
        content: "module.exports = { RETRY_LIMIT = 3, REGION: 'us' };",
      },
    ];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.verbatimPresent).toBe(false);
    expect(found?.necessity).toBe("undetermined");
    expect(found?.tags).not.toContain("necessary_detail_missing");
    expect(found?.tags).not.toContain("visible_information_rechecked");
  });

  it("G-02: JSON-escaped newlines in recorded input do not fake verbatim absence", () => {
    const content = "line one\nline two\nline three with enough characters";
    const steps: RereadStepView[] = [
      { step: 0, action: read("docs/a.md"), memoryTexts: [], observationTexts: [] },
      {
        step: 1,
        action: read("docs/a.md"),
        // The recorder stored the JSON-serialized form: real newlines appear
        // as the two-byte escape sequence.
        memoryTexts: [JSON.stringify(content).slice(1, -1)],
        observationTexts: [],
      },
    ];
    const reads = [{ step: 0, path: "docs/a.md", content }];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.verbatimPresent).toBe(true);
  });

  it("G-02: user-only records scope the claim instead of widening it to the full input", () => {
    const steps: RereadStepView[] = [
      { step: 0, action: read("src/a.ts"), memoryTexts: [], observationTexts: [] },
      {
        step: 1,
        action: read("src/a.ts"),
        memoryTexts: [],
        observationTexts: [],
        inputScope: "user_only" satisfies EvidenceScope,
      },
    ];
    const reads = [{ step: 0, path: "src/a.ts", content: "export const a = 1;" }];
    const [found] = analyzeRereads("trial", steps, reads);
    expect(found?.evidenceScope).toBe("user_only" satisfies EvidenceScope);
    expect(found?.verbatimPresent).toBe(false);
    expect(found?.necessity).toBe("undetermined");
  });
});
