import { renderMemoryProjection } from "./projection.js";
import type { RepairProvider } from "./providers.js";
import type {
  PatchOperation,
  RepairReason,
  RepairRequest,
  RepairResponse,
  UpdateInput,
} from "./types.js";
import {
  applyContext,
  applyOperations,
  validateOperations,
  type ApplyContext,
} from "./update_operations.js";

/** Decides whether a proposed patch to one input's memory needs repair. */
export class RepairCheck {
  constructor(
    private readonly input: UpdateInput,
    private readonly memoryBytes: number,
  ) {}

  reasonsFor(operations: readonly PatchOperation[], context: ApplyContext): RepairReason[] {
    const { memory } = this.input;
    const validation = validateOperations(memory, operations, context);
    const reasons = reasonsFromErrors(validation.errors);
    const applied = applyOperations(memory, validation.valid, context);
    if (applied.ok) {
      if (Buffer.byteLength(renderMemoryProjection(applied.memory)) > this.memoryBytes)
        reasons.push("budget_exceeded");
    } else if (!validation.errors.length) reasons.push("invalid_update");
    return [...new Set(reasons)];
  }
}

export function needsRepair(
  input: UpdateInput,
  operations: readonly PatchOperation[],
  memoryBytes: number,
): RepairReason[] {
  return new RepairCheck(input, memoryBytes).reasonsFor(operations, applyContext(input, false));
}

export function requestRepair(
  repair: RepairProvider,
  request: RepairRequest,
  signal: AbortSignal | undefined,
): Promise<RepairResponse> {
  return repair.repair(request, signal ? { signal } : {});
}

function reasonsFromErrors(errors: readonly string[]): RepairReason[] {
  const reasons: RepairReason[] = [];
  if (errors.some((error) => error.startsWith("missing_source"))) reasons.push("missing_evidence");
  if (errors.some((error) => error.startsWith("replace_"))) reasons.push("ambiguous_reference");
  if (errors.some((error) => !error.startsWith("missing_source") && !error.startsWith("replace_")))
    reasons.push("invalid_update");
  return reasons;
}
