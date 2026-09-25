import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { BlenderSettingsView } from "../shared/blender";

/**
 * Whether the Blender worker is on, and which Blender it runs.
 *
 * Kept by the main process in one small file. The executable is only ever one
 * Roqer found in a standard install location or the user picked in a system
 * file dialog; the store refuses anything that is not an absolute path to a
 * file named like Blender, and Settings cannot turn the worker on until that
 * file has answered `--version` as Blender.
 */

type StoredFile = Readonly<{ schemaVersion: 1; enabled: boolean; executable: string | null }>;

const EMPTY: StoredFile = { schemaVersion: 1, enabled: false, executable: null };
const MAX_FILE_BYTES = 8 * 1024;
const VERSION_TIMEOUT_MS = 20_000;

export class BlenderSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlenderSettingsError";
  }
}

/** An absolute path whose file name is Blender's own. */
export function isBlenderExecutablePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || !path.isAbsolute(value)) return false;
  return /^blender(\.exe)?$/i.test(path.basename(value));
}

function parseStored(value: unknown): StoredFile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.enabled !== "boolean") return undefined;
  if (record.executable !== null && !isBlenderExecutablePath(record.executable)) return undefined;
  return { schemaVersion: 1, enabled: record.enabled, executable: record.executable as string | null };
}

/** Where installers put Blender, newest version first. */
export async function detectBlender(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | null> {
  const candidates: string[] = [];
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles && path.join(env.ProgramFiles, "Blender Foundation"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Blender Foundation"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Blender Foundation"),
    ].filter((root): root is string => typeof root === "string");
    for (const root of roots) {
      const versions = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of versions) {
        if (entry.isDirectory()) candidates.push(path.join(root, entry.name, "blender.exe"));
      }
    }
    for (const steam of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (steam) candidates.push(path.join(steam, "Steam", "steamapps", "common", "Blender", "blender.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push("/Applications/Blender.app/Contents/MacOS/Blender");
  } else {
    candidates.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender");
  }
  const existing: string[] = [];
  for (const candidate of candidates) {
    if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) existing.push(candidate);
  }
  // "Blender 5.2" sorts above "Blender 4.10" only when compared as versions.
  const versionOf = (file: string) => (path.basename(path.dirname(file)).match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  existing.sort((a, b) => {
    const [aMajor = 0, aMinor = 0] = versionOf(a);
    const [bMajor = 0, bMinor = 0] = versionOf(b);
    return bMajor - aMajor || bMinor - aMinor;
  });
  return existing[0] ?? null;
}

export type VersionSpawn = (command: string, args: readonly string[]) => ChildProcess;

const defaultVersionSpawn: VersionSpawn = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

/** Ask an executable for its version; undefined unless it answers as Blender. */
export function blenderVersion(executable: string, spawn: VersionSpawn = defaultVersionSpawn): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, ["--version"]);
    } catch {
      resolve(undefined);
      return;
    }
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(0, 4_096);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once("close", () => {
      clearTimeout(timer);
      const match = output.match(/^Blender (\d+\.\d+[^\r\n]*)/m);
      resolve(match ? `Blender ${match[1].trim()}` : undefined);
    });
  });
}

export type BlenderSettingsOptions = Readonly<{
  file: string;
  detect?: () => Promise<string | null>;
  version?: (executable: string) => Promise<string | undefined>;
}>;

export class BlenderSettings {
  private readonly file: string;
  private readonly detect: () => Promise<string | null>;
  private readonly version: (executable: string) => Promise<string | undefined>;
  private queue: Promise<unknown> = Promise.resolve();
  private cached: StoredFile | undefined;
  /** `--version` answers, per executable, so Settings does not start Blender on every look. */
  private readonly versions = new Map<string, string | null>();

  constructor(options: BlenderSettingsOptions) {
    if (!path.isAbsolute(options.file)) throw new Error("The Blender settings path must be absolute.");
    this.file = options.file;
    this.detect = options.detect ?? (() => detectBlender());
    this.version = options.version ?? ((executable) => blenderVersion(executable));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<StoredFile> {
    if (this.cached !== undefined) return this.cached;
    let parsed: StoredFile | undefined;
    try {
      const details = await fs.stat(this.file);
      if (details.size <= MAX_FILE_BYTES) parsed = parseStored(JSON.parse(await fs.readFile(this.file, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") parsed = undefined;
      else {
        // Nothing saved: start from whatever Blender is installed, off.
        this.cached = { ...EMPTY, executable: await this.detect().catch(() => null) };
        return this.cached;
      }
    }
    // A damaged file only ever holds a switch and a path; starting over, off, loses nothing.
    this.cached = parsed ?? { ...EMPTY, executable: await this.detect().catch(() => null) };
    return this.cached;
  }

  private async write(next: StoredFile): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.file);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new BlenderSettingsError("The Blender setting could not be saved.");
    }
    this.cached = next;
  }

  private async versionOf(executable: string): Promise<string | null> {
    if (!this.versions.has(executable)) this.versions.set(executable, (await this.version(executable)) ?? null);
    return this.versions.get(executable) ?? null;
  }

  private async view(file: StoredFile): Promise<BlenderSettingsView> {
    if (file.executable === null) {
      return { enabled: false, executable: null, version: null, state: "missing", message: "Blender was not found. Install it from blender.org, or choose blender.exe." };
    }
    const version = await this.versionOf(file.executable);
    if (version === null) {
      return { enabled: false, executable: file.executable, version: null, state: "broken", message: "That file did not answer as Blender. Choose blender.exe from a Blender install." };
    }
    return file.enabled
      ? { enabled: true, executable: file.executable, version, state: "ready", message: `${version} runs modeling jobs the agent writes, after you approve each one.` }
      : { enabled: false, executable: file.executable, version, state: "off", message: `${version} found. Turn it on to let the agent model assets with it.` };
  }

  get(): Promise<BlenderSettingsView> {
    return this.enqueue(async () => this.view(await this.read()));
  }

  /** Turning it on requires a Blender that answered; turning it off always works. */
  setEnabled(enabled: boolean): Promise<BlenderSettingsView> {
    return this.enqueue(async () => {
      const current = await this.read();
      if (enabled) {
        if (current.executable === null || (await this.versionOf(current.executable)) === null) {
          throw new BlenderSettingsError("Choose a working Blender before turning the worker on.");
        }
      }
      const next = { ...current, enabled };
      await this.write(next);
      return this.view(next);
    });
  }

  /** A path from the main process's own file dialog or detection. A new path starts off. */
  setExecutable(executable: string): Promise<BlenderSettingsView> {
    return this.enqueue(async () => {
      if (!isBlenderExecutablePath(executable)) throw new BlenderSettingsError("Choose blender.exe from a Blender install.");
      this.versions.delete(executable);
      const next: StoredFile = { schemaVersion: 1, enabled: false, executable };
      await this.write(next);
      return this.view(next);
    });
  }

  /** Look again in the standard locations, for a Blender installed since. */
  redetect(): Promise<BlenderSettingsView> {
    return this.enqueue(async () => {
      const found = await this.detect().catch(() => null);
      const current = await this.read();
      if (found === null || found === current.executable) return this.view(current);
      this.versions.delete(found);
      const next: StoredFile = { schemaVersion: 1, enabled: false, executable: found };
      await this.write(next);
      return this.view(next);
    });
  }

  /** The executable to run, only while the worker is on and Blender answers. */
  ready(): Promise<string | undefined> {
    return this.enqueue(async () => {
      const current = await this.read();
      if (!current.enabled || current.executable === null) return undefined;
      return (await this.versionOf(current.executable)) === null ? undefined : current.executable;
    });
  }
}
