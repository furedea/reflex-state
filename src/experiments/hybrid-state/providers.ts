import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../../core/config.js";
import { createTypeSafeClient } from "../../typesafe/client.js";
import type { TypeSafeSystemOneClient } from "../../typesafe/client.js";
import {
  decodeActorResponse,
  decodeAnswers,
  decodeOperationsEnvelope,
  record,
} from "./providers_decode.js";
import { repairCompletionBody, updateCompletionBody } from "./providers_request.js";
import type {
  ActorProvider,
  CallOptions,
  CompletionClient,
  CompletionRequest,
  JevProvider,
  ProviderSet,
  RepairProvider,
  UpdateProvider,
} from "./providers_types.js";
import type {
  ActorRequest,
  ActorResponse,
  GenerativeUpdateRequest,
  GenerativeUpdateResponse,
  JevRequest,
  JevResponse,
  PatchOperation,
  RepairRequest,
  RepairResponse,
  Usage,
} from "./types.js";

export type {
  ActorProvider,
  CallOptions,
  CompletionClient,
  CompletionRequest,
  JevProvider,
  ProviderSet,
  RepairProvider,
  UpdateProvider,
} from "./providers_types.js";
export {
  FakeActorProvider,
  FakeJevProvider,
  FakeRepairProvider,
  FakeUpdateProvider,
  InputDependentActorProvider,
} from "./providers_fake.js";
export {
  readRecordedProviders,
  RecordedActorProvider,
  RecordedJevProvider,
  RecordedRepairProvider,
  RecordedUpdateProvider,
} from "./providers_recorded.js";
export {
  decodeActorResponse,
  decodeAnswers,
  decodeOperationsArray,
  decodeOperationsEnvelope,
} from "./providers_decode.js";
export { requestHash, sentRequestBody } from "./providers_request.js";

export class PiCompletionClient implements CompletionClient {
  private runtime: ModelRuntime | undefined;

  constructor(private readonly options: { readonly allowModelNetwork?: boolean } = {}) {}

  private async model(modelId: string) {
    this.runtime ??= await ModelRuntime.create({
      allowModelNetwork: this.options.allowModelNetwork === true,
    });
    const [provider, ...parts] = modelId.split("/");
    const model =
      provider && parts.length ? this.runtime.getModel(provider, parts.join("/")) : undefined;
    if (!model) throw new Error(`Pi model unavailable: ${modelId}`);
    return model;
  }

  async complete(request: CompletionRequest, options: { readonly signal: AbortSignal }) {
    const model = await this.model(request.model);
    const message = await this.runtime!.complete(
      model,
      {
        systemPrompt: request.system,
        messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
      },
      { signal: options.signal },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted")
      throw new Error(`pi_completion_${message.stopReason}:${message.errorMessage ?? ""}`);
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return {
      text,
      usage: {
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cacheReadTokens: message.usage.cacheRead,
        cacheWriteTokens: message.usage.cacheWrite,
      },
      stopReason: message.stopReason,
      model: message.responseModel ?? message.model,
    };
  }
}

export class LiveJevProvider implements JevProvider {
  readonly name = "typesafe-live-jev";
  private readonly client: TypeSafeSystemOneClient;

  constructor(
    private readonly model: string,
    client?: TypeSafeSystemOneClient,
  ) {
    this.client =
      client ??
      createTypeSafeClient({
        ...defaultConfig(),
        jev: { ...defaultConfig().jev, enabled: true, model },
      });
  }

  async choose(request: JevRequest, options?: CallOptions): Promise<JevResponse> {
    const started = performance.now();
    try {
      const response = await this.client.systemOne(
        {
          state: request.state,
          model: request.model || this.model,
          questions: Object.fromEntries(
            request.questions.map((question) => [
              question.id,
              {
                type: "choice" as const,
                instructions: question.prompt,
                criteria: question.options,
              },
            ]),
          ),
        },
        { signal: options?.signal ?? new AbortController().signal },
      );
      const usage = jevUsage(response);
      return {
        answers: decodeAnswers(response, request.questions),
        latencyMs: performance.now() - started,
        ...(usage ? { usage: sanitizeUsage(usage) } : {}),
      };
    } catch (error) {
      return {
        answers: [],
        latencyMs: performance.now() - started,
        error: errorMessage(error),
      };
    }
  }
}

/** Keep finite, non-negative values; anything else is treated as unreported. */
function sanitizeUsage(usage: Usage): Usage {
  const field = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    inputTokens: field(usage.inputTokens),
    outputTokens: field(usage.outputTokens),
    cacheReadTokens: field(usage.cacheReadTokens),
    cacheWriteTokens: field(usage.cacheWriteTokens),
  };
}

export class LiveActorProvider implements ActorProvider {
  readonly name = "pi-live-actor";
  constructor(
    private readonly model: string,
    private readonly client: CompletionClient = new PiCompletionClient(),
  ) {}

  async act(request: ActorRequest, options?: CallOptions): Promise<ActorResponse> {
    const started = performance.now();
    let response;
    try {
      response = await this.client.complete(
        { system: request.system, user: request.user, model: request.model || this.model },
        { signal: signalOf(options) },
      );
    } catch (error) {
      return { latencyMs: performance.now() - started, error: errorMessage(error) };
    }
    const raw = {
      rawText: response.text,
      ...(response.model ? { responseModel: response.model } : {}),
      ...usageField(response.usage),
    };
    let decoded;
    try {
      decoded = decodeActorResponse(response.text, request.mode);
    } catch (error) {
      return { latencyMs: performance.now() - started, error: errorMessage(error), ...raw };
    }
    return {
      action: decoded.action,
      actionForm: decoded.actionForm,
      ...(decoded.statePatch ? { statePatch: decoded.statePatch } : {}),
      ...(decoded.patchInput ? { patchInput: decoded.patchInput } : {}),
      ...(decoded.text ? { text: decoded.text } : {}),
      latencyMs: performance.now() - started,
      ...raw,
    };
  }
}

export class LiveRepairProvider implements RepairProvider {
  readonly name = "pi-live-repair";
  constructor(
    private readonly model: string,
    private readonly client: CompletionClient = new PiCompletionClient(),
  ) {}

  repair(request: RepairRequest, options?: CallOptions): Promise<RepairResponse> {
    return completeOperations(
      this.client,
      { ...repairCompletionBody(request), model: request.model || this.model },
      options,
    );
  }
}

export class LiveUpdateProvider implements UpdateProvider {
  readonly name = "pi-live-update";
  constructor(
    private readonly model: string,
    private readonly client: CompletionClient = new PiCompletionClient(),
  ) {}

  update(
    request: GenerativeUpdateRequest,
    options?: CallOptions,
  ): Promise<GenerativeUpdateResponse> {
    return completeOperations(
      this.client,
      { ...updateCompletionBody(request), model: request.model || this.model },
      options,
    );
  }
}

async function completeOperations(
  client: CompletionClient,
  request: CompletionRequest,
  options: CallOptions | undefined,
): Promise<RepairResponse & GenerativeUpdateResponse> {
  const started = performance.now();
  let response;
  try {
    response = await client.complete(request, { signal: signalOf(options) });
  } catch (error) {
    return { latencyMs: performance.now() - started, error: errorMessage(error) };
  }
  const usage = usageField(response.usage);
  let operations: PatchOperation[];
  try {
    operations = decodeOperationsEnvelope(response.text);
  } catch (error) {
    return {
      latencyMs: performance.now() - started,
      error: errorMessage(error),
      rawText: response.text,
      ...usage,
    };
  }
  return {
    operations,
    latencyMs: performance.now() - started,
    rawText: response.text,
    ...usage,
  };
}

export async function createLiveProviders(options: {
  readonly actorModel?: string;
  readonly jevModel?: string;
  readonly repairModel?: string;
  readonly updateModel?: string;
  readonly needs: {
    readonly actor: boolean;
    readonly jev: boolean;
    readonly repair: boolean;
    readonly update: boolean;
  };
}): Promise<ProviderSet> {
  const client = new PiCompletionClient();
  const { needs } = options;
  const updateModel = options.updateModel ?? options.actorModel;
  return {
    ...(needs.actor && options.actorModel
      ? { actor: new LiveActorProvider(options.actorModel, client) }
      : {}),
    ...(needs.jev && options.jevModel ? { jev: new LiveJevProvider(options.jevModel) } : {}),
    ...(needs.repair && options.repairModel
      ? { repair: new LiveRepairProvider(options.repairModel, client) }
      : {}),
    ...(needs.update && updateModel ? { update: new LiveUpdateProvider(updateModel, client) } : {}),
  };
}

function signalOf(options: CallOptions | undefined): AbortSignal {
  return options?.signal ?? new AbortController().signal;
}

function usageField(usage: Usage | undefined): { usage?: Usage } {
  return usage ? { usage: sanitizeUsage(usage) } : {};
}

function jevUsage(response: unknown): Usage | undefined {
  try {
    const usage = record(record(response).usage);
    const input = usage.input_tokens;
    const output = usage.output_tokens;
    if (typeof input !== "number" && typeof output !== "number") return undefined;
    return {
      inputTokens: typeof input === "number" ? input : null,
      outputTokens: typeof output === "number" ? output : null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "provider_error";
}
