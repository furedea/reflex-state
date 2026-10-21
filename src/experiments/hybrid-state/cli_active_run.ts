import { startManifest } from "./cli_manifest.js";
import type { ResultWriter } from "./cli_result_writer.js";
import { reportMarkdown } from "./evaluation.js";
import { PersistenceError, type ExperimentRun } from "./runner.js";
import type { ExperimentManifest, HybridConfig } from "./types.js";

/** A run writing into a reserved result directory: it owns the started
 * manifest so a later failure can be recorded on it. */
export class ActiveRun {
  private started: ExperimentManifest | undefined;

  constructor(
    readonly config: HybridConfig,
    readonly writer: ResultWriter,
    readonly runId: string,
  ) {}

  async start(input: string): Promise<void> {
    this.started = startManifest(this.config, this.runId, input);
    await this.writer.writeManifest(this.started);
  }

  /** Runs end with summary and report persisted before the completed manifest is
   * finalized; a persistence failure leaves status "failed", never "completed". */
  async finalize(result: ExperimentRun): Promise<void> {
    await this.writer.writeSummary(result.summary);
    await this.writer.writeReport(reportMarkdown(result.summary, result.manifest));
    await this.writer.writeManifest({
      ...result.manifest,
      status: "completed",
      startedAt: this.started?.startedAt ?? result.manifest.startedAt,
      finishedAt: new Date().toISOString(),
    });
    console.log(`new run executed: ${result.summary.runId}`);
    console.log(JSON.stringify(result.summary, null, 2));
  }

  async recordFailure(error: unknown): Promise<void> {
    if (!this.started) return;
    const failed: ExperimentManifest = {
      ...this.started,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "run_failed",
      failedStage: error instanceof PersistenceError ? "recording" : "execution",
    };
    await this.writer.writeManifest(failed).catch(() => undefined);
  }
}
