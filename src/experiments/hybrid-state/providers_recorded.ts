import { readFile } from "node:fs/promises";

import { requestHash } from "./providers_request.js";
import type {
  ActorProvider,
  CallOptions,
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
  RepairRequest,
  RepairResponse,
} from "./types.js";

interface RecordedCall {
  readonly kind: "actor" | "jev" | "repair" | "update";
  readonly trialId: string;
  readonly step: number;
  readonly requestHash: string;
  readonly response: unknown;
}

interface RecordedPosition {
  readonly trialId?: string | undefined;
  readonly step?: number | undefined;
}

type RecordedCallOptions = CallOptions & RecordedPosition;

const RECORDED_KINDS: ReadonlySet<unknown> = new Set(["actor", "jev", "repair", "update"]);

export class RecordedJevProvider implements JevProvider {
  readonly name = "recorded-jev";
  constructor(private readonly calls: ReadonlyMap<string, RecordedCall>) {}
  choose(request: JevRequest, options?: RecordedCallOptions) {
    const call = this.calls.get(recordedKey("jev", request, options));
    if (!call) return Promise.resolve({ answers: [], error: "recorded_response_missing" });
    return Promise.resolve(call.response as JevResponse);
  }
}

export class RecordedRepairProvider implements RepairProvider {
  readonly name = "recorded-repair";
  constructor(private readonly calls: ReadonlyMap<string, RecordedCall>) {}
  repair(request: RepairRequest, options?: RecordedCallOptions) {
    const call = this.calls.get(recordedKey("repair", request, options));
    if (!call) return Promise.resolve({ error: "recorded_response_missing" });
    return Promise.resolve(call.response as RepairResponse);
  }
}

export class RecordedActorProvider implements ActorProvider {
  readonly name = "recorded-actor";
  constructor(private readonly calls: ReadonlyMap<string, RecordedCall>) {}
  act(request: ActorRequest) {
    const call = this.calls.get(
      recordedKey("actor", request, { trialId: request.trialId, step: request.step }),
    );
    if (!call) return Promise.resolve({ error: "recorded_response_missing" });
    return Promise.resolve(call.response as ActorResponse);
  }
}

export class RecordedUpdateProvider implements UpdateProvider {
  readonly name = "recorded-update";
  constructor(private readonly calls: ReadonlyMap<string, RecordedCall>) {}
  update(request: GenerativeUpdateRequest, options?: RecordedCallOptions) {
    const call = this.calls.get(recordedKey("update", request, options));
    if (!call) return Promise.resolve({ error: "recorded_response_missing" });
    return Promise.resolve(call.response as GenerativeUpdateResponse);
  }
}

export async function readRecordedProviders(path: string): Promise<ProviderSet> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid recorded provider file");
  const record = value as Record<string, unknown>;
  const calls = new Map<string, RecordedCall>();
  const entries = Array.isArray(record.calls) ? record.calls : [];
  for (const entry of entries) {
    const call = parseRecordedCall(entry);
    calls.set(`${call.kind}|${call.trialId}|${call.step}|${call.requestHash}`, call);
  }
  return {
    jev: new RecordedJevProvider(calls),
    repair: new RecordedRepairProvider(calls),
    actor: new RecordedActorProvider(calls),
    update: new RecordedUpdateProvider(calls),
  };
}

function recordedKey(kind: string, request: unknown, position: RecordedPosition = {}): string {
  return `${kind}|${position.trialId ?? ""}|${position.step ?? -1}|${requestHash(kind, request)}`;
}

function parseRecordedCall(entry: unknown): RecordedCall {
  if (!entry || typeof entry !== "object") throw new Error("Invalid recorded call entry");
  const call = entry as Record<string, unknown>;
  if (!hasRecordedCallShape(call)) throw new Error("Invalid recorded call shape");
  return call as unknown as RecordedCall;
}

function hasRecordedCallShape(call: Record<string, unknown>): boolean {
  return (
    RECORDED_KINDS.has(call.kind) &&
    typeof call.trialId === "string" &&
    Number.isInteger(call.step) &&
    typeof call.requestHash === "string" &&
    call.response !== undefined
  );
}
