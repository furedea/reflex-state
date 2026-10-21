import {
  TypeSafeClient,
  AuthenticationError,
  RateLimitError,
  APITimeoutError,
  APIConnectionError,
  BadRequestError,
  UnprocessableEntityError,
  InternalServerError,
  TypeSafeError,
} from "@typesafe-ai/sdk";

import type { ReflexStateConfig } from "../core/config.js";
import { InvalidResponseError } from "./gating.js";

export type Question =
  | { readonly type: "noul"; readonly instructions: string }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Record<string, string>;
    };

interface SystemOneRequest {
  readonly state: string;
  readonly questions: Record<string, Question>;
  readonly model: string;
}

export interface TypeSafeSystemOneClient {
  systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<unknown>;
}

const FAILURE_KINDS: readonly (readonly [abstract new (...args: never[]) => Error, string])[] = [
  [AuthenticationError, "auth_error"],
  [APITimeoutError, "timeout"],
  [RateLimitError, "rate_limit"],
  [APIConnectionError, "connection_error"],
  [BadRequestError, "bad_request"],
  [UnprocessableEntityError, "unprocessable"],
  [InternalServerError, "server_error"],
  [InvalidResponseError, "invalid_response"],
];

export function failureKind(error: unknown): string {
  const known = FAILURE_KINDS.find(([errorClass]) => error instanceof errorClass);
  if (known) return known[1];
  if (error instanceof Error && /api[_ ]?key/i.test(error.message)) return "auth_error";
  if (error instanceof TypeSafeError) return "sdk_error";
  return "updater_error";
}

export function createTypeSafeClient(config: ReflexStateConfig): TypeSafeSystemOneClient {
  let client: TypeSafeClient | undefined;
  return {
    systemOne(request, options) {
      client ??= new TypeSafeClient({
        defaultModel: config.jev.model,
        timeout: config.jev.timeoutMs,
        retry: { maxRetries: config.jev.maxRetries },
        logLevel: "warn",
        logger: {
          debug() {},
          info() {},
          warn() {
            console.warn("TypeSafe SDK warning");
          },
          error() {
            console.error("TypeSafe SDK error");
          },
        },
      });
      return client.systemOne(request, options);
    },
  };
}
