import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("core has no imports from adapters, composition, Pi, or TypeSafe", async () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
  const violations: string[] = [];
  for (const file of files) {
    const text = await readFile(resolve(root, file), "utf8");
    const imports = text.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g);
    for (const [, specifier] of imports) {
      if (!specifier) continue;
      const local = specifier.startsWith(".") ? resolve(root, dirname(file), specifier) : undefined;
      if (
        specifier.startsWith("@earendil-works/") ||
        specifier.startsWith("@typesafe-ai/") ||
        (local !== undefined && !local.startsWith(root))
      )
        violations.push(file + ": " + specifier);
    }
  }
  expect(violations).toEqual([]);
});
