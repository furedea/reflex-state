export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

export function unknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
) {
  for (const key of Object.keys(raw))
    if (!allowed.has(key)) throw new Error(`Unknown ${name} key: ${key}`);
}

export function integerField(obj: Record<string, unknown>, key: string, min: number): number {
  const number = obj[key];
  if (typeof number !== "number" || !Number.isInteger(number) || number < min)
    throw new Error(`Invalid config ${key}: expected an integer >= ${min}`);
  return number;
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** A missing list reads as empty; any other non-array value is invalid. */
export function arrayField(
  raw: Record<string, unknown>,
  key: string,
  errorMessage: string,
): unknown[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(errorMessage);
  return value as unknown[];
}

/** Undefined when absent; otherwise a copy of a list of non-blank strings. */
export function optionalStringList(
  source: Record<string, unknown>,
  key: string,
  errorMessage: string,
): string[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isNonBlankString)) throw new Error(errorMessage);
  return [...(value as string[])];
}

export function optionalFileMap(
  raw: Record<string, unknown>,
  file: string,
): Record<string, string> | undefined {
  if (raw.expectedFiles === undefined) return undefined;
  const expectedFiles = object(raw.expectedFiles, "expectedFiles");
  for (const content of Object.values(expectedFiles))
    if (typeof content !== "string") throw new Error(`Invalid expectedFiles in ${file}`);
  return expectedFiles as Record<string, string>;
}
