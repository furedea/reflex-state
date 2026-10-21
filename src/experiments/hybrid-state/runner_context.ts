import { createHash } from "node:crypto";

import type { ProjectedInput } from "./projection.js";
import type {
  CallRecord,
  CallStartRecord,
  Candidate,
  ContextRecord,
  ExperimentManifest,
  ExperimentMode,
  ExperimentSummary,
  HybridConfig,
  PatchOperation,
  SystemPromptRecord,
  UpdateRecord,
  WorkMemory,
} from "./types.js";

export interface ExperimentRun {
  readonly manifest: ExperimentManifest;
  readonly updates: readonly UpdateRecord[];
  readonly calls: readonly CallRecord[];
  readonly contexts: readonly ContextRecord[];
  readonly summary: ExperimentSummary;
}

export interface RunRecorder {
  callStart(record: CallStartRecord): Promise<void>;
  call(record: CallRecord): Promise<void>;
  context(record: ContextRecord): Promise<void>;
  update(record: UpdateRecord): Promise<void>;
  prompt?(record: SystemPromptRecord): Promise<void>;
}

export class PersistenceError extends Error {
  constructor(message: string) {
    super(`persistence_failed:${message}`);
    this.name = "PersistenceError";
  }
}

export interface RunContext {
  readonly runId: string;
  readonly calls: CallRecord[];
  readonly contexts: ContextRecord[];
  readonly updates: UpdateRecord[];
  readonly uniqueCandidates: Map<ExperimentMode, Set<string>>;
  readonly decisionCounts: Map<ExperimentMode, number>;
  readonly appliedCounts: Map<ExperimentMode, { extractive: number; generated: number }>;
  readonly budget: RequestBudget;
  readonly trialSent: Map<string, number>;
  /** System prompt hashes already persisted this run; bodies are stored once. */
  readonly systemPrompts: Set<string>;
  callSeq: number;
  readonly recorder?: RunRecorder;
}

export interface RequestBudget {
  sent: number;
  readonly limit: number;
}

export class BudgetExhausted extends Error {
  constructor() {
    super("not_run_global_budget");
  }
}

export interface TrialAddress {
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly step: number;
  readonly kind: UpdateRecord["kind"];
}

export interface AuditAddress {
  readonly kind: UpdateRecord["kind"];
  readonly step: number;
  readonly mode: string;
}

export interface ContextArgs {
  readonly trialId: string;
  readonly taskId: string;
  readonly mode: ExperimentMode;
  readonly step: number;
  readonly projected: ProjectedInput;
  readonly system: string;
  readonly config: HybridConfig;
}

export function newRunContext(
  runId: string,
  config: HybridConfig,
  recorder?: RunRecorder,
): RunContext {
  return {
    runId,
    calls: [],
    contexts: [],
    updates: [],
    uniqueCandidates: new Map(),
    decisionCounts: new Map(),
    appliedCounts: new Map(),
    budget: { sent: 0, limit: config.provider.maxRequests },
    trialSent: new Map(),
    systemPrompts: new Set(),
    callSeq: 0,
    ...(recorder ? { recorder } : {}),
  };
}

export async function pushCall(ctx: RunContext, record: CallRecord): Promise<void> {
  ctx.calls.push(record);
  await writeRecord(ctx, "calls.jsonl", (recorder) => recorder.call(record));
}

export async function pushCallStart(ctx: RunContext, record: CallStartRecord): Promise<void> {
  await writeRecord(ctx, "calls.jsonl", (recorder) => recorder.callStart(record));
}

export async function pushUpdate(ctx: RunContext, record: UpdateRecord): Promise<void> {
  ctx.updates.push(record);
  await writeRecord(ctx, "updates.jsonl", (recorder) => recorder.update(record));
}

export async function recordContext(ctx: RunContext, args: ContextArgs): Promise<void> {
  const { projected } = args;
  const systemHash = createHash("sha256").update(args.system).digest("hex");
  // The static system body is persisted once per distinct hash; each step's
  // context record references it so the sent request stays reconstructible.
  if (args.config.recordContextText && !ctx.systemPrompts.has(systemHash)) {
    ctx.systemPrompts.add(systemHash);
    await writeRecord(ctx, "system_prompts.jsonl", (recorder) =>
      recorder.prompt
        ? recorder.prompt({
            record: "system_prompt",
            runId: ctx.runId,
            hash: systemHash,
            text: args.system,
          })
        : Promise.resolve(),
    );
  }
  await pushContext(ctx, {
    runId: ctx.runId,
    trialId: args.trialId,
    taskId: args.taskId,
    mode: args.mode,
    step: args.step,
    bytes: projected.bundle.bytes,
    sentBytes: Buffer.byteLength(projected.userText),
    included: [
      "instruction",
      "fixedTools",
      "facts",
      "memory",
      "latest",
      ...(projected.bundle.history === undefined ? [] : ["history"]),
    ],
    truncated: projected.bundle.truncated,
    systemHash,
    ...(args.config.recordContextText ? { text: projected.userText } : {}),
  });
}

export function trialRecord(
  ctx: RunContext,
  address: TrialAddress,
  data: Record<string, unknown>,
): UpdateRecord {
  return { runId: ctx.runId, ...address, ...data };
}

export function auditRecord(
  ctx: RunContext,
  address: AuditAddress,
  data: Record<string, unknown>,
): UpdateRecord {
  return {
    runId: ctx.runId,
    trialId: `audit-${address.mode}`,
    taskId: "audit",
    mode: address.mode as ExperimentMode,
    step: address.step,
    kind: address.kind,
    ...data,
  };
}

export function rememberCandidates(
  ctx: RunContext,
  mode: ExperimentMode,
  candidates: readonly Candidate[],
): void {
  const set = ctx.uniqueCandidates.get(mode) ?? new Set<string>();
  for (const candidate of candidates) set.add(candidate.id);
  ctx.uniqueCandidates.set(mode, set);
}

export function countDecisions(ctx: RunContext, mode: ExperimentMode, count: number): void {
  ctx.decisionCounts.set(mode, (ctx.decisionCounts.get(mode) ?? 0) + count);
}

export function countApplied(
  ctx: RunContext,
  mode: ExperimentMode,
  applied: readonly PatchOperation[],
): void {
  const current = ctx.appliedCounts.get(mode) ?? { extractive: 0, generated: 0 };
  for (const operation of applied) {
    if (operation.origin === "extracted") current.extractive++;
    else current.generated++;
  }
  ctx.appliedCounts.set(mode, current);
}

export function operationView(operation: PatchOperation): Record<string, unknown> {
  return {
    operation: operation.operation,
    kind: operation.kind,
    sourceIds: operation.sourceIds,
    origin: operation.origin,
    trust: operation.trust,
    ...(operation.itemId ? { itemId: operation.itemId } : {}),
    ...(operation.replaces ? { replaces: operation.replaces } : {}),
  };
}

export function memoryHash(memory: WorkMemory): string {
  return createHash("sha256").update(JSON.stringify(memory)).digest("hex").slice(0, 16);
}

async function pushContext(ctx: RunContext, record: ContextRecord): Promise<void> {
  ctx.contexts.push(record);
  await writeRecord(ctx, "contexts.jsonl", (recorder) => recorder.context(record));
}

async function writeRecord(
  ctx: RunContext,
  file: string,
  write: (recorder: RunRecorder) => Promise<void>,
): Promise<void> {
  if (!ctx.recorder) return;
  try {
    await write(ctx.recorder);
  } catch (error) {
    throw new PersistenceError(
      `${file}: ${error instanceof Error ? error.message : "write_failed"}`,
    );
  }
}
