import fs from "node:fs";
import path from "node:path";

/**
 * Where Roqer's data lived before the app had a product name of its own.
 *
 * Electron names the data folder after the app, and until the package was
 * renamed the app's name was its npm package name, "@chrrxs/studio-workbench"
 * (the scope becomes a folder level). Installed builds used it too, because
 * the packaged manifest carried no product name. It is now "Roqer".
 */
export const PREVIOUS_USER_DATA_SEGMENTS = ["@chrrxs", "studio-workbench"] as const;

type FileSystem = Pick<typeof fs, "existsSync" | "readdirSync" | "mkdirSync" | "rmdirSync" | "renameSync">;

function holdsData(directory: string, files: FileSystem): boolean {
  if (!files.existsSync(directory)) return false;
  try {
    return files.readdirSync(directory).length > 0;
  } catch {
    // Unreadable is not empty: never move anything over it.
    return true;
  }
}

/**
 * The data folder to use, moving the previous one into place the first time.
 *
 * Chats, settings, saved keys and run history all live under it, so a rename
 * that left them behind would look to the user like everything was deleted.
 * The move happens only when the new folder has nothing in it, and when it
 * cannot happen (a file still open, a permission) the previous folder is used
 * where it is rather than starting empty.
 */
export function adoptPreviousUserData(current: string, previous: string, files: FileSystem = fs): string {
  if (holdsData(current, files) || !holdsData(previous, files)) return current;
  try {
    files.mkdirSync(path.dirname(current), { recursive: true });
    if (files.existsSync(current)) {
      // Empty, possibly created by Electron itself; the rename needs it gone.
      files.rmdirSync(current);
    }
    files.renameSync(previous, current);
    return current;
  } catch {
    return previous;
  }
}
