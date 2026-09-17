import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

import { releasePlan } from "./release_policy.mjs";

const tagName = process.env.TAG_NAME;
const release = JSON.parse(
  execFileSync("gh", ["release", "view", tagName, "--json", "tagName,isDraft,isPrerelease"], {
    encoding: "utf8",
  }),
);
const plan = releasePlan({
  eventName: process.env.GITHUB_EVENT_NAME,
  ref: process.env.GITHUB_REF,
  sha: process.env.GITHUB_SHA,
  tagName,
  tagSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  release,
  packageJson: JSON.parse(await readFile("package.json", "utf8")),
});
await appendFile(process.env.GITHUB_OUTPUT, `version=${plan.version}\ndist_tag=${plan.distTag}\n`);
