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

export interface SystemOneRequest {
  readonly state: string;
  readonly questions: Record<string, Question>;
  readonly model: string;
}

export interface TypeSafeSystemOneClient {
  systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<unknown>;
}

export function failureKind(error: unknown): string {
  if (error instanceof AuthenticationError) return "auth_error";
  if (error instanceof APITimeoutError) return "timeout";
  if (error instanceof RateLimitError) return "rate_limit";
  if (error instanceof APIConnectionError) return "connection_error";
  if (error instanceof BadRequestError) return "bad_request";
  if (error instanceof UnprocessableEntityError) return "unprocessable";
  if (error instanceof InternalServerError) return "server_error";
  if (error instanceof InvalidResponseError) return "invalid_response";
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
