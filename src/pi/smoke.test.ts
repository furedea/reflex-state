import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { reconstruct } from "./persistence.js";

test.each(["src/pi/index.ts", ".pi/extensions/reflex_state.ts"])(
  "Pi loads %s and persists branch-correct state through its real runner",
  async (path) => {
    const directory = await mkdtemp(join(tmpdir(), "reflex-state-smoke-"));
    vi.stubEnv("REFLEX_STATE_DISABLE_JEV", "1");
    vi.stubEnv("REFLEX_STATE_DISABLE", "0");
    vi.stubEnv("REFLEX_STATE_PROJECTION", "1");
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    let dispose: (() => void) | undefined;
    try {
      const settingsManager = SettingsManager.inMemory();
      const discovered = path.startsWith(".pi/");
      if (discovered) {
        await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
        await writeFile(join(directory, path), await readFile(resolve(path), "utf8"));
        await symlink(resolve("src"), join(directory, "src"), "dir");
        settingsManager.setProjectTrusted(true);
      }
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        additionalExtensionPaths: discovered ? [] : [resolve(path)],
        noExtensions: !discovered,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Offline fixture" }],
        api: "openai-completions",
        provider: "openai",
        model: "fixture",
        timestamp: 1,
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
      const modelRuntime = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(directory, "models.json"),
        allowModelNetwork: false,
      });
      const { session, extensionsResult } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        resourceLoader: loader,
        sessionManager,
        modelRuntime,
      });
      dispose = () => session.dispose();
      expect(extensionsResult.errors).toEqual([]);
      await session.bindExtensions({});
      const runner = session.extensionRunner;
      let callIndex = 0;
      const runTool = async (toolName: string, input: Record<string, unknown>) => {
        const toolCallId = "call-" + ++callIndex;
        const tool = session.agent.state.tools.find((candidate) => candidate.name === toolName);
        if (!tool) throw new Error("Missing Pi tool: " + toolName);
        await runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input });
        let result: Pick<ToolResultEvent, "content" | "details" | "isError">;
        try {
          result = { ...(await tool.execute(toolCallId, input)), isError: false };
        } catch (error) {
          result = {
            content: [{ type: "text", text: error instanceof Error ? error.message : "failed" }],
            details: undefined,
            isError: true,
          };
        }
        await runner.emitToolResult({
          type: "tool_result",
          toolCallId,
          toolName,
          input,
          ...result,
        });
        return result;
      };
      const errors: unknown[] = [];
      runner.onError((error) => errors.push(error));
      const notifications: string[] = [];
      runner.setUIContext({
        ...runner.getUIContext(),
        notify: (message) => {
          notifications.push(message);
        },
        confirm: async () => true,
      });
      const ctx = runner.createCommandContext();
      const command = runner.getCommand("state");
      expect(command).toBeDefined();
      await runner.emitBeforeAgentStart(
        "Fix the tests",
        undefined,
        "",
        ctx.getSystemPromptOptions(),
      );
      expect(
        (
          await runTool("write", {
            path: "package.json",
            content: JSON.stringify({ private: true, scripts: { test: "node check.cjs" } }),
          })
        ).isError,
      ).toBe(false);
      expect(
        (
          await runTool("write", {
            path: "check.cjs",
            content: 'require("node:assert/strict").equal(1 + 1, 3);\n',
          })
        ).isError,
      ).toBe(false);
      expect((await runTool("bash", { command: "pnpm test" })).isError).toBe(true);
      const failedLeaf = sessionManager.getLeafId();
      expect(reconstruct(sessionManager.getBranch()).state.taskStatus).toBe("blocked");
      await command?.handler("", ctx);
      expect(notifications.at(-1)).toContain("failed");
      expect(
        (
          await runTool("edit", {
            path: "check.cjs",
            edits: [{ oldText: "1 + 1, 3", newText: "1 + 1, 2" }],
          })
        ).isError,
      ).toBe(false);
      expect((await runTool("bash", { command: "pnpm test" })).isError).toBe(false);
      const passedLeaf = sessionManager.getLeafId();
      expect(reconstruct(sessionManager.getBranch()).state.verification.test.status).toBe("passed");
      const file = sessionManager.getSessionFile()!;
      expect(reconstruct(SessionManager.open(file).getBranch()).state).toEqual(
        reconstruct(sessionManager.getBranch()).state,
      );
      expect(failedLeaf).not.toBeNull();
      sessionManager.branch(failedLeaf!);
      await runner.emit({ type: "session_tree", newLeafId: failedLeaf, oldLeafId: passedLeaf });
      await command?.handler("", ctx);
      expect(notifications.at(-1)).toContain("failed");
      const count = sessionManager.getEntries().length;
      const beforeProjection = await readFile(file, "utf8");
      const projected = await runner.emitContext([
        { role: "user", content: "Fix the tests", timestamp: 1 },
      ]);
      expect(JSON.stringify(projected)).toContain("<reflex-state>");
      expect(sessionManager.getEntries()).toHaveLength(count);
      expect(await readFile(file, "utf8")).toBe(beforeProjection);
      for (const args of [
        "history",
        "stats",
        "debug",
        "projection off",
        "projection on",
        "jev off",
      ])
        await command?.handler(args, ctx);
      await runner.emit({ type: "session_start", reason: "resume" });
      await command?.handler("reset", ctx);
      expect(reconstruct(sessionManager.getBranch()).state.goal).toBeNull();
      expect(reconstruct(SessionManager.open(file).getBranch()).state.goal).toBeNull();
      expect(sessionManager.getEntries().length).toBeGreaterThan(count);
      expect(errors).toEqual([]);
    } finally {
      dispose?.();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
