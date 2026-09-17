import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const directory = await mkdtemp(join(tmpdir(), "reflex-state-package-"));
try {
  const tarball = process.argv[2] ? resolve(process.argv[2]) : pack();
  checkContents(tarball);
  await install(tarball);
  await checkExtension();
  await checkCommands();
  console.log("Packaged Pi extension and export/replay commands passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}

function pack() {
  execFileSync("pnpm", ["run", "build"], { stdio: "inherit" });
  const output = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
    { encoding: "utf8" },
  );
  return join(directory, JSON.parse(output)[0].filename);
}

function checkContents(tarball) {
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  assert(files.includes("package/dist/pi/index.js"), "Package must contain the built Pi entry");
  assert(files.includes("package/dist/index.d.ts"), "Package must contain declarations");
  assert(files.includes("package/README_ja.md"), "Package must contain the Japanese README");
  assert(files.includes("package/LICENSE"), "Package must contain its license");
  assert(
    files.every((file) => !/\/src\/|\/(?:scripts|node_modules)\/|\.(?:test|spec)\./u.test(file)),
    "Package must exclude development sources, scripts, tests, and bundled dependencies",
  );
}

async function install(tarball) {
  await writeFile(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: directory, stdio: "inherit" },
  );
  const manifest = JSON.parse(
    await readFile(join(directory, "node_modules/reflex-state/package.json"), "utf8"),
  );
  assert.notEqual(manifest.private, true, "Package must be publishable");
  assert(
    manifest.keywords.includes("pi-package"),
    "Package must be discoverable in the Pi gallery",
  );
  assert.deepEqual(manifest.pi.extensions, ["./dist/pi/index.js"]);
}

async function checkExtension() {
  process.env.REFLEX_STATE_DISABLE_JEV = "1";
  process.env.PI_CODING_AGENT_DIR = directory;
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [join(directory, "node_modules/reflex-state")],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1, "Pi must discover exactly one packaged extension");
  assert(result.extensions[0].commands.has("state"), "The packaged extension must register /state");
}

async function checkCommands() {
  const source = join(directory, "session.jsonl");
  const entries = [
    { type: "session", cwd: directory },
    {
      type: "message",
      id: "u",
      parentId: null,
      message: { role: "user", content: "Run the tests", timestamp: 1 },
    },
    {
      type: "message",
      id: "a",
      parentId: "u",
      message: {
        role: "assistant",
        timestamp: 2,
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "call", name: "bash", arguments: { command: "pnpm test" } },
        ],
      },
    },
    {
      type: "message",
      id: "r",
      parentId: "a",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        timestamp: 3,
        content: [{ type: "text", text: "passed" }],
        isError: false,
      },
    },
  ];
  const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(source, original);
  runCommand("reflex-state-export", [source, "--out", "trace"]);
  runCommand("reflex-state-replay", ["trace/events.jsonl", "--updater", "noop", "--out", "replay"]);
  const state = JSON.parse(await readFile(join(directory, "replay/final_state.json"), "utf8"));
  assert.equal(state.verification.test.status, "passed");
  assert.equal(await readFile(source, "utf8"), original, "Export must preserve the source session");
}

function runCommand(name, args) {
  execFileSync(join(directory, "node_modules/.bin", name), args, {
    cwd: directory,
    env: { ...process.env, REFLEX_STATE_DISABLE_JEV: "1" },
    stdio: "pipe",
  });
}
