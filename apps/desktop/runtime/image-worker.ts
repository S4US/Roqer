import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isImageBackground, isImageJobId, isImageKind, isImageQuality, isImageSize, MAX_IMAGES_PER_CALL,
  type ImageBackground, type ImageKind, type ImageQuality, type ImageSize,
} from "../shared/image-generation";
import { describeImageFacts, inspectImage, type ImageFacts } from "./image-checks";
import type { ImageRequest, ImageSource } from "./image-sources/openai-images";
import type { McpCallOptions, McpToolImage, McpToolOutcome } from "./mcp-types";
import { JOB_RETENTION_MS, MAX_KEPT_JOBS, pruneJobFolders } from "./model-preview";
import { onDarkGround, reviewSheet } from "./png-view";
import { findStudioContentDirectories, stageStudioPreviews, type StudioPreview } from "./studio-preview";

type JsonRecord = Record<string, unknown>;

/**
 * One image call: ask the source, keep what came back in a job folder beside
 * the Blender jobs, measure each picture, and show the model what it got on a
 * dark ground, because a model cannot see alpha and a white sprite on
 * transparent reads to it as a blank square.
 *
 * Roqer trusts nothing the source says about the picture: the size, the
 * family, the brightness and the seams are read from the bytes. The prompt,
 * the source and the model are written beside each file, so an upload can
 * say where its picture came from.
 */

export type ImageWorkerOptions = Readonly<{
  source: ImageSource;
  /** Where job folders go; pruned like Blender's. */
  jobsRoot: string;
  /** The chat, hashed: a reference may name only this chat's outputs. */
  scope: string;
  defaultQuality: ImageQuality;
  now?: () => number;
  /** Studio installs to stage previews into; the default looks for them. */
  studioContentDirectories?: () => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
  /** How long one call may wait on the source. */
  timeoutMs?: number;
}>;

/** Four pictures at high quality from a slow server; the operation's own budget is a little above this. */
export const DEFAULT_IMAGE_TIMEOUT_MS = 220_000;
/** A picture the model is shown must fit a tool image; a review sheet is far smaller than this. */
const MAX_PREVIEW_BYTES = 6 * 1024 * 1024;
/** A reference picture a job varies; an earlier output is never near this. */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type GeneratedFile = Readonly<{
  name: string;
  path: string;
  bytes: number;
  facts?: ImageFacts;
  problem?: string;
}>;

function failure(message: string, errorCode: string, started: number, now: () => number, data?: JsonRecord): McpToolOutcome {
  return { ok: false, data, text: message, message, errorCode, httpStatus: 200, durationMs: Math.max(0, now() - started) };
}

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

export class ImageWorker {
  private readonly options: ImageWorkerOptions;
  private readonly now: () => number;

  constructor(options: ImageWorkerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async run(args: JsonRecord, call: McpCallOptions = {}): Promise<McpToolOutcome> {
    const started = this.now();
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (prompt === "" || !isImageKind(args.kind) || typeof args.name !== "string") {
      return failure("image needs prompt, kind and name.", "invalid_arguments", started, this.now);
    }
    const kind: ImageKind = args.kind;
    const background: ImageBackground = isImageBackground(args.background) ? args.background : "transparent";
    const size: ImageSize = isImageSize(args.size) ? args.size : "1024x1024";
    const quality: ImageQuality = isImageQuality(args.quality) ? args.quality : this.options.defaultQuality;
    const count = Number.isInteger(args.count) ? Math.min(Math.max(args.count as number, 1), MAX_IMAGES_PER_CALL) : 1;
    const name = args.name;

    let reference: ImageRequest["reference"];
    if (isRecord(args.reference) && typeof args.reference.output === "string") {
      const found = await this.referenceBytes(args.reference.output);
      if (typeof found === "string") return failure(found, "reference_not_found", started, this.now);
      reference = found;
    }

    await pruneJobFolders(this.options.jobsRoot, started).catch(() => undefined);
    const jobId = randomBytes(4).toString("hex");
    const jobDirectory = path.join(this.options.jobsRoot, `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${jobId}`);
    try {
      await fs.mkdir(jobDirectory, { recursive: true });
      await fs.writeFile(path.join(jobDirectory, "job.json"), JSON.stringify({
        id: jobId, scope: this.options.scope, kind, prompt, background, size, quality, count, name,
        ...(reference === undefined ? {} : { reference: (args.reference as JsonRecord).output }),
        source: this.options.source.label,
        createdAt: new Date(started).toISOString(),
      }), "utf8");
    } catch {
      return failure("Roqer could not prepare a folder for the image job.", "job_setup_failed", started, this.now);
    }

    // A run that stopped while the folder was being prepared spends nothing.
    if (call.signal?.aborted) return failure("The image job was stopped with the run.", "cancelled", started, this.now);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS);
    const signal = call.signal === undefined ? timeout : AbortSignal.any([call.signal, timeout]);
    let generated: Awaited<ReturnType<ImageSource["generate"]>>;
    try {
      generated = await this.options.source.generate({ prompt, kind, background, size, count, quality, ...(reference === undefined ? {} : { reference }) }, signal);
    } catch (error) {
      if (call.signal?.aborted) return failure("The image job was stopped with the run.", "cancelled", started, this.now);
      if (timeout.aborted) return failure(`${this.options.source.label} did not answer within the time Roqer allows an image call.`, "image_source_timeout", started, this.now);
      return failure(error instanceof Error ? error.message : String(error), "image_source_failed", started, this.now, { jobId, jobDirectory });
    }

    const files: GeneratedFile[] = [];
    const readable: Buffer[] = [];
    for (const [index, bytes] of generated.images.slice(0, count).entries()) {
      const fileName = index === 0 ? `${name}.png` : `${name}_${index + 1}.png`;
      const filePath = path.join(jobDirectory, fileName);
      try {
        await fs.writeFile(filePath, bytes);
        await fs.writeFile(filePath.replace(/\.png$/, ".json"), JSON.stringify({
          jobId, file: fileName, prompt, kind, background, size, quality, source: this.options.source.label, model: generated.model,
          ...(generated.revisedPrompt === undefined ? {} : { revisedPrompt: generated.revisedPrompt }),
          ...(reference === undefined ? {} : { reference: (args.reference as JsonRecord).output }),
          createdAt: new Date(started).toISOString(),
        }, null, 2), "utf8");
      } catch {
        return failure("Roqer could not write the images the source sent.", "job_write_failed", started, this.now, { jobId, jobDirectory });
      }
      const inspected = inspectImage(bytes, kind);
      files.push({ name: fileName, path: filePath, bytes: bytes.length, ...("facts" in inspected ? { facts: inspected.facts } : { problem: inspected.problem }) });
      if ("facts" in inspected) readable.push(bytes);
    }

    const images: McpToolImage[] = [];
    if (readable.length === 1) {
      const shown = onDarkGround(readable[0]) ?? readable[0];
      if (shown.length <= MAX_PREVIEW_BYTES) images.push({ data: shown.toString("base64"), mediaType: "image/png" });
    } else if (readable.length > 1) {
      const sheet = reviewSheet(readable);
      if (sheet !== undefined && sheet.png.length <= MAX_PREVIEW_BYTES) images.push({ data: sheet.png.toString("base64"), mediaType: "image/png" });
    }

    const lines: string[] = [
      `Image job ${jobId}: ${files.length} image${files.length === 1 ? "" : "s"} from ${this.options.source.label} (${generated.model}) for kind ${kind}, ${size}, ${background} background, quality ${quality}.`,
      "Files, each named jobId/file for reference.output:",
      ...files.map((file) => `- ${jobId}/${file.name}: ${file.path}`),
    ];
    if (generated.revisedPrompt !== undefined) lines.push(`The server drew from this rewording of the prompt: ${generated.revisedPrompt}`);
    for (const file of files) {
      if (file.facts !== undefined) lines.push(...describeImageFacts(file.name, file.facts, kind));
      else lines.push(`${file.name}: could not be read as a PNG (${file.problem}); do not use it.`);
    }
    if (images.length > 0) {
      lines.push(readable.length === 1
        ? "The picture is attached, with any transparency shown over a dark ground, as it will glow in the game."
        : "A review sheet of the pictures is attached, in file order, each over a dark ground.");
    }

    let studioPreviews: StudioPreview[] = [];
    if (args.preview_in_studio === true) {
      const textures = files.filter((file) => file.facts !== undefined).map((file) => ({ name: file.name, path: file.path }));
      try {
        const installs = await (this.options.studioContentDirectories ?? (() => findStudioContentDirectories(this.options.env ?? process.env)))();
        studioPreviews = await stageStudioPreviews(textures, jobId, installs, this.now());
        if (installs.length === 0) {
          lines.push("No Roblox Studio install was found to preview in (previews work with Studio on Windows). Upload the images to see them in Studio.");
        } else if (studioPreviews.length > 0) {
          lines.push(
            "Previews in Studio, before any upload. Each address works on this computer only:",
            ...studioPreviews.map((preview) => `- ${preview.name}: ${preview.uri}`),
            "Set ParticleEmitter.Texture (or a Beam's or Decal's Texture) to an address to see it in Studio as players would. Once settled, upload the set in one upload_assets call (each as a Decal) and replace every rbxasset://textures/roqer-preview/ address with rbxassetid://<imageId>.",
          );
        }
      } catch (error) {
        lines.push(`The images could not be copied into Studio for a preview: ${error instanceof Error ? error.message : String(error)}. Upload them to see them in Studio.`);
      }
    } else {
      lines.push("To see one on a particle in Studio before uploading, call again with preview_in_studio: true, or upload the settled set with upload_assets as Decals and use each imageId.");
    }
    lines.push(`Job folders are cleared after ${JOB_RETENTION_MS / 86_400_000} days or once ${MAX_KEPT_JOBS} newer jobs exist; upload what you keep.`);

    return {
      ok: true,
      data: {
        jobId,
        jobDirectory,
        model: generated.model,
        ...(generated.revisedPrompt === undefined ? {} : { revisedPrompt: generated.revisedPrompt }),
        images: files.map((file) => ({
          name: file.name, path: file.path, bytes: file.bytes,
          ...(file.facts === undefined ? { problem: file.problem } : {
            width: file.facts.width, height: file.facts.height, family: file.facts.family,
            fullBrightShare: Math.round(file.facts.fullBrightShare * 1000) / 1000,
            ...(file.facts.seam === undefined ? {} : { seam: Math.round(file.facts.seam * 1000) / 1000 }),
          }),
        })),
        ...(studioPreviews.length > 0 ? { studioPreviews } : {}),
      },
      text: lines.join("\n"),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { pictured: { name: files[0].name } } : {}),
      httpStatus: 200,
      durationMs: Math.max(0, this.now() - started),
    };
  }

  /** The bytes of an earlier output of this chat, named `jobId/file.png`; or why not. */
  private async referenceBytes(output: string): Promise<ImageRequest["reference"] | string> {
    const [jobId, file] = output.split("/");
    if (!isImageJobId(jobId) || typeof file !== "string" || !/^[a-z][a-z0-9_]{0,31}(_\d+)?\.png$/.test(file)) {
      return "reference.output must name an earlier output of this chat as jobId/file.png.";
    }
    const entries = await fs.readdir(this.options.jobsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(`-${jobId}`)) continue;
      const directory = path.join(this.options.jobsRoot, entry.name);
      const job = await fs.readFile(path.join(directory, "job.json"), "utf8").then((text) => JSON.parse(text) as unknown).catch(() => undefined);
      if (!isRecord(job) || job.id !== jobId || job.scope !== this.options.scope) continue;
      const filePath = path.join(directory, file);
      const info = await fs.stat(filePath).catch(() => undefined);
      if (info === undefined || !info.isFile() || info.size > MAX_REFERENCE_BYTES) break;
      const bytes = await fs.readFile(filePath).catch(() => undefined);
      if (bytes === undefined || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) break;
      return { bytes, name: file };
    }
    return `There is no image ${output} in this chat's jobs: name an earlier result's jobId/file.png, or leave reference out to draw afresh. Job folders are cleared after ${JOB_RETENTION_MS / 86_400_000} days or once ${MAX_KEPT_JOBS} newer jobs exist.`;
  }
}
