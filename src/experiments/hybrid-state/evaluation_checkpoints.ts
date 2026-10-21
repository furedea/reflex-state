import type {
  CheckpointItemResult,
  CheckpointRequirement,
  CheckpointResult,
  TaskCheckpoint,
} from "./types.js";

export function scoreCheckpoints(
  checkpoints: readonly TaskCheckpoint[],
  sentTexts: readonly string[],
  failureObserved: boolean,
): readonly CheckpointResult[] {
  return checkpoints.map((checkpoint) => {
    const step = checkpoint.at === "final" ? sentTexts.length - 1 : checkpoint.at;
    const items: CheckpointItemResult[] = checkpoint.required.map((item) => {
      if (checkpoint.appliesWhen === "failure_observed" && !failureObserved)
        return { id: item.id, retained: null, reason: "not_applicable" };
      const text = sentTexts[step];
      if (text === undefined) return { id: item.id, retained: null, reason: "step_not_reached" };
      return evaluateRequirement(item, text);
    });
    return { checkpointId: checkpoint.id, step, items };
  });
}

/**
 * Checkpoint evaluation on the input actually sent at the checkpoint step.
 * Typed information (latest verification, values) is compared structurally;
 * prose is retained only inside a provenance-eligible item that carries the
 * canonical text without inverting it. Paraphrases that cannot be verified
 * stay needs_semantic_review. It never judges by substring overlap alone.
 */
function evaluateRequirement(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  if (item.kind === "verification") return evaluateVerification(item, sentText);
  if (item.kind === "exact_value") return evaluateExactValue(item, sentText);
  return evaluateVerbatim(item, sentText);
}

interface SentItem {
  readonly section: string;
  readonly text: string;
  readonly role?: string;
  readonly toolName?: string;
  readonly memoryKind?: string;
  readonly trust?: string;
}

type SentJson = Record<string, unknown>;

/** Itemize the sent input into provenance-bearing units: memory items,
 * observation items, history lines, the instruction, and the facts blob. */
function extractItems(sentText: string, sections?: readonly string[]): SentItem[] {
  const parsed = parseSentJson(sentText);
  if (!parsed) return [{ section: "raw", text: sentText }];
  const take = (name: string) => !sections?.length || sections.includes(name);
  const extractors: { readonly [name: string]: (parsed: SentJson) => SentItem[] } = {
    instruction: instructionItems,
    memory: memoryItems,
    latest_observation: observationItems,
    history: (json) => (typeof json.history === "string" ? historyItems(json.history) : []),
    facts: factsItems,
  };
  return Object.entries(extractors)
    .filter(([name]) => take(name))
    .flatMap(([, extract]) => extract(parsed));
}

function instructionItems(parsed: SentJson): SentItem[] {
  if (typeof parsed.instruction !== "string") return [];
  return [{ section: "instruction", role: "user", text: parsed.instruction }];
}

function factsItems(parsed: SentJson): SentItem[] {
  if (parsed.facts === undefined) return [];
  return [{ section: "facts", text: JSON.stringify(parsed.facts) }];
}

function memoryItems(parsed: SentJson): SentItem[] {
  return textRecords(parsed.memory).map((record) => ({
    section: "memory",
    text: record.text as string,
    ...(typeof record.kind === "string" ? { memoryKind: record.kind } : {}),
    ...(typeof record.trust === "string" ? { trust: record.trust } : {}),
  }));
}

function observationItems(parsed: SentJson): SentItem[] {
  return textRecords(parsed.latest_observation).map((record) => ({
    section: "latest_observation",
    text: record.text as string,
    ...(typeof record.role === "string" ? { role: record.role } : {}),
  }));
}

/** Entries of `group.items` that carry a string `text`. */
function textRecords(group: unknown): SentJson[] {
  if (!group || typeof group !== "object") return [];
  const entries = (group as { items?: unknown }).items;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry) => typeof (entry as SentJson | null)?.text === "string",
  ) as SentJson[];
}

/** Itemize a transcript into messages, not lines: a multi-line tool result
 * keeps the role and tool name of the line that opened it, so provenance
 * survives embedded newlines inside the message text. */
function historyItems(transcript: string): SentItem[] {
  const items: SentItem[] = [];
  let current = -1;
  for (const line of transcript.split("\n")) {
    const match = /^\[([^\]]+)\] (.*)$/s.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const meta = match[1].split(/\s+/);
      items.push({
        section: "history",
        ...(meta[1] !== undefined ? { role: meta[1] } : {}),
        ...(meta[2] !== undefined ? { toolName: meta[2] } : {}),
        text: match[2],
      });
      current = items.length - 1;
    } else if (current >= 0) {
      const item = items[current]!;
      items[current] = { ...item, text: `${item.text}\n${line}` };
    } else if (line.trim()) {
      items.push({ section: "history", text: line });
    }
  }
  return items;
}

function parseSentJson(sentText: string): SentJson | null {
  try {
    const parsed: unknown = JSON.parse(sentText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SentJson;
  } catch {
    return null;
  }
}

/** A canonical phrase does not count when a negation immediately precedes it
 * in the same item ("do not use X" must not satisfy "use X"). Only the short
 * window directly before the phrase is inspected, so a negation earlier in a
 * longer passage does not produce false negatives. */
const NEGATION_PREFIX = /(?:\bnot\b|\bnever\b|n't\b|\bwithout\b|\bno longer\b)\s*$/i;
const NEGATION_WINDOW = 24;

function hasAffirmativeOccurrence(text: string, phrase: string): boolean {
  let index = text.indexOf(phrase);
  while (index >= 0) {
    if (!NEGATION_PREFIX.test(text.slice(Math.max(0, index - NEGATION_WINDOW), index))) return true;
    index = text.indexOf(phrase, index + 1);
  }
  return false;
}

/** Verbatim retention: the canonical text must appear inside one item whose
 * provenance matches the scope and which does not itself invert the meaning. */
function evaluateVerbatim(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  const items = extractItems(sentText, item.sections);
  const inverted = item.inverted ?? [];
  const scope = item.scope;
  const eligible = (entry: SentItem) =>
    !scope ||
    (entry.memoryKind !== undefined && (scope.memoryKinds ?? []).includes(entry.memoryKind)) ||
    (entry.trust !== undefined && (scope.trusts ?? []).includes(entry.trust)) ||
    (entry.role !== undefined && (scope.roles ?? []).includes(entry.role));
  const canonical = (text: string) =>
    (item.anyOf ?? []).some((group) =>
      group.every((phrase) => hasAffirmativeOccurrence(text, phrase)),
    );
  const clean = (entry: SentItem) => !inverted.some((pattern) => entry.text.includes(pattern));
  const hit = items.find((entry) => eligible(entry) && clean(entry) && canonical(entry.text));
  if (hit) {
    if (item.condition !== undefined && !hit.text.includes(item.condition))
      return { id: item.id, retained: false, reason: "condition_dropped" };
    return { id: item.id, retained: true };
  }
  if (items.some((entry) => eligible(entry) && canonical(entry.text)))
    return { id: item.id, retained: false, reason: "inverted" };
  if (items.some((entry) => canonical(entry.text)))
    return { id: item.id, retained: false, reason: "wrong_provenance" };
  if ((item.markers ?? []).some((marker) => items.some((entry) => entry.text.includes(marker))))
    return { id: item.id, retained: null, reason: "needs_semantic_review" };
  return { id: item.id, retained: false, reason: "missing" };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact typed value: the token must appear with identifier/numeric
 * boundaries, so 9377 never matches inside 19377 or 93770. When a `name` is
 * declared, the value must be bound to that name (`NAME=VALUE`), so a swapped
 * assignment such as `PRIMARY_PORT=8080` cannot satisfy `FALLBACK_PORT=8080`. */
function evaluateExactValue(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  const boundary = new RegExp(
    `(?<![0-9A-Za-z_.-])${escapeRegExp(item.value ?? "")}(?![0-9A-Za-z_.-])`,
  );
  const bound =
    item.name !== undefined
      ? new RegExp(
          `(?<![0-9A-Za-z_.-])${escapeRegExp(item.name)}\\s*[=:]\\s*${escapeRegExp(item.value ?? "")}(?![0-9A-Za-z_.-])`,
        )
      : boundary;
  const items = extractItems(sentText, item.sections);
  if (items.some((entry) => bound.test(entry.text))) return { id: item.id, retained: true };
  if ((item.markers ?? []).some((marker) => items.some((entry) => entry.text.includes(marker))))
    return { id: item.id, retained: null, reason: "needs_semantic_review" };
  return { id: item.id, retained: false, reason: "missing" };
}

const EXPERIMENT_TEST_PREFIX = "experiment test ";

/** Structured verification: the latest check for the declared test id must
 * carry the required status and freshness. In state-first inputs the facts
 * section is compared field by field; in history inputs the per-test records
 * are compared by generation and sequence. */
function evaluateVerification(item: CheckpointRequirement, sentText: string): CheckpointItemResult {
  const parsed = parseSentJson(sentText);
  if (parsed && parsed.facts !== undefined) return evaluateFactsVerification(item, parsed.facts);
  // History mode: only actual test tool results count as verification events.
  // A matching line inside an assistant explanation, a user message, or a
  // file's contents is not a check record — the evidence must be the first
  // line of a `tool_result test` message. Generation is likewise derived from
  // tool results only.
  const transcript = parsed && typeof parsed.history === "string" ? parsed.history : sentText;
  return evaluateHistoryVerification(item, historyItems(transcript));
}

interface FactsTest {
  readonly status?: unknown;
  readonly command?: unknown;
  readonly freshness?: unknown;
}

function evaluateFactsVerification(
  item: CheckpointRequirement,
  facts: unknown,
): CheckpointItemResult {
  const { id } = item;
  const testId = item.testId ?? "";
  const test = lookupFactsTest(facts, testId);
  if (!test || test.status === "not_run") return { id, retained: false, reason: "missing" };
  if (test.command !== `${EXPERIMENT_TEST_PREFIX}${testId}`)
    return { id, retained: false, reason: "wrong_test" };
  if (test.status !== (item.status ?? "passed"))
    return { id, retained: false, reason: "wrong_status" };
  if ((item.fresh ?? true) && test.freshness !== "current")
    return { id, retained: false, reason: "stale" };
  return { id, retained: true };
}

function lookupFactsTest(facts: unknown, testId: string): FactsTest | undefined {
  const verification = (
    facts as {
      verification?: {
        test?: FactsTest;
        tests?: Record<string, FactsTest>;
      };
    } | null
  )?.verification;
  // Per-test facts take precedence; the single test slot only reflects the
  // globally latest check and cannot speak for other test ids.
  return verification?.tests ? verification.tests[testId] : verification?.test;
}

interface TestRecord {
  readonly status: string;
  readonly gen: number;
  readonly seq: number;
}

function evaluateHistoryVerification(
  item: CheckpointRequirement,
  items: readonly SentItem[],
): CheckpointItemResult {
  const { id } = item;
  const latest = latestTestRecord(items, item.testId ?? "");
  if (!latest) return { id, retained: false, reason: "missing" };
  if (latest.status !== (item.status ?? "passed"))
    return { id, retained: false, reason: "wrong_status" };
  if ((item.fresh ?? true) && latest.gen < maxGeneration(items))
    return { id, retained: false, reason: "stale" };
  return { id, retained: true };
}

function toolResults(items: readonly SentItem[]): SentItem[] {
  return items.filter((entry) => entry.role === "tool_result");
}

function maxGeneration(items: readonly SentItem[]): number {
  let maxGen = -1;
  for (const entry of toolResults(items))
    for (const match of entry.text.matchAll(/gen=(\d+)/g))
      maxGen = Math.max(maxGen, Number(match[1]));
  return maxGen;
}

function latestTestRecord(items: readonly SentItem[], testId: string): TestRecord | undefined {
  const testLine = new RegExp(
    `^test ${escapeRegExp(testId)}: (passed|failed) check=\\S+ gen=(\\d+) seq=(\\d+)`,
  );
  let latest: TestRecord | undefined;
  for (const entry of toolResults(items)) {
    if (entry.toolName !== "test") continue;
    const record = parseTestRecord(testLine, entry.text);
    if (record && (!latest || isNewer(record, latest))) latest = record;
  }
  return latest;
}

function parseTestRecord(testLine: RegExp, text: string): TestRecord | undefined {
  const match = testLine.exec(text);
  if (!match?.[1]) return undefined;
  return { status: match[1], gen: Number(match[2]), seq: Number(match[3]) };
}

function isNewer(record: TestRecord, latest: TestRecord): boolean {
  return record.gen > latest.gen || (record.gen === latest.gen && record.seq > latest.seq);
}
