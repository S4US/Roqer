import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { RojoError, type SourcemapNode } from './sourcemap.js';
import { scriptFiles } from './ownership.js';

/** A new instance as the plugin's build plan describes it (BuildHandlers describeNew). */
export interface PlannedNode {
  name: string;
  className: string;
  id?: string;
  source?: string;
  runContext?: string;
  disabled?: boolean;
  extras?: string[];
  children?: PlannedNode[];
}

/** One new instance tree and the live parent it would be attached to. */
export interface PlannedTop {
  parentPath: string;
  parentUnique: boolean;
  nameTaken: boolean;
  node: PlannedNode;
}

export interface NewEntry {
  kind: 'dir' | 'file';
  /** Absolute path under the project folder. */
  path: string;
  content?: string;
}

/** A new instance the files should make, checked against Rojo's sourcemap once written. */
export interface NewInstance {
  segments: string[];
  className: string;
  /** For a script: its source file (absolute) and the source Studio should end up with. */
  file?: string;
  source?: string;
  id?: string;
}

export interface Naming {
  emitLegacyScripts: boolean;
  extension: '.luau' | '.lua';
}

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);
const MAX_NESTED_PROJECTS = 16;

/**
 * Every file name ending Rojo's default sync rules recognize, longest first:
 * a file named with one of these makes an instance named by what is left.
 */
const RECOGNIZED_ENDINGS = [
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

/** The instance name Rojo gives a directory entry. */
function instanceNameOf(entry: fs.Dirent): string {
  if (entry.isDirectory()) return entry.name;
  const lower = entry.name.toLowerCase();
  const ending = RECOGNIZED_ENDINGS.find((suffix) => lower.endsWith(suffix));
  return ending ? entry.name.slice(0, -ending.length) : entry.name;
}

function exactEntry(dir: string, name: string): fs.Dirent | undefined {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).find((entry) => entry.name === name);
  } catch {
    return undefined;
  }
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function readProject(file: string): Record<string, unknown> {
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

/**
 * The folder on disk whose files Rojo makes the children of the instance at
 * `segments`, walked through the project file itself (and any nested project
 * it points to) because Rojo's sourcemap never lists a directory. Anything
 * with no folder of its own is answered with why, never guessed from where
 * its siblings' files happen to be.
 */
export function projectDirectory(projectFile: string, segments: string[]): { dir: string } | { reason: string } {
  const label = (count: number) => segments.slice(0, count).join('.') || 'the place';
  let node = treeOf(readProject(projectFile), projectFile);
  let base = path.dirname(projectFile);
  let index = 0;
  for (let nested = 0; ; ) {
    const target = pathOf(node);
    if (target !== undefined && /\.project\.jsonc?$/i.test(target)) {
      if (++nested > MAX_NESTED_PROJECTS) return { reason: `${label(index)} nests project files too deeply` };
      const file = path.resolve(base, target);
      node = treeOf(readProject(file), file);
      base = path.dirname(file);
      continue;
    }
    if (index === segments.length) break;
    const child = childNode(node, segments[index]);
    if (child) {
      node = child;
      index += 1;
      continue;
    }
    if (target === undefined) return { reason: `${segments[index]} is not in the Rojo project` };
    let dir = path.resolve(base, target);
    if (!isDirectory(dir)) return { reason: `${label(index)} comes from a single file in the project, so it has no folder for new files` };
    for (; index < segments.length; index += 1) {
      const entry = exactEntry(dir, segments[index]);
      const next = path.join(dir, segments[index]);
      if (entry && isDirectory(next)) {
        dir = next;
        continue;
      }
      const scriptFile = fs.readdirSync(dir).some((name) => SCRIPT_FILE.exec(name)?.[1] === segments[index]);
      if (scriptFile) return { reason: `${label(index + 1)} is a script saved as a single file, so it has no folder for new files` };
      return { reason: `${segments[index]} is not in the Rojo project` };
    }
    return { dir };
  }
  const target = pathOf(node);
  if (target === undefined) return { reason: `${label(index)} is written out in the project file, with no folder of its own ($path)` };
  const dir = path.resolve(base, target);
  if (!isDirectory(dir)) return { reason: `${label(index)} comes from a single file in the project, so it has no folder for new files` };
  return { dir };
}

/** How the project names a new script's file, or why Roqer cannot tell. */
export function projectNaming(projectFile: string, tree: SourcemapNode): Naming | { reason: string } {
  const project = readProject(projectFile);
  if (project.syncRules !== undefined) {
    return { reason: 'the project sets syncRules, so Roqer cannot tell which file name Rojo reads a new script from' };
  }
  let lua = 0;
  let luau = 0;
  for (const file of scriptFiles(tree)) {
    if (/\.luau$/i.test(file)) luau += 1;
    else lua += 1;
  }
  return { emitLegacyScripts: project.emitLegacyScripts !== false, extension: lua > luau ? '.lua' : '.luau' };
}

/** The `.server`/`.client` part of a script's file name, from its class and RunContext. */
function scriptSuffix(node: PlannedNode, naming: Naming): string | { reason: string } {
  if (node.className === 'ModuleScript') return '';
  const runContext = node.runContext ?? 'Legacy';
  if (node.className === 'LocalScript') {
    return naming.emitLegacyScripts
      ? '.client'
      : { reason: 'this project sets emitLegacyScripts to false, so a LocalScript has no file form; make a Script with RunContext Client instead' };
  }
  if (naming.emitLegacyScripts) {
    return runContext === 'Legacy'
      ? '.server'
      : { reason: `a Script with RunContext ${runContext} needs a meta file Roqer does not write yet; leave RunContext as Legacy, or make a LocalScript` };
  }
  if (runContext === 'Client') return '.client';
  if (runContext === 'Server' || runContext === 'Legacy') return '.server';
  return { reason: `a Script with RunContext ${runContext} has no file form Roqer writes yet` };
}

export function containsScript(node: PlannedNode): boolean {
  return SCRIPT_CLASSES.has(node.className) || (node.children ?? []).some(containsScript);
}

const MODEL_META = '{\n  "className": "Model"\n}\n';

/**
 * The files and folders that make `node` under `dir`, in the order to create
 * them, plus every instance they should make. Only what Rojo makes from a
 * name, a class, and a source is written: scripts (a folder with an init
 * file when they have children), Folders, and Models of those.
 */
export function layoutNew(
  dir: string,
  parentSegments: string[],
  node: PlannedNode,
  naming: Naming,
  entries: NewEntry[],
  instances: NewInstance[],
): string | undefined {
  const where = [...parentSegments, node.name].join('.');
  const problem = nameProblem(node.name);
  if (problem) return `${where} cannot be saved to a file: ${problem}`;
  if (node.extras && node.extras.length > 0) {
    return `${where} has ${node.extras.join(' and ')} that Roqer cannot save to a file yet; create it without them`;
  }
  const children = node.children ?? [];
  const seen = new Set<string>();
  for (const child of children) {
    const key = child.name.toLowerCase();
    if (seen.has(key)) return `${where} would hold two children named ${child.name} (file names ignore case), so their files would collide`;
    seen.add(key);
  }
  const segments = [...parentSegments, node.name];
  const folder = path.join(dir, node.name);
  if (SCRIPT_CLASSES.has(node.className)) {
    if (node.disabled) return `${where} is disabled, which needs a meta file Roqer does not write yet; create it enabled`;
    const suffix = scriptSuffix(node, naming);
    if (typeof suffix !== 'string') return `${where}: ${suffix.reason}`;
    const source = (node.source ?? '').replace(/\r\n?/g, '\n');
    const file = children.length === 0
      ? path.join(dir, `${node.name}${suffix}${naming.extension}`)
      : path.join(folder, `init${suffix}${naming.extension}`);
    if (children.length > 0) entries.push({ kind: 'dir', path: folder });
    entries.push({ kind: 'file', path: file, content: source });
    instances.push({ segments, className: node.className, file, source, ...(node.id !== undefined ? { id: node.id } : {}) });
  } else if (node.className === 'Folder' || node.className === 'Model') {
    entries.push({ kind: 'dir', path: folder });
    if (node.className === 'Model') entries.push({ kind: 'file', path: path.join(folder, 'init.meta.json'), content: MODEL_META });
    instances.push({ segments, className: node.className, ...(node.id !== undefined ? { id: node.id } : {}) });
  } else {
    return `${where} is a ${node.className}; only scripts, Folders, and Models of them are saved to files yet`;
  }
  for (const child of children) {
    const reason = layoutNew(folder, segments, child, naming, entries, instances);
    if (reason) return reason;
  }
  return undefined;
}

/** Whether `dir` already has an entry Rojo would read as an instance named `name` (or its meta file). */
export function nameInDirectory(dir: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).find((entry) => instanceNameOf(entry).toLowerCase() === lower)?.name;
  } catch {
    return undefined;
  }
}

/**
 * Creates every entry, failing on any that already exists, and removes what
 * it created if any step fails. Resolves with what it created, in order, so
 * a later check can take it back out with removeNew.
 */
export async function createNew(entries: NewEntry[]): Promise<string[]> {
  const created: string[] = [];
  try {
    for (const entry of entries) {
      if (entry.kind === 'dir') await fsp.mkdir(entry.path);
      else await fsp.writeFile(entry.path, entry.content ?? '', { flag: 'wx' });
      created.push(entry.path);
    }
    return created;
  } catch (error) {
    await removeNew(created);
    throw error;
  }
}

/** Removes what createNew made, newest first; a folder only while it is still empty. */
export async function removeNew(created: string[]): Promise<void> {
  for (const file of [...created].reverse()) {
    await fsp.rm(file, { force: true }).catch(() => undefined);
    await fsp.rmdir(file).catch(() => undefined);
  }
}

/** The one sourcemap node at `segments`, or undefined when there is none or several. */
export function nodeAt(tree: SourcemapNode, segments: string[]): SourcemapNode | undefined {
  let node: SourcemapNode | undefined = tree;
  for (const segment of segments) {
    const matches: SourcemapNode[] = (node.children ?? []).filter((child) => child.name === segment);
    if (matches.length !== 1) return undefined;
    node = matches[0];
  }
  return node;
}
