import {
  defaultBackground, defaultSize, IMAGE_BACKGROUNDS, IMAGE_JOB_ID_PATTERN, IMAGE_KINDS, IMAGE_NAME_PATTERN, IMAGE_OPERATION, IMAGE_QUALITIES,
  IMAGE_SIZES, IMAGE_TOOL_NAME, isImageBackground, isImageJobId, isImageKind, isImageOutputName, isImageQuality, isImageSize,
  MAX_IMAGE_PROMPT_CHARACTERS, MAX_IMAGES_PER_CALL,
} from "../shared/image-generation";
import { MalformedToolCallError } from "./studio-tools";

type JsonRecord = Record<string, unknown>;

/**
 * The model-facing image tool, offered only while the user has an image source
 * on. A call becomes one `generate_image` operation in the run engine, where it
 * is classified irreversible like `generate_model`: it spends the user's key
 * or plan and sends the prompt to a third party, so it asks before running
 * outside Full auto, and a run keeps a bounded number of pictures.
 *
 * Claude Code keeps only a tool description's first 2,048 characters, so the
 * description carries the decisions and the properties carry the details.
 */
export function imageToolDefinition(): Readonly<{ name: typeof IMAGE_TOOL_NAME; description: string; inputSchema: JsonRecord }> {
  return {
    name: IMAGE_TOOL_NAME,
    description: [
      "Generate one to four PNG images with the user's configured image model: particle sprites and light textures for effects, UI icons and item art, decals and signs, and tileable surface textures.",
      "Use it for a single drawn or lit shape. Render anything that moves frame to frame (a flipbook) or needs exact geometry (an effect mesh) in Blender instead.",
      "Each call is irreversible: it spends the user's key or plan and sends the prompt to the image provider, so the user approves it outside Full auto. Ask for what the effect needs rather than probing, and iterate at most twice on one texture before drawing it in Blender or taking a Creator Store texture.",
      "Roqer does not judge the picture by eye: it measures each output (size, whether it landed as crisp drawn matter or soft light, how much is at full brightness, a ring's evenness, a tile's seams) and attaches a review sheet with transparent images shown on a dark ground. Read the measurements before using an image.",
      "To use an image: preview_in_studio shows it on a ParticleEmitter, Beam or Decal before any upload; when settled, upload_assets each file as a Decal and put its imageId in the emitter, label or decal, replacing every rbxasset preview address.",
      "Before a first call for an effect, load roblox-animation-vfx references/vfx-generated-textures.md; for UI art, roblox-ui-design references/core/assets.md.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_IMAGE_PROMPT_CHARACTERS,
          description: "One subject, centred on an empty background, filling about two thirds of the frame, in the shape's own colour: white for a texture the particle will tint. Say the style (cel, painted, soft light) and the edge (crisp or soft). No text, logos, brands, characters, scenery or drop shadows.",
        },
        kind: {
          type: "string",
          enum: [...IMAGE_KINDS],
          description: "What the image is for; it sets the default background and the checks. light: flares, glows, rings, ray bursts, on black, used with LightEmission 1. matter: slashes, puffs, bursts, debris, cracks, on transparent, crisp edges. icon: a UI icon, transparent, 512. decal: a sign, poster or picture, opaque. tile: a seamless surface, opaque, seams measured.",
        },
        background: { type: "string", enum: [...IMAGE_BACKGROUNDS], description: "Overrides the kind's default: transparent, black or opaque." },
        size: { type: "string", enum: [...IMAGE_SIZES], description: "Particle textures are 1024 square and icons 512; Roblox keeps at most 1,024 pixels a side. Defaults by kind." },
        count: { type: "integer", minimum: 1, maximum: MAX_IMAGES_PER_CALL, default: 1, description: "Variants of one prompt; compare them in the review sheet and keep one." },
        quality: { type: "string", enum: [...IMAGE_QUALITIES], description: "low for a draft, high for the settled texture; defaults to the quality set in Settings." },
        name: {
          type: "string",
          pattern: IMAGE_NAME_PATTERN,
          description: "File stem: rune_ring gives rune_ring.png and rune_ring_2.png in the job's folder; the result returns their paths for upload.",
        },
        reference: {
          type: "object",
          properties: {
            output: { type: "string", description: "An earlier output of this chat, as its result named it (jobId/file.png), to vary or edit: the composition is kept and the prompt says what changes." },
          },
          additionalProperties: false,
          description: "A picture to vary rather than draw afresh.",
        },
        preview_in_studio: {
          type: "boolean",
          description: "Copy the outputs into the user's Roblox Studio install and return an rbxasset:// address for each, so a texture can be seen on an emitter before it is uploaded. The addresses work on this computer only.",
        },
      },
      required: ["prompt", "kind", "name"],
      additionalProperties: false,
    },
  };
}

export type ImageToolArgs = Readonly<{
  prompt: string;
  kind: string;
  background: string;
  size: string;
  count: number;
  quality?: string;
  name: string;
  reference?: { output: string };
  preview_in_studio?: true;
}>;

/** The engine operation for an `image` call. Throws so every provider reports the same message. */
export function parseImageToolInput(value: unknown): { operation: string; args: JsonRecord } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedToolCallError("image requires an object with prompt, kind and name.");
  }
  const record = value as JsonRecord;
  if (typeof record.prompt !== "string" || record.prompt.trim() === "") throw new MalformedToolCallError("image requires prompt: what to draw.");
  if (record.prompt.length > MAX_IMAGE_PROMPT_CHARACTERS) throw new MalformedToolCallError(`image prompt must be at most ${MAX_IMAGE_PROMPT_CHARACTERS} characters.`);
  if (!isImageKind(record.kind)) throw new MalformedToolCallError(`image kind must be one of ${IMAGE_KINDS.join(", ")}.`);
  if (!isImageOutputName(record.name)) throw new MalformedToolCallError("image name must be a file stem of lower-case letters, digits and underscores, starting with a letter, such as rune_ring.");
  const args: JsonRecord = {
    prompt: record.prompt,
    kind: record.kind,
    background: record.background === undefined || record.background === null ? defaultBackground(record.kind) : record.background,
    size: record.size === undefined || record.size === null ? defaultSize(record.kind) : record.size,
    count: record.count === undefined || record.count === null ? 1 : record.count,
    name: record.name,
  };
  if (!isImageBackground(args.background)) throw new MalformedToolCallError(`image background must be one of ${IMAGE_BACKGROUNDS.join(", ")}.`);
  if (!isImageSize(args.size)) throw new MalformedToolCallError(`image size must be one of ${IMAGE_SIZES.join(", ")}.`);
  if (!Number.isInteger(args.count) || (args.count as number) < 1 || (args.count as number) > MAX_IMAGES_PER_CALL) {
    throw new MalformedToolCallError(`image count must be a whole number from 1 to ${MAX_IMAGES_PER_CALL}.`);
  }
  if (record.quality !== undefined && record.quality !== null) {
    if (!isImageQuality(record.quality)) throw new MalformedToolCallError(`image quality must be one of ${IMAGE_QUALITIES.join(", ")}.`);
    args.quality = record.quality;
  }
  if (record.reference !== undefined && record.reference !== null) {
    const reference = record.reference;
    if (typeof reference !== "object" || Array.isArray(reference) || typeof (reference as JsonRecord).output !== "string") {
      throw new MalformedToolCallError("image reference must be {output: 'jobId/file.png'}, an earlier output of this chat as its result named it.");
    }
    const output = (reference as JsonRecord).output as string;
    const [jobId, file, ...rest] = output.split("/");
    if (rest.length > 0 || !isImageJobId(jobId) || !/^[a-z][a-z0-9_]{0,31}(_\d+)?\.png$/.test(file ?? "")) {
      throw new MalformedToolCallError(`image reference.output must be jobId/file.png, with the job id as its result gave it (${IMAGE_JOB_ID_PATTERN}).`);
    }
    args.reference = { output };
  }
  if (record.preview_in_studio !== undefined && record.preview_in_studio !== null) {
    if (typeof record.preview_in_studio !== "boolean") throw new MalformedToolCallError("image preview_in_studio must be true or false.");
    if (record.preview_in_studio) args.preview_in_studio = true;
  }
  return { operation: IMAGE_OPERATION, args };
}
