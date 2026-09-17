import assert from "node:assert/strict";
import { test } from "node:test";

import { publicationMode, publicationNeeded, releasePlan } from "./release_policy.mjs";

function candidate() {
  return {
    eventName: "push",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    tagName: "v0.1.0-alpha.1",
    tagSha: "a".repeat(40),
    release: { tagName: "v0.1.0-alpha.1", isDraft: true, isPrerelease: true },
    packageJson: { name: "reflex-state", version: "0.1.0-alpha.1", publishConfig: { tag: "next" } },
  };
}

await test("a preview draft built from the workflow commit publishes only to next", () => {
  assert.deepEqual(releasePlan(candidate()), { version: "0.1.0-alpha.1", distTag: "next" });
});

await test("recovery runs must start on the exact release tag", () => {
  const input = { ...candidate(), eventName: "workflow_dispatch" };
  assert.throws(() => releasePlan(input), /run.*tag/iu);
  input.ref = "refs/tags/" + input.tagName;
  assert.equal(releasePlan(input).distTag, "next");
});

await test("a different checkout cannot be attested as the workflow source", () => {
  assert.throws(() => releasePlan({ ...candidate(), tagSha: "b".repeat(40) }), /commit/iu);
});

await test("published releases and mismatched package versions cannot be modified", () => {
  const published = candidate();
  published.release.isDraft = false;
  assert.throws(() => releasePlan(published), /draft/iu);
  assert.throws(() => releasePlan({ ...candidate(), tagName: "v0.2.0" }), /version|tag/iu);
});

await test("stable releases require matching GitHub and npm channels", () => {
  const input = candidate();
  input.packageJson.version = "0.1.0";
  input.tagName = "v0.1.0";
  input.release.tagName = input.tagName;
  assert.throws(() => releasePlan(input), /prerelease|channel/iu);
  input.release.isPrerelease = false;
  assert.throws(() => releasePlan(input), /channel/iu);
  input.packageJson.publishConfig.tag = "latest";
  assert.equal(releasePlan(input).distTag, "latest");
});

await test("publication resumes only when the registry contains the exact tested tarball", () => {
  assert.equal(publicationNeeded(404, {}, "sha512-expected"), true);
  assert.equal(
    publicationNeeded(200, { dist: { integrity: "sha512-expected" } }, "sha512-expected"),
    false,
  );
  assert.throws(
    () => publicationNeeded(200, { dist: { integrity: "sha512-different" } }, "sha512-expected"),
    /different/iu,
  );
  assert.throws(() => publicationNeeded(503, {}, "sha512-expected"), /registry/iu);
});

await test("a new npm package waits for manual publication without a CI credential", () => {
  assert.equal(publicationMode(404), "manual");
  assert.equal(publicationMode(200), "oidc");
  assert.throws(() => publicationMode(503), /registry/iu);
});
