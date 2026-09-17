import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import { publishPackage } from "./publish_package.mjs";

const directory = await mkdtemp(join(tmpdir(), "reflex-state-publication-"));
after(() => rm(directory, { recursive: true, force: true }));
const tarball = join(directory, "reflex-state-0.1.0-alpha.1.tgz");
const bytes = Buffer.from("the verified package bytes");
await writeFile(tarball, bytes);
const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
const manifest = {
  name: "reflex-state",
  version: "0.1.0-alpha.1",
  publishConfig: { tag: "next" },
};

void test("an unpublished package stays pending without invoking npm", async () => {
  const io = registry(404, 404);
  assert.equal(await publishPackage(manifest, tarball, io), false);
  assert.equal(io.execute.mock.callCount(), 0);
});

void test("OIDC publishes the verified tarball to the preview channel with provenance", async () => {
  const io = registry(404, 200, { dist: { integrity } });
  io.execute = mock.fn();
  assert.equal(await publishPackage(manifest, tarball, io), true);
  assert.equal(io.execute.mock.callCount(), 1);
  const [command, args, options] = io.execute.mock.calls[0].arguments;
  assert.equal(command, "npm");
  assert.deepEqual(args.slice(0, 2), ["publish", tarball]);
  assert(args.includes("--provenance"));
  assert(args.includes("--ignore-scripts"));
  assert.equal(args[args.indexOf("--access") + 1], "public");
  assert.equal(args[args.indexOf("--tag") + 1], "next");
  assert.equal(options.env.NODE_AUTH_TOKEN, "");
});

void test("the exact manually published tarball permits recovery without republishing", async () => {
  const io = registry({ dist: { integrity } });
  assert.equal(await publishPackage(manifest, tarball, io), true);
  assert.equal(io.execute.mock.callCount(), 0);
});

void test("a different published tarball prevents release completion", async () => {
  const io = registry({ dist: { integrity: "sha512-different" } });
  await assert.rejects(publishPackage(manifest, tarball, io), /different/iu);
  assert.equal(io.execute.mock.callCount(), 0);
});

void test("registry failures never trigger publication or a manual-publication fallback", async () => {
  for (const responses of [[503], [404, 503]]) {
    const io = registry(...responses);
    await assert.rejects(publishPackage(manifest, tarball, io), /registry/iu);
    assert.equal(io.execute.mock.callCount(), 0);
  }
});

void test("failed OIDC authentication prevents release completion", async () => {
  const io = registry(404, 200);
  io.execute = mock.fn(() => {
    throw new Error("OIDC authentication failed");
  });
  await assert.rejects(publishPackage(manifest, tarball, io), /OIDC authentication failed/u);
});

void test("publication is incomplete until the registry serves the verified bytes", async () => {
  const io = registry(404, 200, ...Array(6).fill(404));
  io.execute = mock.fn();
  await assert.rejects(publishPackage(manifest, tarball, io), /not visible/iu);
});

function registry(...responses) {
  return {
    request: async () => {
      assert(responses.length > 0, "Unexpected registry request");
      const response = responses.shift();
      const status = typeof response === "number" ? response : 200;
      const metadata = typeof response === "number" ? {} : response;
      return new Response(JSON.stringify(metadata), { status });
    },
    execute: mock.fn(() => assert.fail("npm must not be invoked")),
    delay: async () => {},
  };
}
