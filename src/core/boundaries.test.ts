import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("core has no imports from adapters, composition, Pi, or TypeSafe", async () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
  const violations: string[] = [];
  for (const file of files) {
    const text = await readFile(resolve(root, file), "utf8");
    violations.push(...forbiddenImports(root, file, text));
  }
  expect(violations).toEqual([]);
});

function forbiddenImports(root: string, file: string, text: string): string[] {
  const imports = text.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g);
  const specifiers = [...imports].flatMap(([, specifier]) => (specifier ? [specifier] : []));
  return specifiers
    .filter((specifier) => isForbiddenSpecifier(root, file, specifier))
    .map((specifier) => file + ": " + specifier);
}

function isForbiddenSpecifier(root: string, file: string, specifier: string): boolean {
  if (specifier.startsWith("@earendil-works/") || specifier.startsWith("@typesafe-ai/"))
    return true;
  if (!specifier.startsWith(".")) return false;
  return !resolve(root, dirname(file), specifier).startsWith(root);
}
