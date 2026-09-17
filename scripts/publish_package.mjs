import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

import { publicationMode, publicationNeeded } from "./release_policy.mjs";

if (import.meta.main) {
  assert(process.argv[2], "Usage: node scripts/publish_package.mjs <tested.tgz>");
  const tarball = resolve(process.argv[2]);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const published = await publishPackage(manifest, tarball);
  await appendFile(process.env.GITHUB_OUTPUT, `published=${published}\n`);
  if (!published) await reportManualPublication();
}

export async function publishPackage(
  manifest,
  tarball,
  { request = fetch, execute = execFileSync, delay = setTimeout } = {},
) {
  const integrity =
    "sha512-" +
    createHash("sha512")
      .update(await readFile(tarball))
      .digest("base64");
  if (!(await needsPublication(manifest, integrity, request))) {
    console.log("The exact tarball is already published; resuming the GitHub release.");
    return true;
  }
  const packageResponse = await request(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`,
    {
      signal: AbortSignal.timeout(15_000),
    },
  );
  await packageResponse.body?.cancel();
  if (publicationMode(packageResponse.status) === "manual") return false;
  execute(
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
        NODE_AUTH_TOKEN: "",
      },
    },
  );
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await needsPublication(manifest, integrity, request))) return true;
    await delay(2000);
  }
  assert.fail("Published tarball is not visible yet; resume this draft release later");
}

async function needsPublication(manifest, integrity, request) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  const response = await request(url, { signal: AbortSignal.timeout(15_000) });
  let metadata = {};
  if (response.status === 200) metadata = await response.json();
  else await response.body?.cancel();
  return publicationNeeded(response.status, metadata, integrity);
}

async function reportManualPublication() {
  const message = [
    "## First npm publication required",
    "",
    "The verified tarball, checksum, and GitHub artifact attestation are attached to the draft release.",
    "No npm publication or GitHub release completion was attempted.",
    "",
    "Publish that exact tarball locally after `npm login`, configure Trusted Publishing for",
    "`release_please.yml`, then resume this workflow with both the ref and input set to the release tag.",
    "Do not rebuild the tarball for the first publication.",
    "",
    "The first local publication has GitHub artifact attestation but no npm provenance.",
    "Subsequent publications use OIDC and include npm provenance; no npm secret is required.",
    "",
  ].join("\n");
  console.log(message);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
}
