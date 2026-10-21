import type { SemanticDecisions } from "../core/types.js";
import { emptyDecisions } from "../core/updater.js";
import type { StateUpdateContext, StateUpdater, UpdaterHealth } from "../core/updater.js";
import { failureKind } from "./client.js";
import type { Question, TypeSafeSystemOneClient } from "./client.js";
import { RequestCancelledError, withinDeadline } from "./deadline.js";
import { decodeDecisions, describeResponse, errorDecisions } from "./decisions.js";
import { buildInput } from "./input.js";
import { buildQuestions } from "./questions.js";

export class JevStateUpdater implements StateUpdater {
  readonly name = "jev";
  private failures = 0;
  private openedUntil = 0;
  private disabledReason: string | undefined;

  constructor(
    private readonly client: TypeSafeSystemOneClient,
    private readonly options: { notify?: (message: string) => void } = {},
  ) {}

  get health(): UpdaterHealth {
    if (this.disabledReason)
      return { status: "disabled", circuit: "closed", reason: this.disabledReason };
    if (this.openedUntil > Date.now()) return { status: "degraded", circuit: "open" };
    if (this.openedUntil) return { status: "degraded", circuit: "half_open" };
    return { status: this.failures ? "degraded" : "ok", circuit: "closed" };
  }

  async evaluate(context: StateUpdateContext, signal?: AbortSignal): Promise<SemanticDecisions> {
    if (!context.config.jev.enabled) return emptyDecisions();
    const blockedReason = this.blockedReason();
    if (blockedReason) return errorDecisions([], blockedReason);
    const questions = buildQuestions(context);
    const ids = Object.keys(questions);
    if (!ids.length) return emptyDecisions();
    const started = performance.now();
    const outcome = await this.request(context, { ids, questions }, signal);
    return withCallTelemetry(outcome, ids, started);
  }

  private blockedReason(): string | undefined {
    if (this.disabledReason) return this.disabledReason;
    return this.openedUntil > Date.now() ? "circuit_open" : undefined;
  }

  private async request(
    context: StateUpdateContext,
    { ids, questions }: { ids: string[]; questions: Record<string, Question> },
    signal?: AbortSignal,
  ): Promise<RequestOutcome> {
    const attempt = { invoked: false };
    let response: unknown;
    try {
      response = await withinDeadline(
        (requestSignal) => {
          const state = buildInput(context);
          attempt.invoked = true;
          return this.client.systemOne(
            { state, questions, model: context.config.jev.model },
            { signal: requestSignal },
          );
        },
        { deadlineMs: context.config.jev.deadlineMs, signal },
      );
      const decisions = decodeDecisions(response, ids, context.config.thresholds);
      this.failures = 0;
      this.openedUntil = 0;
      return { decisions, invoked: attempt.invoked };
    } catch (error) {
      const kind = error instanceof RequestCancelledError ? error.kind : failureKind(error);
      const responseShape =
        kind === "invalid_response" ? describeResponse(response, ids) : undefined;
      if (kind !== "aborted") this.recordFailure(kind, context);
      return { decisions: errorDecisions(ids, kind), invoked: attempt.invoked, responseShape };
    }
  }

  private recordFailure(kind: string, context: StateUpdateContext): void {
    this.failures++;
    if (kind === "auth_error") {
      this.disabledReason = kind;
      this.options.notify?.(
        "ReflexState: Jev authentication failed; deterministic updates remain active.",
      );
    } else if (this.failures >= 3) {
      this.openedUntil = Date.now() + context.config.jev.cooldownMs;
    }
  }
}

interface RequestOutcome {
  readonly decisions: SemanticDecisions;
  readonly invoked: boolean;
  readonly responseShape?: Record<string, string> | undefined;
}

function withCallTelemetry(
  { decisions, invoked, responseShape }: RequestOutcome,
  ids: string[],
  started: number,
): SemanticDecisions {
  return {
    ...decisions,
    telemetry: {
      ...decisions.telemetry,
      questionsAsked: invoked ? ids.length : 0,
      questionIds: invoked ? ids : [],
      ...(invoked ? { latencyMs: performance.now() - started } : {}),
      ...(responseShape ? { responseShape } : {}),
    },
  };
}
