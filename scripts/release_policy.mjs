import assert from "node:assert/strict";

export function releasePlan(input) {
  const { eventName, ref, sha, tagName, tagSha, release, packageJson } = input;
  const { version } = packageJson;
  assert.equal(tagName, "v" + version, "Release tag must match the package version");
  assert.equal(release.tagName, tagName, "Release metadata must match the tag");
  assert.equal(release.isDraft, true, "Only draft releases can be published or resumed");
  assert.equal(tagSha, sha, "The tag and workflow must identify the same commit");
  if (eventName === "workflow_dispatch") {
    assert.equal(ref, "refs/tags/" + tagName, "Run recovery from the release tag");
  } else {
    assert.equal(eventName, "push", "Unsupported release event");
    assert.equal(ref, "refs/heads/main", "Automatic releases must run from main");
  }
  const prerelease = version.includes("-");
  const distTag = prerelease ? "next" : "latest";
  assert.equal(release.isPrerelease, prerelease, "GitHub prerelease status must match the version");
  assert.equal(packageJson.publishConfig?.tag, distTag, "npm channel must match the version");
  return { version, distTag };
}

export function publicationNeeded(status, metadata, integrity) {
  if (status === 404) return true;
  assert.equal(status, 200, "npm registry lookup failed; publication was not attempted");
  assert.equal(
    metadata.dist?.integrity,
    integrity,
    "This version already contains a different tarball",
  );
  return false;
}

export function publicationMode(packageStatus, hasBootstrapCredential) {
  if (packageStatus === 200) return "oidc";
  assert.equal(packageStatus, 404, "npm registry lookup failed; publication was not attempted");
  assert(
    hasBootstrapCredential,
    "First publication requires the temporary npm bootstrap credential",
  );
  return "bootstrap";
}
