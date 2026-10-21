import type {
  ActorRequest,
  ActorResponse,
  GenerativeUpdateRequest,
  GenerativeUpdateResponse,
  JevRequest,
  JevResponse,
  RepairRequest,
  RepairResponse,
  Usage,
} from "./types.js";

export interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface JevProvider {
  readonly name: string;
  choose(request: JevRequest, options?: CallOptions): Promise<JevResponse>;
}

export interface RepairProvider {
  readonly name: string;
  repair(request: RepairRequest, options?: CallOptions): Promise<RepairResponse>;
}

export interface ActorProvider {
  readonly name: string;
  act(request: ActorRequest, options?: CallOptions): Promise<ActorResponse>;
}

export interface UpdateProvider {
  readonly name: string;
  update(
    request: GenerativeUpdateRequest,
    options?: CallOptions,
  ): Promise<GenerativeUpdateResponse>;
}

export interface ProviderSet {
  readonly jev?: JevProvider;
  readonly repair?: RepairProvider;
  readonly actor?: ActorProvider;
  readonly update?: UpdateProvider;
}

export interface CompletionClient {
  complete(
    request: { readonly system: string; readonly user: string; readonly model: string },
    options: { readonly signal: AbortSignal },
  ): Promise<{
    readonly text: string;
    readonly usage?: Usage;
    readonly stopReason?: string;
    readonly model?: string;
  }>;
}
