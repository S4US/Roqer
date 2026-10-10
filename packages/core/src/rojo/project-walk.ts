import * as fs from 'fs';
import * as path from 'path';
import { RojoError } from './sourcemap.js';

/**
 * Where an instance lives on disk in a Rojo project, read from the project
 * files themselves: Rojo's sourcemap never lists a directory, so it cannot
 * say which folder holds an instance's children, or which files make it.
 */

const MAX_NESTED_PROJECTS = 16;

/**
 * Every file name ending Rojo's default sync rules recognize, longest first:
 * a file named with one of these makes an instance named by what is left.
 */
export const RECOGNIZED_ENDINGS = [
  '.server.luau', '.server.lua', '.client.luau', '.client.lua', '.plugin.luau', '.plugin.lua',
  '.project.jsonc', '.project.json', '.model.jsonc', '.model.json', '.meta.jsonc', '.meta.json',
  '.luau', '.lua', '.jsonc', '.json', '.toml', '.txt', '.csv', '.rbxmx', '.rbxm', '.yaml', '.yml',
];

/** Name endings Rojo would read as part of the file type rather than the name. */
const RESERVED_ENDINGS = ['.server', '.client', '.plugin', '.meta', '.model', '.project', ...RECOGNIZED_ENDINGS];

/** Why an instance name cannot be a Rojo file or folder name, or undefined when it can. */
export function nameProblem(name: string): string | undefined {
  if (name === '' || name.trim() === '') return 'an empty name cannot be a file name';
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return 'its name has a character a file name cannot hold';
  if (/[. ]$/.test(name)) return 'a file name cannot end with a dot or a space';
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(name)) return 'its name is reserved on Windows';
  const lower = name.toLowerCase();
  if (lower === 'init' || lower.startsWith('init.')) return 'Rojo reads a file named init as its folder\'s own script';
  const ending = RESERVED_ENDINGS.find((suffix) => lower.endsWith(suffix));
  if (ending) return `Rojo would read the ${ending} ending as part of the file type, not the name`;
  return undefined;
}

/** A project file's own `name`, if it has one. */
function projectName(file: string): string | undefined {
  try {
    const name = (JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

function isEntryDirectory(dir: string, entry: fs.Dirent): boolean {
  return entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(dir, entry.name)));
}

/**
 * The name Rojo gives the instance a directory entry makes, or undefined for
 * a file it does not read. A project file, or a folder holding
 * default.project.json, is named by the project's own `name`.
 */
function rojoNameOf(dir: string, entry: fs.Dirent): string | undefined {
  if (isEntryDirectory(dir, entry)) return projectName(path.join(dir, entry.name, 'default.project.json')) ?? entry.name;
  const lower = entry.name.toLowerCase();
  const ending = RECOGNIZED_ENDINGS.find((suffix) => lower.endsWith(suffix));
  if (!ending) return undefined;
  const stem = entry.name.slice(0, -ending.length);
  return /\.project\.jsonc?$/.test(lower) ? projectName(path.join(dir, entry.name)) ?? stem : stem;
}

/** Every name a directory entry could clash with: its own, and the one Rojo gives it. */
function instanceNamesOf(dir: string, entry: fs.Dirent): string[] {
  const lower = entry.name.toLowerCase();
  const ending = isEntryDirectory(dir, entry) ? undefined : RECOGNIZED_ENDINGS.find((suffix) => lower.endsWith(suffix));
  const own = ending ? entry.name.slice(0, -ending.length) : entry.name;
  const rojo = rojoNameOf(dir, entry);
  return rojo === undefined || rojo === own ? [own] : [own, rojo];
}

function readEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The entries in `dir` Rojo would read as an instance named `name`, ignoring case, or exactly. */
export function entriesNamed(dir: string, name: string, options: { ignoreCase: boolean }): string[] {
  const same = options.ignoreCase
    ? (candidate: string) => candidate.toLowerCase() === name.toLowerCase()
    : (candidate: string) => candidate === name;
  return readEntries(dir).filter((entry) => instanceNamesOf(dir, entry).some(same)).map((entry) => entry.name);
}

/** Whether `dir` already has an entry Rojo would read as an instance named `name` (or its meta file), ignoring case. */
export function nameInDirectory(dir: string, name: string): string | undefined {
  return entriesNamed(dir, name, { ignoreCase: true })[0];
}

export function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function readProject(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new RojoError('rojo_link_invalid', `${path.basename(file)} could not be read as JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RojoError('rojo_link_invalid', `${path.basename(file)} is not a Rojo project`);
  }
  return parsed as Record<string, unknown>;
}

function treeOf(project: Record<string, unknown>, file: string): Record<string, unknown> {
  const tree = project.tree;
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
    throw new RojoError('rojo_link_invalid', `${path.basename(file)} has no tree`);
  }
  return tree as Record<string, unknown>;
}

/** A project node's `$path`, which Rojo also accepts as `{ "optional": path }`. */
function pathOf(node: Record<string, unknown>): string | undefined {
  const value = node.$path;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { optional?: unknown }).optional === 'string') {
    return (value as { optional: string }).optional;
  }
  return undefined;
}

function childNode(node: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  if (name.startsWith('$')) return undefined;
  const child = node[name];
  return child && typeof child === 'object' && !Array.isArray(child) ? child as Record<string, unknown> : undefined;
}

const SCRIPT_FILE = /^(.*?)(\.server|\.client|\.plugin)?\.luau?$/i;

/** The project settings in force where a walk ended. */
interface Governing {
  /** The project file that describes this part of the tree. */
  projectFile: string;
  /** Whether any project file on the way here sets syncRules. */
  syncRules: boolean;
}

/** What the instance at a path is, on disk. */
export type Located =
  /**
   * A folder whose entries are the instance's children; `viaKey` when the
   * project file names it, `nestedRoot` when a nested project file makes the
   * instance itself (so the folder is that project's, not the instance's own).
   */
  | ({ kind: 'folder'; dir: string; viaKey: boolean; nestedRoot: boolean } & Governing)
  /** Files in `parentDir` that Rojo reads as this instance (a script, a model file, its meta file). */
  | ({ kind: 'entry'; parentDir: string; files: string[] } & Governing)
  /** A project file key with `$path` to a single file, or with no `$path` at all. */
  | { kind: 'project'; file?: string }
  /** Inside a file that makes more than one instance, such as a model file. */
  | { kind: 'inside'; file: string; reason: string }
  | { kind: 'absent'; reason: string };

/**
 * Walks `segments` down the project file (and any nested project it points
 * to, including a folder holding default.project.json) and then the folders
 * on disk, to where the instance at that path comes from. Anything ambiguous
 * or missing is answered with why, never guessed.
 */
export function locate(projectFile: string, segments: string[]): Located {
  const label = (count: number) => segments.slice(0, count).join('.') || 'the place';
  let node: Record<string, unknown> = {};
  let base = '';
  let governing = projectFile;
  let syncRules = false;
  let nested = 0;
  // Rojo applies each project file's own settings to the part of the tree it describes.
  let index = 0;
  // Where the walk last went into a project file: one entered at the very end makes the instance itself.
  let enteredAt = -1;
  const enter = (file: string) => {
    const project = readProject(file);
    node = treeOf(project, file);
    base = path.dirname(file);
    governing = file;
    syncRules ||= project.syncRules !== undefined;
    enteredAt = index;
  };
  enter(projectFile);
  let viaKey = true;
  outer: for (;;) {
    // The node's own keys first: Rojo adds them to whatever its $path holds.
    if (index < segments.length) {
      const child = childNode(node, segments[index]);
      if (child) {
        node = child;
        index += 1;
        viaKey = true;
        continue;
      }
    }
    const target = pathOf(node);
    if (target === undefined) {
      return index === segments.length ? { kind: 'project' } : { kind: 'absent', reason: `${segments[index]} is not in the Rojo project` };
    }
    const resolved = path.resolve(base, target);
    if (!fs.existsSync(resolved)) return { kind: 'absent', reason: `${label(index)} points at ${target}, which is missing on disk` };
    if (/\.project\.jsonc?$/i.test(target)) {
      if (++nested > MAX_NESTED_PROJECTS) return { kind: 'absent', reason: `${label(index)} nests project files too deeply` };
      enter(resolved);
      continue;
    }
    if (!isDirectory(resolved)) {
      if (index === segments.length) return { kind: 'project', file: resolved };
      return { kind: 'inside', file: resolved, reason: `${label(index)} comes from the single file ${target}` };
    }
    let dir = resolved;
    for (;;) {
      // A folder holding default.project.json is that project to Rojo, not a plain folder.
      const inner = path.join(dir, 'default.project.json');
      if (fs.existsSync(inner)) {
        if (++nested > MAX_NESTED_PROJECTS) return { kind: 'absent', reason: `${label(index)} nests project files too deeply` };
        enter(inner);
        continue outer;
      }
      if (index === segments.length) {
        return { kind: 'folder', dir, viaKey, nestedRoot: enteredAt === segments.length && segments.length > 0, projectFile: governing, syncRules };
      }
      const name = segments[index];
      // Entries by the name Rojo gives them; a file Rojo does not read is no instance at all.
      const matches = readEntries(dir).filter((entry) => rojoNameOf(dir, entry) === name);
      const folders = matches.filter((entry) => isEntryDirectory(dir, entry));
      const files = matches.filter((entry) => !isEntryDirectory(dir, entry)).map((entry) => path.join(dir, entry.name));
      const mains = files.filter((file) => !/\.meta\.jsonc?$/i.test(file));
      if (folders.length + mains.length > 1) {
        return { kind: 'absent', reason: `more than one file or folder in ${path.basename(dir)} makes ${label(index + 1)}, so which is meant is ambiguous` };
      }
      if (folders.length === 1) {
        dir = path.join(dir, folders[0].name);
        index += 1;
        viaKey = false;
        continue;
      }
      if (mains.length === 0) return { kind: 'absent', reason: `${name} is not in the Rojo project` };
      const main = mains[0];
      if (/\.project\.jsonc?$/i.test(main)) {
        // A project file in a folder is its own instance, made from that project's tree.
        if (++nested > MAX_NESTED_PROJECTS) return { kind: 'absent', reason: `${label(index)} nests project files too deeply` };
        index += 1;
        viaKey = false;
        enter(main);
        continue outer;
      }
      if (index === segments.length - 1) return { kind: 'entry', parentDir: dir, files, projectFile: governing, syncRules };
      const script = SCRIPT_FILE.test(path.basename(main));
      return {
        kind: 'inside',
        file: main,
        reason: script
          ? `${label(index + 1)} is a script saved as a single file, so it has no folder for children`
          : `${label(index + 1)} comes from the single file ${path.basename(main)}`,
      };
    }
  }
}

/** A project folder new files can go in, and the project file that governs it. */
export interface ProjectFolder extends Governing {
  dir: string;
}

/**
 * The folder on disk whose files Rojo makes the children of the instance at
 * `segments`, or why it has none of its own.
 */
export function projectDirectory(projectFile: string, segments: string[]): ProjectFolder | { reason: string } {
  const label = segments.join('.') || 'the place';
  const located = locate(projectFile, segments);
  switch (located.kind) {
    case 'folder':
      return { dir: located.dir, projectFile: located.projectFile, syncRules: located.syncRules };
    case 'project':
      return located.file === undefined
        ? { reason: `${label} is written out in the project file, with no folder of its own ($path)` }
        : { reason: `${label} comes from a single file in the project, so it has no folder for new files` };
    case 'entry':
      return SCRIPT_FILE.test(path.basename(located.files[0]))
        ? { reason: `${label} is a script saved as a single file, so it has no folder for new files` }
        : { reason: `${label} comes from a single file, so it has no folder for new files` };
    default:
      return { reason: located.reason };
  }
}
