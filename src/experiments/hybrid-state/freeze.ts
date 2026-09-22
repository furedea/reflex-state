import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { actorSystemPrompt } from "./prompts.js";
import type { ExperimentMode, HybridConfig } from "./types.js";
import { PROMPT_VERSION, PROTOCOL_ID, RESULT_SCHEMA_VERSION } from "./types.js";

const exec = promisify(execFile);
const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

/** The frozen measurement condition: everything a later run must reproduce to
 * count as the same fixed experiment. Stored outside git (e.g. under
 * .local/) so recording the post-commit hash never becomes circular. */
export interface FreezeRecord {
  readonly protocolId: typeof PROTOCOL_ID;
  readonly resultSchemaVersion: typeof RESULT_SCHEMA_VERSION;
  readonly promptVersion: string;
  readonly commit: string | null;
  readonly dirty: boolean;
  readonly configHash: string;
  readonly taskSetHash: string | null;
  readonly promptHashes: Readonly<Record<string, string>>;
  readonly node: string;
  readonly platform: string;
  readonly lockfileHash: string | null;
  readonly capturedAt: string;
}

/** sha256 over the sorted "<relative path>:<content hash>" list of every .json
 * under the task root, including the scoring directory. */
export async function taskSetHash(taskRoot: string): Promise<string> {
  const root = resolve(taskRoot);
  const entries: string[] = [];
  for (const entry of await readdir(root)) if (entry.endsWith(".json")) entries.push(entry);
  for (const entry of await readdir(join(root, "scoring")).catch(() => [] as string[]))
    if (entry.endsWith(".json")) entries.push(`scoring/${entry}`);
  const lines: string[] = [];
  for (const name of entries.sort())
    lines.push(`${name}:${sha256(await readFile(join(root, name), "utf8"))}`);
  return sha256(lines.join("\n"));
}

/** sha256 of each mode's fixed system prompt — the static part of every sent
 * request for that mode under this prompt version. */
export function promptHashes(modes: readonly ExperimentMode[]): Readonly<Record<string, string>> {
  return Object.fromEntries(modes.map((mode) => [mode, sha256(actorSystemPrompt(mode))]));
}

async function gitState(): Promise<{ readonly head: string | null; readonly dirty: boolean }> {
  try {
    const head = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim() || null;
    const dirty = (await exec("git", ["status", "--porcelain=v1"])).stdout.trim().length > 0;
    return { head, dirty };
  } catch {
    return { head: null, dirty: false };
  }
}

async function lockfileHash(): Promise<string | null> {
  const content = await readFile(resolve("pnpm-lock.yaml"), "utf8").catch(() => null);
  return content === null ? null : sha256(content);
}

/** The per-run snapshot embedded in manifests: identifies the exact code,
 * task set, prompts, and runtime a run executed under. */
interface RunSnapshot {
  readonly head: string | null;
  readonly dirty: boolean;
  readonly taskSetHash: string | null;
  readonly promptHashes: Readonly<Record<string, string>>;
  readonly node: string;
  readonly platform: string;
  readonly lockfileHash: string | null;
}

export async function snapshotForRun(config: HybridConfig): Promise<RunSnapshot> {
  const git = await gitState();
  const taskRoot = config.taskRoot;
  return {
    head: git.head,
    dirty: git.dirty,
    taskSetHash: taskRoot ? await taskSetHash(taskRoot) : null,
    promptHashes: promptHashes(config.modes),
    node: process.version,
    platform: process.platform,
    lockfileHash: await lockfileHash(),
  };
}

/** The effective (already parsed) configuration is hashed as interpreted, so a
 * syntactically different file with identical meaning does not drift. */
export async function captureFreeze(config: HybridConfig): Promise<FreezeRecord> {
  const snapshot = await snapshotForRun(config);
  return {
    protocolId: PROTOCOL_ID,
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    commit: snapshot.head,
    dirty: snapshot.dirty,
    configHash: sha256(JSON.stringify(config)),
    taskSetHash: snapshot.taskSetHash,
    promptHashes: snapshot.promptHashes,
    node: snapshot.node,
    platform: snapshot.platform,
    lockfileHash: snapshot.lockfileHash,
    capturedAt: new Date().toISOString(),
  };
}

/** Compare a frozen record against a fresh capture. A mismatch means the run
 * is a new condition, not the frozen experiment. `dirty` is compared too: a
 * dirty formal measurement is a different condition even at the same commit. */
export function verifyFreeze(
  frozen: FreezeRecord,
  current: FreezeRecord,
): { readonly ok: boolean; readonly mismatches: readonly string[] } {
  const mismatches: string[] = [];
  const field = (name: string, expected: unknown, actual: unknown) => {
    if (expected !== actual)
      mismatches.push(`${name}: frozen=${String(expected)} current=${String(actual)}`);
  };
  field("protocolId", frozen.protocolId, current.protocolId);
  field("resultSchemaVersion", frozen.resultSchemaVersion, current.resultSchemaVersion);
  field("promptVersion", frozen.promptVersion, current.promptVersion);
  field("commit", frozen.commit, current.commit);
  field("dirty", frozen.dirty, current.dirty);
  field("configHash", frozen.configHash, current.configHash);
  field("taskSetHash", frozen.taskSetHash, current.taskSetHash);
  field("lockfileHash", frozen.lockfileHash, current.lockfileHash);
  const keys = new Set([...Object.keys(frozen.promptHashes), ...Object.keys(current.promptHashes)]);
  for (const mode of keys)
    field(`promptHash.${mode}`, frozen.promptHashes[mode], current.promptHashes[mode]);
  return { ok: mismatches.length === 0, mismatches };
}
