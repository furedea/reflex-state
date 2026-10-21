import { createHash } from "node:crypto";

import type {
  Candidate,
  MemoryItem,
  MemoryKind,
  PatchOperation,
  SourceRef,
  SourceTrust,
  TraceMessage,
  UpdateInput,
  WorkMemory,
} from "./types.js";

const MEMORY_KINDS = new Set<MemoryKind>([
  "constraints",
  "decisions",
  "findings",
  "attempts",
  "open_questions",
]);

export interface ApplyContext {
  readonly candidates: readonly Candidate[];
  readonly observations: readonly TraceMessage[];
  readonly extraSourceIds?: readonly string[];
  readonly extraSources?: readonly SourceRef[];
  readonly allowGenerated: boolean;
  readonly now: number;
}

export interface ApplySuccess {
  readonly ok: true;
  readonly memory: WorkMemory;
  readonly applied: readonly PatchOperation[];
  /** Indices into the operations array this call received, so callers can
   * report exactly which submitted operations changed memory. */
  readonly appliedIndices: readonly number[];
}

export interface ApplyFailure {
  readonly ok: false;
  readonly reason: string;
  readonly errors: readonly string[];
}

export function applyOperations(
  memory: WorkMemory,
  operations: readonly PatchOperation[],
  context: ApplyContext,
): ApplySuccess | ApplyFailure {
  const validation = validateOperations(memory, operations, context);
  if (validation.errors.length)
    return {
      ok: false,
      reason: validation.errors[0] ?? "invalid_update",
      errors: validation.errors,
    };
  const next: Record<MemoryKind, MemoryItem[]> = Object.fromEntries(
    Object.entries(memory).map(([kind, items]) => [kind as MemoryKind, [...items]]),
  ) as Record<MemoryKind, MemoryItem[]>;
  const applied: PatchOperation[] = [];
  const appliedIndices: number[] = [];
  for (const [validIndex, operation] of validation.valid.entries()) {
    const item = memoryItemFor(operation, context.now);
    if (!storeItem(next[operation.kind], operation, item)) continue;
    applied.push(operation);
    appliedIndices.push(validIndex);
  }
  return { ok: true, memory: next, applied, appliedIndices };
}

function memoryItemFor(operation: PatchOperation, now: number): MemoryItem {
  return {
    id: operation.itemId ?? memoryId(operation),
    kind: operation.kind,
    text: operation.text,
    sourceIds: [...operation.sourceIds],
    origin: operation.origin,
    trust: operation.trust,
    status: "active",
    updatedAt: now,
    ...(operation.replaces ? { replaces: operation.replaces } : {}),
  };
}

/** Adds or replaces the item in its bucket; false when memory is unchanged. */
function storeItem(bucket: MemoryItem[], operation: PatchOperation, item: MemoryItem): boolean {
  if (operation.operation === "replace") {
    const index = bucket.findIndex((existing) => existing.id === operation.itemId);
    if (sameItem(bucket[index]!, item)) return false;
    bucket[index] = item;
    return true;
  }
  if (bucket.some((existing) => existing.text === item.text)) return false;
  bucket.push(item);
  return true;
}

function sameItem(existing: MemoryItem, next: MemoryItem): boolean {
  return (
    existing.text === next.text &&
    existing.origin === next.origin &&
    existing.trust === next.trust &&
    existing.sourceIds.length === next.sourceIds.length &&
    existing.sourceIds.every((id, index) => id === next.sourceIds[index])
  );
}

type OperationCheck = { readonly operation: PatchOperation } | { readonly error: string };

export function validateOperations(
  memory: WorkMemory,
  operations: readonly PatchOperation[],
  context: ApplyContext,
): {
  readonly valid: readonly PatchOperation[];
  /** Original index of each entry in `valid` inside the submitted operations,
   * so applied/unchanged/rejected accounting can name patch positions. */
  readonly validIndices: readonly number[];
  readonly errors: readonly string[];
} {
  const validator = new OperationValidator(memory, context);
  const errors: string[] = [];
  const valid: PatchOperation[] = [];
  const validIndices: number[] = [];
  for (const [index, operation] of operations.entries()) {
    const check = validator.check(operation);
    if ("error" in check) {
      errors.push(`${check.error}#${index}`);
      continue;
    }
    valid.push(check.operation);
    validIndices.push(index);
  }
  return { valid, validIndices, errors };
}

/** Validates the operations of one patch against the memory and context they
 * apply to, tracking which ids and replace targets earlier operations claimed. */
class OperationValidator {
  private readonly sources: ReadonlySet<string>;
  private readonly items: readonly MemoryItem[];
  private readonly claimedIds: Set<string>;
  private readonly replacedTargets = new Set<string>();

  constructor(
    private readonly memory: WorkMemory,
    private readonly context: ApplyContext,
  ) {
    this.sources = validSources(context, memory);
    this.items = Object.values(memory).flat();
    this.claimedIds = new Set(this.items.map((item) => item.id));
  }

  check(operation: PatchOperation): OperationCheck {
    const shapeError = shapeErrorOf(operation, this.sources);
    if (shapeError) return { error: shapeError };
    const cited = citedSources(operation, this.memory, this.context);
    const originError = originErrorOf(operation, cited, this.context.allowGenerated);
    if (originError) return { error: originError };
    if (hasMismatchedReplaceIds(operation)) return { error: "replace_id_mismatch" };
    const trust = deriveTrust(operation, cited);
    const target = operation.operation === "replace" ? this.resolveReplaceTarget(operation) : null;
    if (target && "error" in target) return { error: target.error };
    const normalized = normalizeOperation(operation, trust, target?.id);
    const duplicate = this.claimAddedId(normalized);
    return duplicate ? { error: duplicate } : { operation: normalized };
  }

  private resolveReplaceTarget(
    operation: PatchOperation,
  ): { readonly id: string } | { readonly error: string } {
    const targetId = operation.itemId ?? operation.replaces;
    const target = targetId ? this.items.find((item) => item.id === targetId) : undefined;
    if (!target) return { error: "replace_unknown_target" };
    if (target.kind !== operation.kind) return { error: "replace_kind_mismatch" };
    if (target.kind === "constraints" && target.trust === "user")
      return { error: "protected_constraint" };
    if (this.replacedTargets.has(target.id)) return { error: "replace_duplicate_target" };
    this.replacedTargets.add(target.id);
    return { id: target.id };
  }

  private claimAddedId(operation: PatchOperation): string | undefined {
    if (operation.operation !== "add") return undefined;
    const effectiveId = operation.itemId ?? memoryId(operation);
    if (this.claimedIds.has(effectiveId)) return "duplicate_id";
    this.claimedIds.add(effectiveId);
    return undefined;
  }
}

function shapeErrorOf(operation: PatchOperation, sources: ReadonlySet<string>): string | undefined {
  if (!MEMORY_KINDS.has(operation.kind)) return "invalid_kind";
  if (operation.operation !== "add" && operation.operation !== "replace")
    return "invalid_operation";
  if (!operation.text.trim()) return "empty_text";
  if (!operation.sourceIds.length) return "missing_source:empty";
  const missing = operation.sourceIds.filter((id) => !sources.has(id));
  return missing.length ? `missing_source:${missing.join(",")}` : undefined;
}

function originErrorOf(
  operation: PatchOperation,
  cited: readonly CitedSource[],
  allowGenerated: boolean,
): string | undefined {
  if (operation.origin === "generated") return allowGenerated ? undefined : "generated_not_allowed";
  if (operation.origin !== "extracted") return "invalid_origin";
  return cited.some((source) => source.text === operation.text)
    ? undefined
    : "extracted_text_mismatch";
}

function hasMismatchedReplaceIds(operation: PatchOperation): boolean {
  return (
    operation.itemId !== undefined &&
    operation.replaces !== undefined &&
    operation.itemId !== operation.replaces
  );
}

function normalizeOperation(
  operation: PatchOperation,
  trust: SourceTrust,
  targetId: string | undefined,
): PatchOperation {
  const itemId = targetId ?? operation.itemId;
  const replaces = targetId ?? operation.replaces;
  return {
    operation: operation.operation,
    ...(itemId ? { itemId } : {}),
    kind: operation.kind,
    text: operation.text,
    sourceIds: [...operation.sourceIds],
    trust,
    origin: operation.origin,
    ...(replaces ? { replaces } : {}),
  };
}

type CitedSource = { readonly text: string; readonly trust: SourceTrust };

export function deriveTrust(operation: PatchOperation, cited: readonly CitedSource[]): SourceTrust {
  if (operation.origin === "extracted") {
    const match = cited.find((source) => source.text === operation.text) ?? cited[0];
    return match?.trust ?? "unknown";
  }
  const trusts = new Set(cited.map((source) => source.trust));
  if (trusts.size === 1 && trusts.has("tool_result")) return "tool_result";
  if (trusts.size === 1 && trusts.has("unknown")) return "unknown";
  return "assistant";
}

export function applyContext(
  input: UpdateInput,
  allowGenerated: boolean,
  extraSourceIds: readonly string[] = [],
): ApplyContext {
  return {
    candidates: input.candidates,
    observations: [...input.observations, ...input.latest],
    extraSourceIds,
    allowGenerated,
    now: input.now,
  };
}

function validSources(context: ApplyContext, memory: WorkMemory): Set<string> {
  const sources = new Set<string>();
  for (const candidate of context.candidates) {
    sources.add(candidate.id);
    for (const id of candidate.sourceIds) sources.add(id);
  }
  for (const message of context.observations) {
    sources.add(message.id);
    sources.add(message.sourceId);
  }
  for (const item of Object.values(memory).flat()) {
    sources.add(item.id);
    for (const id of item.sourceIds) sources.add(id);
  }
  for (const id of context.extraSourceIds ?? []) sources.add(id);
  for (const source of context.extraSources ?? []) sources.add(source.id);
  return sources;
}

function citedSources(
  operation: PatchOperation,
  memory: WorkMemory,
  context: ApplyContext,
): readonly CitedSource[] {
  const ids = new Set(operation.sourceIds);
  const fromCandidates = context.candidates.filter(
    (candidate) => ids.has(candidate.id) || candidate.sourceIds.some((id) => ids.has(id)),
  );
  const fromMemory = Object.values(memory)
    .flat()
    .filter((item) => ids.has(item.id) || item.sourceIds.some((id) => ids.has(id)));
  const fromExtra = (context.extraSources ?? []).filter((source) => ids.has(source.id));
  return [...fromCandidates, ...fromMemory, ...fromExtra];
}

export function memoryId(operation: PatchOperation): string {
  return `memory-${createHash("sha256").update(JSON.stringify(operation)).digest("hex").slice(0, 12)}`;
}

export function memoryItems(memory: WorkMemory): readonly MemoryItem[] {
  return Object.values(memory).flat();
}
