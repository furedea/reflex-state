import type {
  ActionForm,
  ActorAction,
  ActorRequest,
  JevAnswer,
  JevQuestion,
  MemoryKind,
  PatchInputKind,
  PatchOperation,
} from "./types.js";

const MEMORY_KINDS = new Set<MemoryKind>([
  "constraints",
  "decisions",
  "findings",
  "attempts",
  "open_questions",
]);

const ACTION_TOOLS = new Set(["read", "write", "edit", "test", "finish"]);

const ACTION_REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["path"],
  write: ["path", "content"],
  edit: ["path", "old", "new"],
  test: ["command"],
  finish: [],
};

const ACTION_FIELDS = ["path", "content", "old", "new", "command"];

const TRUSTS = new Set(["user", "assistant", "tool_result", "unknown"]);

const OPERATION_KEYS = new Set([
  "operation",
  "itemId",
  "kind",
  "text",
  "sourceIds",
  "trust",
  "origin",
  "replaces",
]);

type OperationRecord = Record<string, unknown>;

/** Field checks in the order their failures are reported. */
const OPERATION_CHECKS: ReadonlyArray<readonly [string, (op: OperationRecord) => boolean]> = [
  ["kind", (op) => typeof op.kind === "string" && MEMORY_KINDS.has(op.kind as MemoryKind)],
  ["text", (op) => typeof op.text === "string" && op.text.trim() !== ""],
  [
    "sourceIds",
    (op) =>
      Array.isArray(op.sourceIds) &&
      op.sourceIds.length > 0 &&
      op.sourceIds.every((id) => typeof id === "string" && id.trim()),
  ],
  ["origin", (op) => op.origin === "extracted" || op.origin === "generated"],
  ["trust", (op) => op.trust === undefined || TRUSTS.has(op.trust as string)],
];

export function decodeAnswers(response: unknown, questions: readonly JevQuestion[]): JevAnswer[] {
  const root = record(response);
  const answers = record(root.answers);
  return questions.map((question) => {
    const raw = answers[question.id];
    if (raw === undefined)
      return { questionId: question.id, choice: "", invalid: "missing_answer" };
    return decodeAnswer(question, raw);
  });
}

export function decodeActorResponse(
  text: string,
  mode: ActorRequest["mode"],
): {
  readonly action: ActorAction;
  readonly actionForm: ActionForm;
  readonly statePatch?: readonly PatchOperation[];
  readonly patchInput?: PatchInputKind;
  readonly text?: string;
} {
  const value = parseJsonObject(text);
  const normalized = normalizeAction(value);
  if (!normalized) throw new Error("actor_action_invalid");
  const visible = typeof value.text === "string" && value.text.trim() ? value.text : undefined;
  const head = { action: normalized.action, actionForm: normalized.form };
  const tail = visible ? { text: visible } : {};
  if (mode !== "llm") return { ...head, ...tail };
  return { ...head, ...decodeStatePatch(value), ...tail };
}

export function decodeOperationsEnvelope(text: string): PatchOperation[] {
  const value = parseJsonObject(text);
  if (!("operations" in value)) throw new Error("operations_missing");
  return decodeOperationsArray(value.operations);
}

export function decodeOperationsArray(value: unknown): PatchOperation[] {
  if (!Array.isArray(value)) throw new Error("operations_not_array");
  return value.map(decodeOperation);
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_response_shape");
  return value as Record<string, unknown>;
}

function decodeAnswer(question: JevQuestion, raw: unknown): JevAnswer {
  try {
    return decodeAnswerFields(question, record(raw));
  } catch {
    return invalid(question.id, "answer_shape");
  }
}

function decodeAnswerFields(question: JevQuestion, answer: Record<string, unknown>): JevAnswer {
  const choice = answer.choice;
  const confidence = answer.confidence;
  const probabilities = record(answer.probabilities);
  if (typeof choice !== "string" || !choice) return invalid(question.id, "choice_type");
  if (!isProbability(confidence)) return invalid(question.id, "confidence_type");
  const labelsValid = Object.keys(question.options).every((label) =>
    isProbability(probabilities[label]),
  );
  if (!labelsValid) return invalid(question.id, "probabilities_type");
  const probability = probabilities[choice];
  return {
    questionId: question.id,
    choice,
    ...(typeof probability === "number" ? { probability } : {}),
    confidence,
  };
}

function invalid(questionId: string, reason: string): JevAnswer {
  return { questionId, choice: "", invalid: reason };
}

/** A missing patch means "no memory update this step"; an invalid patch
 * still fails so malformed operations are never silently dropped. The
 * tri-state keeps "missing" distinct from an explicit empty array. */
function decodeStatePatch(value: Record<string, unknown>): {
  readonly statePatch: PatchOperation[];
  readonly patchInput: PatchInputKind;
} {
  const patchInput = patchInputKind(value);
  const statePatch = patchInput === "missing" ? [] : decodeOperationsArray(value.statePatch);
  return { statePatch, patchInput };
}

function patchInputKind(value: Record<string, unknown>): PatchInputKind {
  if (!("statePatch" in value)) return "missing";
  return Array.isArray(value.statePatch) && value.statePatch.length === 0 ? "empty" : "present";
}

function decodeOperation(item: unknown, index: number): PatchOperation {
  const at = `operations[${index}]`;
  const op = recordField(item, at);
  const operation = op.operation;
  if (operation !== "add" && operation !== "replace") throw new Error(`${at}.operation_invalid`);
  for (const [field, isValid] of OPERATION_CHECKS)
    if (!isValid(op)) throw new Error(`${at}.${field}_invalid`);
  const unknownKey = Object.keys(op).find((key) => !OPERATION_KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`${at}.unknown_field:${unknownKey}`);
  return {
    operation,
    ...(typeof op.itemId === "string" ? { itemId: op.itemId } : {}),
    kind: op.kind as MemoryKind,
    text: op.text as string,
    sourceIds: [...(op.sourceIds as string[])],
    trust: (op.trust as PatchOperation["trust"]) ?? "unknown",
    origin: op.origin as PatchOperation["origin"],
    ...(typeof op.replaces === "string" ? { replaces: op.replaces } : {}),
  };
}

/** The action may arrive as the canonical nested object
 * `{"action":{"tool":...}}`, as a tool-name string with the parameters at the
 * envelope level `{"action":"read","path":"x"}`, or as a bare tool object
 * `{"tool":"read","path":"x"}`; all decode to the same validated action.
 * Anything else is invalid. */
function normalizeAction(
  value: Record<string, unknown>,
): { readonly action: ActorAction; readonly form: ActionForm } | undefined {
  if (typeof value.action === "string" && ACTION_TOOLS.has(value.action)) {
    const action = decodeAction(pickActionFields(value, value.action));
    return action ? { action, form: "shorthand" } : undefined;
  }
  if (typeof value.tool === "string") {
    const action = decodeAction(pickActionFields(value, value.tool));
    return action ? { action, form: "bare" } : undefined;
  }
  const action = decodeAction(value.action);
  return action ? { action, form: "canonical" } : undefined;
}

function pickActionFields(value: Record<string, unknown>, tool: string) {
  return {
    tool,
    path: value.path,
    content: value.content,
    old: value.old,
    new: value.new,
    command: value.command,
  };
}

function decodeAction(value: unknown): ActorAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const tool = fields.tool;
  if (typeof tool !== "string" || !ACTION_TOOLS.has(tool)) return undefined;
  const required = ACTION_REQUIRED_FIELDS[tool] ?? [];
  if (!required.every((name) => typeof fields[name] === "string")) return undefined;
  if (Object.keys(fields).some((key) => key !== "tool" && !ACTION_FIELDS.includes(key)))
    return undefined;
  const present = ACTION_FIELDS.filter((name) => typeof fields[name] === "string");
  return {
    tool,
    ...Object.fromEntries(present.map((name) => [name, fields[name]])),
  } as ActorAction;
}

function recordField(value: unknown, name: string): Record<string, unknown> {
  try {
    return record(value);
  } catch {
    throw new Error(`${name}_invalid`);
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const candidate = extractFirstJsonObject(text);
  if (candidate === null) throw new Error("response_invalid_json");
  const value: unknown = JSON.parse(candidate);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("response_invalid_object");
  return value as Record<string, unknown>;
}

interface JsonScan {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

/** The first balanced `{...}` span, string-aware so braces inside strings do
 * not count. Responses wrapped in prose, markdown fences, or followed by
 * extra content are still decoded against the first complete object. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const scan: JsonScan = { depth: 0, inString: false, escaped: false };
  for (let i = start; i < text.length; i++) {
    advanceJsonScan(scan, text[i]);
    if (scan.depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function advanceJsonScan(scan: JsonScan, ch: string | undefined): void {
  if (scan.inString) {
    advanceInString(scan, ch);
    return;
  }
  if (ch === '"') scan.inString = true;
  else if (ch === "{") scan.depth++;
  else if (ch === "}") scan.depth--;
}

function advanceInString(scan: JsonScan, ch: string | undefined): void {
  if (scan.escaped) scan.escaped = false;
  else if (ch === "\\") scan.escaped = true;
  else if (ch === '"') scan.inString = false;
}
