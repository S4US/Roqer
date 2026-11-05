import fs from "node:fs/promises";
import path from "node:path";
import type { DesktopCapturerSource } from "electron";

import type { LocalOperation, StudioCaller } from "../runtime/local-operations";
import type { McpCallOptions, McpToolImage, McpToolOutcome } from "../runtime/mcp-types";
import {
  describeRecording, MIN_PLAYTEST_RECORDING_SECONDS, RECORDING_FIELD, sheetLabels, sheetTimes,
  type PlaytestRecordingSkipped, type PlaytestRecordingSummary,
} from "../runtime/playtest-recording";
import { sheetColumns, type ClipSheetComposer } from "../runtime/reference-clip";
import { withWebmDuration } from "../runtime/webm-duration";
import type { PlaytestRecorder } from "./playtest-recorder";

/**
 * One run's playtest recordings: what happens around each playtest call.
 *
 * The engine addresses a playtest's start and stop at this wrapper instead of
 * the bridge; the wrapper makes the same bridge call, then starts recording on
 * a start that succeeded and stops on a stop or end. The recording is written
 * into the run's own folder under Roqer's data, and the stop result carries
 * where, how long, and a sheet of frames spread over it, so the planner's
 * Studio tool runner can keep the clip through the host's own file reader and
 * the model can read the frames. The folder goes with the run.
 */

export type PlaytestRecordingSessionOptions = Readonly<{
  recorder: PlaytestRecorder;
  /** The window to record, found afresh for each playtest: Studio may have been restarted. */
  findSource: () => Promise<DesktopCapturerSource | undefined>;
  composeSheet: ClipSheetComposer;
  /** The run's own folder for its recordings, made on first use and removed on dispose. */
  directory: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class PlaytestRecordingSession {
  readonly #options: PlaytestRecordingSessionOptions;
  /** Why the last start recorded nothing, for the stop that follows it. */
  #skipped: PlaytestRecordingSkipped | undefined;
  #recordings = 0;
  #disposed = false;

  constructor(options: PlaytestRecordingSessionOptions) {
    this.#options = options;
  }

  /** The local operation that stands in for one playtest tool. */
  wrap(tool: string): LocalOperation {
    return (args, options, studio) => this.around(tool, args, options, studio);
  }

  async around(tool: string, args: Record<string, unknown>, options: McpCallOptions, studio: StudioCaller): Promise<McpToolOutcome> {
    const outcome = await studio(tool, args, options);
    if (this.#disposed) return outcome;
    if (args.action === "start") {
      if (!outcome.ok) return outcome;
      const started = await this.#options.recorder.start(this.#options.findSource);
      this.#skipped = started.started ? undefined : { skipped: started.reason };
      const note = started.started
        ? "[Roqer is recording the Studio window for this playtest; its frames come back with the stop result.]"
        : `[Roqer could not record this playtest: ${started.reason === "no-window" ? "no Roblox Studio window was found" : "the window capture failed"}. Check it with screenshots and logs.]`;
      return { ...outcome, text: outcome.text === "" ? note : `${outcome.text}\n\n${note}` };
    }
    if (args.action !== "stop" && args.action !== "end") return outcome;
    const recording = await this.#finish();
    if (!outcome.ok || recording === undefined) return outcome;
    const data = { ...(isRecord(outcome.data) ? outcome.data : {}), [RECORDING_FIELD]: recording.summary };
    const text = describeRecording(recording.summary, recording.sheet !== undefined);
    return {
      ...outcome,
      data,
      text: outcome.text === "" ? text : `${outcome.text}\n\n${text}`,
      ...(recording.sheet === undefined ? {} : { images: [recording.sheet, ...(outcome.images ?? [])] }),
    };
  }

  /** Stop the recorder and keep what it recorded; the reason when it kept nothing. */
  async #finish(): Promise<{ summary: PlaytestRecordingSummary | PlaytestRecordingSkipped; sheet?: McpToolImage } | undefined> {
    const { recorder } = this.#options;
    if (!recorder.recording) {
      const skipped = this.#skipped;
      this.#skipped = undefined;
      return skipped === undefined ? undefined : { summary: skipped };
    }
    const meta = await recorder.stop();
    try {
      if (meta === undefined) return { summary: { skipped: "capture-failed" } };
      if (meta.durationSeconds < MIN_PLAYTEST_RECORDING_SECONDS || meta.bytes === 0) return { summary: { skipped: "too-short" } };
      const bytes = await recorder.bytes(meta.bytes);
      if (bytes === undefined) return { summary: { skipped: "capture-failed" } };
      const times = sheetTimes(meta.durationSeconds);
      const frames = await recorder.frames(times);
      let sheet: McpToolImage | undefined;
      if (frames.length > 0) {
        sheet = await this.#options.composeSheet(frames.map((frame) => frame.jpeg), {
          columns: sheetColumns(frames.length),
          labels: sheetLabels(frames.map((frame) => frame.time)),
        }).catch(() => undefined);
      }
      await fs.mkdir(this.#options.directory, { recursive: true });
      this.#recordings += 1;
      const file = path.join(this.#options.directory, `playtest-${this.#recordings}.webm`);
      await fs.writeFile(file, withWebmDuration(bytes, meta.durationSeconds * 1000));
      const summary: PlaytestRecordingSummary = {
        path: file,
        durationSeconds: Math.round(meta.durationSeconds * 100) / 100,
        width: meta.width,
        height: meta.height,
        bytes: bytes.length,
        frames: sheet === undefined ? [] : frames.map((frame) => Math.round(frame.time * 100) / 100),
      };
      return { summary, ...(sheet === undefined ? {} : { sheet }) };
    } catch {
      return { summary: { skipped: "capture-failed" } };
    } finally {
      await recorder.clear();
    }
  }

  /** Stop any recording still going and remove the run's folder. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#options.recorder.recording) {
      await this.#options.recorder.stop();
      await this.#options.recorder.clear();
    }
    await fs.rm(this.#options.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
