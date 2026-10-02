import fs from "node:fs/promises";
import path from "node:path";

import { JOB_RETENTION_MS } from "./model-preview";

/**
 * Textures shown in Studio before they are uploaded.
 *
 * Studio loads `rbxasset://` content from the `content` folder of its own
 * install, and a particle or beam renders a PNG placed there as it would an
 * uploaded texture. An image made in memory (an EditableImage) shows on a
 * Decal but not on a particle, so this is the one way to look at a particle
 * texture before uploading it. Every upload is irreversible and moderated.
 *
 * Checked in Studio on Windows (2026-10-02): a PNG copied into
 * `content/textures/roqer-preview` loads without a restart and plays as a
 * flipbook. Studio keeps a file's first image for the session, so a changed
 * texture needs a new name; each job's files are named after the job.
 *
 * Only Windows installs are written. On macOS the content folder is inside the
 * signed app bundle, which must not be changed.
 */

/** The folder, under an install's `content/textures`, that holds every preview and nothing else. */
export const PREVIEW_FOLDER = "roqer-preview";
export const PREVIEW_URI_PREFIX = `rbxasset://textures/${PREVIEW_FOLDER}/`;
/** Previews older than this are removed, like the job folders they came from. */
export const PREVIEW_RETENTION_MS = JOB_RETENTION_MS;
/** At most this many previews are kept in each install, newest first. */
export const MAX_KEPT_PREVIEWS = 200;
/** A preview is named `<job id>-<file stem>.png`; only names of that shape are ever removed. */
const PREVIEW_NAME = /^[0-9a-f]{8}-[A-Za-z0-9_-]{1,80}\.png$/;
const STUDIO_EXECUTABLE = "RobloxStudioBeta.exe";

/**
 * The `content` folders of the Studio installs on this computer: on Windows,
 * every `%LOCALAPPDATA%\Roblox\Versions\version-*` folder holding Studio's
 * executable. Roblox keeps one per installed version, so all are written and
 * the running Studio finds its own.
 */
export async function findStudioContentDirectories(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform !== "win32" || typeof env.LOCALAPPDATA !== "string" || env.LOCALAPPDATA === "") return [];
  const versions = path.join(env.LOCALAPPDATA, "Roblox", "Versions");
  const entries = await fs.readdir(versions, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("version-")) continue;
    const install = path.join(versions, entry.name);
    const studio = await fs.stat(path.join(install, STUDIO_EXECUTABLE)).catch(() => undefined);
    const content = await fs.stat(path.join(install, "content")).catch(() => undefined);
    if (studio?.isFile() && content?.isDirectory()) found.push(path.join(install, "content"));
  }
  return found.sort();
}

export type StudioPreview = Readonly<{ name: string; uri: string }>;

/** A file's stem made safe for a preview name: letters, digits, `_` and `-`. */
function previewStem(fileName: string): string {
  const stem = path.basename(fileName).replace(/\.png$/i, "").replace(/\.flipbook$/i, "");
  const safe = stem.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
  return safe === "" ? "texture" : safe;
}

/**
 * Copies each PNG into every install's preview folder as `<jobId>-<stem>.png`
 * and returns the `rbxasset://` address that loads it. Old previews are
 * removed first. Returns nothing when there is no install to write to.
 */
export async function stageStudioPreviews(
  files: readonly Readonly<{ name: string; path: string }>[],
  jobId: string,
  contentDirectories: readonly string[],
  now: number = Date.now(),
): Promise<StudioPreview[]> {
  if (!/^[0-9a-f]{8}$/.test(jobId)) throw new Error(`not a job id: ${jobId}`);
  if (contentDirectories.length === 0 || files.length === 0) return [];
  const previews: StudioPreview[] = [];
  const used = new Set<string>();
  for (const file of files) {
    let stem = previewStem(file.name);
    for (let n = 2; used.has(stem); n++) stem = `${previewStem(file.name)}_${n}`;
    used.add(stem);
    previews.push({ name: file.name, uri: `${PREVIEW_URI_PREFIX}${jobId}-${stem}.png` });
  }
  for (const content of contentDirectories) {
    const folder = path.join(content, "textures", PREVIEW_FOLDER);
    await fs.mkdir(folder, { recursive: true });
    await prunePreviews(folder, now);
    for (const [index, file] of files.entries()) {
      const target = path.join(folder, previews[index].uri.slice(PREVIEW_URI_PREFIX.length));
      await fs.copyFile(file.path, target);
      // A copy can keep its source's time; retention counts from staging.
      await fs.utimes(target, now / 1000, now / 1000);
    }
  }
  return previews;
}

/** Removes previews past their retention, and the oldest beyond the cap. Touches only preview-shaped names. */
export async function prunePreviews(folder: string, now: number = Date.now()): Promise<void> {
  const names = (await fs.readdir(folder).catch(() => [] as string[])).filter((name) => PREVIEW_NAME.test(name));
  const dated: Array<{ name: string; time: number }> = [];
  for (const name of names) {
    const stat = await fs.stat(path.join(folder, name)).catch(() => undefined);
    if (stat?.isFile()) dated.push({ name, time: stat.mtimeMs });
  }
  dated.sort((a, b) => b.time - a.time);
  for (const [index, entry] of dated.entries()) {
    if (index >= MAX_KEPT_PREVIEWS || now - entry.time > PREVIEW_RETENTION_MS) {
      await fs.rm(path.join(folder, entry.name), { force: true }).catch(() => undefined);
    }
  }
}
