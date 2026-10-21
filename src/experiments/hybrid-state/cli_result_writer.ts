import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RunRecorder } from "./runner.js";
import type { ExperimentManifest } from "./types.js";

export class ResultWriter {
  private constructor(private readonly directory: string) {}

  static async reserve(directory: string): Promise<ResultWriter> {
    const target = resolve(directory);
    await mkdir(resolve(target, ".."), { recursive: true });
    try {
      await mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`Output directory already exists: ${directory}`);
      throw error;
    }
    return new ResultWriter(target);
  }

  async writeManifest(manifest: ExperimentManifest): Promise<void> {
    await this.writeAtomic("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  }

  append(record: object, file: string): Promise<void> {
    return appendFile(join(this.directory, file), JSON.stringify(record) + "\n");
  }

  async writeSummary(summary: unknown): Promise<void> {
    await this.writeAtomic("summary.json", JSON.stringify(summary, null, 2) + "\n");
  }

  async writeReport(text: string): Promise<void> {
    await this.writeAtomic("report.md", text);
  }

  /** Same-directory tmp + rename so a torn write never leaves a partial file. */
  private async writeAtomic(file: string, content: string): Promise<void> {
    const target = join(this.directory, file);
    const temp = join(this.directory, `.${file}.tmp`);
    await writeFile(temp, content);
    await rename(temp, target);
  }
}

/** Serialized, awaited writes: a persistence failure is retained and propagated
 * so the run stops instead of continuing with a torn record set. */
export function recorderFor(writer: ResultWriter): RunRecorder {
  let queue: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  const enqueue = (file: string, record: object): Promise<void> => {
    if (failure) return Promise.reject(failure);
    const next = queue.then(() => writer.append(record, file));
    queue = next.catch(() => undefined);
    return next.catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error("record_write_failed");
      throw failure;
    });
  };
  return {
    callStart: (record) => enqueue("calls.jsonl", record),
    call: (record) => enqueue("calls.jsonl", record),
    context: (record) => enqueue("contexts.jsonl", record),
    update: (record) => enqueue("updates.jsonl", record),
    prompt: (record) => enqueue("system_prompts.jsonl", record),
  };
}
