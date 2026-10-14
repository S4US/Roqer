/**
 * Files kept with a project rather than with one chat: a master plan, a model
 * the modeller finished, a reference picture. The user adds them by dropping
 * them in, an agent by saving its work, and every chat in the project can use
 * them. Which ones a chat has in front of it is the user's choice; an agent can
 * still list and open the rest.
 */

export type ProjectFileKind = "model" | "image" | "text" | "other";

export type ProjectFile = {
  id: string;
  /** The file's own name, as it was added. */
  name: string;
  size: number;
  kind: ProjectFileKind;
  addedAt: string;
  addedBy: "user" | "agent";
  /** The chat it came from, when it came from one. */
  chatId?: string;
  /** A line about what it is, written by whoever added it. */
  note?: string;
  /** Set once the file has been uploaded to Roblox. */
  assetId?: string;
  uploadedAt?: string;
};

export const MAX_PROJECT_FILES = 500;
export const MAX_PROJECT_FILE_BYTES = 512 * 1024 * 1024;
/** The most a 3D view or a picture loads into the window at once. */
export const MAX_VIEWABLE_FILE_BYTES = 96 * 1024 * 1024;
export const MAX_FILE_NOTE_CHARS = 300;

export const MODEL_FILE_EXTENSIONS = [".fbx", ".glb", ".gltf", ".obj"] as const;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const TEXT_EXTENSIONS = [".md", ".txt", ".lua", ".luau", ".json", ".csv", ".yaml", ".yml", ".toml", ".html", ".xml", ".rbxmx"];

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Model files Roblox's asset upload takes, so Send to Studio offers them.
 * A .gltf usually needs its separate buffers and textures, and .obj is not
 * accepted at all; both are viewed and inspected, and exported as GLB to send.
 */
export const SENDABLE_MODEL_EXTENSIONS = [".fbx", ".glb"] as const;

export function canSendToStudio(name: string): boolean {
  return (SENDABLE_MODEL_EXTENSIONS as readonly string[]).includes(extension(name));
}

export function projectFileKind(name: string): ProjectFileKind {
  const ext = extension(name);
  if ((MODEL_FILE_EXTENSIONS as readonly string[]).includes(ext)) return "model";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (TEXT_EXTENSIONS.includes(ext)) return "text";
  return "other";
}

/** The format a 3D view parses a model file as. */
export function modelFormat(name: string): "glb" | "gltf" | "fbx" | "obj" | null {
  const ext = extension(name);
  return ext === ".glb" ? "glb" : ext === ".gltf" ? "gltf" : ext === ".fbx" ? "fbx" : ext === ".obj" ? "obj" : null;
}

export function imageMediaType(name: string): string | null {
  switch (extension(name)) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isProjectFile(value: unknown): value is ProjectFile {
  return isRecord(value) &&
    typeof value.id === "string" && typeof value.name === "string" &&
    typeof value.size === "number" && typeof value.addedAt === "string" &&
    (value.kind === "model" || value.kind === "image" || value.kind === "text" || value.kind === "other") &&
    (value.addedBy === "user" || value.addedBy === "agent");
}

/** The drag payload type a project file carries between Roqer's own panels. */
export const PROJECT_FILE_DRAG_TYPE = "application/x-roqer-project-file";

export type ProjectFilesResult<T = ProjectFile[]> = { ok: true; value: T } | { ok: false; message: string };

/** What a one-click send to Studio did. `cancelled` when the user stopped it. */
export type SendToStudioResult = { ok: boolean; message: string; assetId?: string; cancelled?: true };

/**
 * The place a send goes to, as the chat sees it: its place, and whether that
 * place was chosen (pinned by the chat's earlier runs, or picked by the user)
 * rather than merely the last one used.
 */
export type SendPlace = { instanceId: string | null; chosen: boolean };

/**
 * Which open place a send inserts into, decided before anything is uploaded,
 * since an upload cannot be taken back once the insert fails. The window uses
 * it to name the place in its confirmation, and the main process again, with
 * what the bridge reports at that moment, before uploading.
 *
 * - A chosen place must be open.
 * - Otherwise there must be exactly one open place: with several, Roqer does
 *   not guess which one the model belongs in.
 */
export function chooseSendPlace(
  open: readonly { instanceId: string }[],
  place: SendPlace,
): { ok: true; instanceId: string } | { ok: false; message: string } {
  const ids = [...new Set(open.map((instance) => instance.instanceId))];
  if (place.chosen && place.instanceId !== null) {
    return ids.includes(place.instanceId)
      ? { ok: true, instanceId: place.instanceId }
      : { ok: false, message: "This chat's Studio place is not open. Open it in Studio with the Roqer plugin running, then send again. Nothing was uploaded." };
  }
  if (ids.length === 0) {
    return { ok: false, message: "No Studio place is connected. Open the place in Studio with the Roqer plugin running, then send again. Nothing was uploaded." };
  }
  if (ids.length > 1) {
    return { ok: false, message: "Several Studio places are open and this chat has none chosen. Choose its place in the Studio connection menu, then send again. Nothing was uploaded." };
  }
  return { ok: true, instanceId: ids[0] };
}
