import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

import { publicationMode, publicationNeeded } from "./release_policy.mjs";

assert(process.argv[2], "Usage: node scripts/publish_package.mjs <tested.tgz>");
const tarball = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const integrity =
  "sha512-" +
  createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64");
if (await needsPublication()) {
  const packageResponse = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`,
    {
      signal: AbortSignal.timeout(15_000),
    },
  );
  await packageResponse.body?.cancel();
  const mode = publicationMode(packageResponse.status, Boolean(process.env.NPM_BOOTSTRAP_TOKEN));
  execFileSync(
    "npm",
    [
      "publish",
      tarball,
      "--ignore-scripts",
      "--provenance",
      "--access",
      "public",
      "--tag",
      manifest.publishConfig.tag,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: mode === "bootstrap" ? process.env.NPM_BOOTSTRAP_TOKEN : "",
      },
    },
  );
} else {
  console.log("The exact tarball is already published; resuming the GitHub release.");
}
let verified = false;
for (let attempt = 0; attempt < 6; attempt++) {
  if (!(await needsPublication())) {
    verified = true;
    break;
  }
  await setTimeout(2000);
}
assert(verified, "Published tarball is not visible yet; resume this draft release later");

async function needsPublication() {
  const url = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const metadata = response.status === 200 ? await response.json() : {};
  return publicationNeeded(response.status, metadata, integrity);
}
