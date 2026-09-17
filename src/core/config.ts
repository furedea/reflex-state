import type { VerificationKind } from "./types.js";

export interface ReflexStateConfig {
  readonly enabled: boolean;
  readonly jev: {
    readonly enabled: boolean;
    readonly model: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly deadlineMs: number;
    readonly cooldownMs: number;
  };
  readonly thresholds: {
    readonly noulAccept: number;
    readonly noulReject: number;
    readonly minChoiceConfidence: number;
    readonly minChoiceMargin: number;
  };
  readonly limits: {
    readonly maxWorkingSetEvents: number;
    /** @deprecated Use maxProjectedBlockers. */
    readonly maxActiveBlockers: number;
    readonly maxProjectedBlockers: number;
    readonly maxExcerptHeadChars: number;
    readonly maxExcerptTailChars: number;
    readonly maxPromptChars: number;
    readonly maxRecentUserPrompts: number;
    readonly maxStateBlockChars: number;
  };
  readonly projection: {
    readonly enabled: boolean;
    readonly mode: "append" | "current-run";
    readonly placement: "last-message" | "run-start";
  };
  readonly shadowQuestions: readonly "phase"[];
  readonly verificationCommands: Readonly<Record<VerificationKind, readonly string[]>>;
}

export function defaultConfig(): ReflexStateConfig {
  return {
    enabled: true,
    jev: {
      enabled: true,
      model: "jev-latest",
      timeoutMs: 3000,
      maxRetries: 0,
      deadlineMs: 4000,
      cooldownMs: 60_000,
    },
    thresholds: { noulAccept: 0.8, noulReject: 0.2, minChoiceConfidence: 0.65, minChoiceMargin: 0 },
    limits: {
      maxWorkingSetEvents: 16,
      maxActiveBlockers: 8,
      maxProjectedBlockers: 8,
      maxExcerptHeadChars: 1200,
      maxExcerptTailChars: 600,
      maxPromptChars: 2000,
      maxRecentUserPrompts: 3,
      maxStateBlockChars: 6000,
    },
    projection: { enabled: false, mode: "append", placement: "last-message" },
    shadowQuestions: ["phase"],
    verificationCommands: { test: [], build: [], lint: [] },
  };
}
