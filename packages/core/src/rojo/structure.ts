import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyFileOps, filesUnder, sizeOf, undoFileOps, ProjectFilesError, type FileOp } from './file-ops.js';
import { formatInstancePath, parseInstancePath } from './instance-path.js';
import { containsScript, descendantCount, layoutNew, nodeAt, projectNaming, type Layout, type NewInstance, type PlannedTop } from './new-files.js';
import { entriesNamed, locate, nameInDirectory, nameProblem, projectDirectory, readProject, type Located } from './project-walk.js';
import { sourceRevision } from './source-revision.js';
import { RojoError, type SourcemapNode } from './sourcemap.js';
import { toStudioText } from './text-format.js';

/**
 * Structural changes on a place linked to a Rojo project: new instances,
 * removals, renames and moves. Rojo carries only script source from Studio
 * back to disk, so a change to something the project owns is made to its
 * files, and Rojo makes it in Studio; making it in Studio as well would leave
 * two copies, or undo itself the next time Rojo syncs.
 */

/** A live instance a plan edits, removes, renames or moves (BuildHandlers describeLive, PropertyHandlers planOnly). */
export interface PlannedLive {
  op: 'set' | 'remove';
  path: string;
  className: string;
  uniquePath: boolean;
  descendants: number;
  scripts: Array<{ path: string; revision: string }>;
  scriptsOmitted?: number;
  /** The new name, for a rename. */
  name?: string;
  /** The new parent's path, for a move (set_properties only). */
  parent?: string;
  parentUnique?: boolean;
  /** For a rename or move: whether the destination already has another child by the final name in Studio. */
  nameTaken?: boolean;
  /** Every other property the change assigns. */
  properties?: string[];
  placement?: boolean;
  tags?: boolean;
  attributes?: boolean;
}

/** What a saved change is checked against once written: Rojo's sourcemap, then Studio. */
export type SourcemapCheck = { segments: string[]; present: false } | { segments: string[]; present: true; className: string; file?: string };
export type StudioCheck = { path: string; revision: string } | { path: string; className: string } | { path: string; absent: true };

export interface ProjectChange {
  ops: FileOp[];
  checks: SourcemapCheck[];
  studio: StudioCheck[];
  created: string[];
  removed: string[];
  renamed: Array<{ from: string; to: string }>;
  /** Every new instance, for ids and the new scripts' expected revisions. */
  instances: NewInstance[];
}

/** Where a planned batch belongs: saved to files, applied in Studio (with notes when it touches the project), or refused. */
export type Disposition =
  | { kind: 'files'; change: ProjectChange; needsSerialize: boolean }
  | { kind: 'studio'; notes: string[] }
  | { kind: 'refuse'; error: string; code: string; file?: string };

/** The largest file or folder a removal backs up before taking it out. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const MODEL_FILE = /\.(rbxm|rbxmx|model\.jsonc?)$/i;
const SCRIPT_FILE = /\.luau?$/i;

export interface StructureContext {
  projectFile: string;
  root: string;
  sourcemap: () => Promise<SourcemapNode>;
  ignored: (root: string, files: string[]) => Promise<Set<string>>;
}

type Part =
  | { kind: 'files'; change: Partial<ProjectChange>; needsSerialize?: boolean }
  | { kind: 'studio'; note?: string }
  | { kind: 'refuse'; error: string; code?: string; file?: string };

const shown = (context: StructureContext, file: string) => path.relative(context.root, file) || '.';

function real(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

function insideRoot(context: StructureContext, file: string): boolean {
  const relative = path.relative(context.root, real(file));
  return !(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
}

async function generatedAmong(context: StructureContext, files: string[]): Promise<string | undefined> {
  const ignored = await context.ignored(context.root, files);
  return files.find((file) => ignored.has(file) || ignored.has(real(file)) || path.relative(context.root, file).split(path.sep).includes('_Index'));
}

/** Every file Rojo's sourcemap reads for `node` and everything under it, real paths. */
function sourcemapFiles(context: StructureContext, node: SourcemapNode): Set<string> {
  const files = new Set<string>();
  const visit = (current: SourcemapNode) => {
    for (const file of current.filePaths ?? []) files.add(real(path.resolve(context.root, file)));
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return files;
}

/** Where each new tree of a build goes. */
async function planTop(context: StructureContext, top: PlannedTop, claimed: Set<string>): Promise<Part> {
  const name = top.node.name;
  const scripts = containsScript(top.node);
  const segments = parseInstancePath(top.parentPath);
  if (!segments) return { kind: 'refuse', error: `${top.parentPath} could not be matched to the project` };
  let folder: ReturnType<typeof projectDirectory>;
  try {
    folder = projectDirectory(context.projectFile, segments);
  } catch (error) {
    // An unreadable project file cannot say where a new script belongs; a model built anywhere stays in Studio, saying why.
    if (!(error instanceof RojoError) || scripts) throw error;
    return { kind: 'studio', note: `${error.message}, so ${name} is not saved to the Rojo project` };
  }
  if ('reason' in folder) {
    // Not the project's to hold: built in Studio as always, saying so when it holds code someone may expect saved.
    return scripts ? { kind: 'studio', note: `new scripts under ${top.parentPath} are not saved to the Rojo project: ${folder.reason}` } : { kind: 'studio' };
  }
  let dir: string;
  try {
    dir = fs.realpathSync.native(folder.dir);
  } catch {
    return { kind: 'refuse', error: `the folder for ${top.parentPath} is missing on disk` };
  }
  if (!insideRoot(context, dir)) return { kind: 'refuse', error: `the folder for ${top.parentPath} resolves outside the project folder` };
  if (!top.parentUnique) {
    return { kind: 'refuse', error: `another instance on the path to ${top.parentPath} in Studio has the same name, so where ${name} goes is ambiguous` };
  }
  const tree = await context.sourcemap();
  const parentNode = nodeAt(tree, segments);
  if (!parentNode) return { kind: 'refuse', error: `Rojo's sourcemap does not list ${top.parentPath} exactly once, so ${shown(context, dir)} cannot be matched to it` };
  if (top.nameTaken || (parentNode.children ?? []).some((child) => child.name === name)) {
    return { kind: 'refuse', error: `${top.parentPath} already has a child named ${name}; a second would make its path ambiguous` };
  }
  const existing = nameInDirectory(dir, name);
  const key = path.join(dir, name.toLowerCase());
  if (existing !== undefined || claimed.has(key)) {
    return { kind: 'refuse', error: `${shown(context, path.join(dir, existing ?? name))} would collide with the new ${name} (file names ignore case)` };
  }
  claimed.add(key);
  const naming = scripts ? projectNaming(folder, tree) : undefined;
  if (naming && 'reason' in naming) return { kind: 'refuse', error: naming.reason };
  const layout: Layout = { ops: [], instances: [], needsSerialize: false };
  const reason = layoutNew(dir, segments, top.node, naming, layout);
  if (reason) return { kind: 'refuse', error: reason };
  const written = layout.ops.flatMap((op) => (op.kind === 'write' || op.kind === 'mkdir' ? [op.path] : []))
    .concat(layout.instances.flatMap((instance) => (instance.file ? [instance.file] : [])));
  const generated = await generatedAmong(context, written);
  if (generated) {
    return { kind: 'refuse', code: 'rojo_generated', file: shown(context, generated), error: `${shown(context, generated)} would be package or build output, not source` };
  }
  const topSegments = [...segments, name];
  return {
    kind: 'files',
    needsSerialize: layout.needsSerialize,
    change: {
      ops: layout.ops,
      instances: layout.instances,
      checks: layout.instances.map((instance) => ({ segments: instance.segments, present: true as const, className: instance.className, ...(instance.file ? { file: instance.file } : {}) })),
      // Studio is checked for the new tree and each new script's source.
      studio: [
        { path: formatInstancePath(topSegments), className: top.node.className },
        ...layout.instances.filter((instance) => instance.source !== undefined)
          .map((instance) => ({ path: formatInstancePath(instance.segments), revision: sourceRevision(instance.source!) })),
      ],
      created: layout.instances.flatMap((instance) => (instance.file ? [instance.file] : [])),
    },
  };
}

/** The files (or folder) a Rojo-owned instance comes from, checked against the sourcemap; or what it is instead. */
type Owned =
  | { kind: 'owned'; entries: string[]; folder: boolean; parentDir: string; node: SourcemapNode; segments: string[]; projectFile: string }
  | { kind: 'not-owned'; note?: string }
  | { kind: 'refuse'; error: string; code?: string; file?: string };

/** The one sourcemap node at `segments`; `ambiguous` when Rojo lists a name on the way more than once. */
function walkSourcemap(tree: SourcemapNode, segments: string[]): SourcemapNode | 'ambiguous' | undefined {
  let node: SourcemapNode = tree;
  for (const segment of segments) {
    const matches: SourcemapNode[] = (node.children ?? []).filter((child) => child.name === segment);
    if (matches.length > 1) return 'ambiguous';
    if (matches.length === 0) return undefined;
    node = matches[0];
  }
  return node;
}

async function owned(context: StructureContext, live: PlannedLive, located: Located, segments: string[]): Promise<Owned> {
  const tree = await context.sourcemap();
  const node = walkSourcemap(tree, segments);
  // Rojo makes two instances by one name on that path: which files are meant cannot be told.
  if (node === 'ambiguous') return { kind: 'refuse', error: `the Rojo project makes more than one instance on the path ${live.path}, so its files are ambiguous` };
  if (located.kind === 'inside') {
    return MODEL_FILE.test(located.file)
      ? { kind: 'not-owned', note: `${live.path} is inside the model file ${shown(context, located.file)}, so changes to it are not saved to the Rojo project` }
      : { kind: 'not-owned' };
  }
  // Not something Rojo makes (not in the project, or a file it ignores): the instance in Studio is not the project's.
  if (!node || located.kind === 'absent') {
    return node && located.kind === 'absent'
      ? { kind: 'refuse', error: `${live.path} is in the Rojo project, but ${located.reason}` }
      : { kind: 'not-owned' };
  }
  // The project makes this instance, but Studio has a second by its name: which one is meant cannot be told.
  if (!live.uniquePath) return { kind: 'refuse', error: `another instance on the path to ${live.path} in Studio has the same name, so which one is meant is ambiguous` };
  if (located.kind === 'project' || (located.kind === 'folder' && located.viaKey)) {
    return { kind: 'refuse', error: `${live.path} is written out in the project file ${path.basename(context.projectFile)}; change it there` };
  }
  if (located.kind === 'folder' && located.nestedRoot) {
    return { kind: 'refuse', error: `${live.path} is a nested Rojo project; rename or remove its folder or project file yourself` };
  }
  if (node.className !== live.className) {
    return { kind: 'refuse', error: `Studio has a ${live.className} at ${live.path} but the project makes a ${node.className}` };
  }
  const entries = located.kind === 'folder' ? [located.dir] : located.files;
  const parentDir = located.kind === 'folder' ? path.dirname(located.dir) : located.parentDir;
  if (located.kind === 'entry') {
    // Exactly the files Rojo reads for this instance: one it reads as something else, or not at all, never goes with it.
    const read = new Set((node.filePaths ?? []).map((file) => real(path.resolve(context.root, file))));
    const strays = located.files.filter((file) => !read.has(real(file)));
    if (strays.length > 0 || read.size !== located.files.length) {
      const named = strays.length > 0 ? strays.map((file) => shown(context, file)).join(', ') : 'another file';
      return { kind: 'refuse', error: `${named} is named like ${live.path} but Rojo does not read it as that instance; move it out of the way first` };
    }
  }
  for (const entry of entries) {
    if (!insideRoot(context, entry)) return { kind: 'refuse', error: `${shown(context, entry)} resolves outside the project folder` };
  }
  const generated = await generatedAmong(context, entries);
  if (generated) {
    return { kind: 'refuse', code: 'rojo_generated', file: shown(context, generated), error: `${shown(context, generated)} is a package or build output, not source` };
  }
  return { kind: 'owned', entries, folder: located.kind === 'folder', parentDir, node, segments, projectFile: located.projectFile };
}

/**
 * The scripts under a change, compared with their files: one edited in Studio
 * (an unsaved edit included) that its file does not hold would be lost when
 * the file moves or goes and Rojo makes the instance again, so the change is
 * refused like a conflicting edit.
 */
async function sourcesAgree(context: StructureContext, live: PlannedLive): Promise<Part | undefined> {
  if (live.scriptsOmitted) {
    return { kind: 'refuse', error: `${live.path} holds more scripts than Roqer checks against their files at once; change it in smaller parts` };
  }
  const tree = await context.sourcemap();
  for (const script of live.scripts) {
    const segments = parseInstancePath(script.path);
    if (!segments) return { kind: 'refuse', error: `${script.path} cannot be matched to its file, so nothing was moved or removed` };
    let node: SourcemapNode | undefined = tree;
    for (const segment of segments) {
      const matches: SourcemapNode[] = (node.children ?? []).filter((child) => child.name === segment);
      // Two project instances by one name cannot be told apart, so neither can be compared with its file.
      if (matches.length > 1) {
        return { kind: 'refuse', error: `more than one instance in the project is named like ${script.path}, so Roqer cannot compare it with its file; rename one first` };
      }
      node = matches[0];
      // Not in the project: only Studio holds it, and a removal takes it anyway.
      if (!node) break;
    }
    const files = (node?.filePaths ?? []).filter((file) => SCRIPT_FILE.test(file));
    // A script inside a model file has no file of its own to differ from.
    if (files.length !== 1) continue;
    const file = path.resolve(context.root, files[0]);
    const revision = await fs.promises.readFile(file).then((bytes) => sourceRevision(toStudioText(bytes)), () => undefined);
    if (revision !== script.revision) {
      return {
        kind: 'refuse',
        code: 'rojo_conflict',
        file: shown(context, file),
        error: `${shown(context, file)} and the script in Studio differ, so nothing was moved or removed. `
          + 'To keep the file, reconnect the Rojo plugin so Studio takes the file, then retry. '
          + "To keep Studio's version, copy its text into the file, then retry",
      };
    }
  }
  return undefined;
}

async function planRemove(context: StructureContext, live: PlannedLive, own: Extract<Owned, { kind: 'owned' }>): Promise<Part> {
  // Whatever only Studio holds under it is in no file, so neither the backup nor Git could give it back.
  const studioOnly = live.descendants - descendantCount(own.node);
  if (studioOnly > 0) {
    return { kind: 'refuse', error: `${live.path} holds ${studioOnly} instance(s) only Studio has, which the backup of its files would not keep; move or remove them first` };
  }
  const conflict = await sourcesAgree(context, live);
  if (conflict) return conflict;
  if (own.folder) {
    // Only what Rojo itself reads may go with the folder (and the .gitkeep Rojo writes into an empty one).
    const synced = sourcemapFiles(context, own.node);
    const strays = (await filesUnder(own.entries[0])).filter((file) => path.basename(file) !== '.gitkeep' && !synced.has(real(file)));
    if (strays.length > 0) {
      const named = strays.slice(0, 3).map((file) => shown(context, file)).join(', ');
      return { kind: 'refuse', error: `${shown(context, own.entries[0])} also holds files Rojo does not sync (${named}${strays.length > 3 ? ', ...' : ''}); move them out first` };
    }
  }
  let bytes = 0;
  for (const entry of own.entries) bytes += await sizeOf(entry);
  if (bytes > MAX_BACKUP_BYTES) {
    return { kind: 'refuse', error: `${live.path}'s files are over ${MAX_BACKUP_BYTES / 1024 / 1024} MB, more than Roqer backs up before removing; delete them yourself` };
  }
  return {
    kind: 'files',
    change: {
      ops: own.entries.map((entry) => ({ kind: 'delete' as const, path: entry })),
      checks: [{ segments: own.segments, present: false }],
      studio: [{ path: live.path, absent: true }],
      removed: own.entries,
    },
  };
}

async function planMove(
  context: StructureContext,
  live: PlannedLive,
  own: Extract<Owned, { kind: 'owned' }>,
  name: string,
  parentSegments: string[],
): Promise<Part> {
  const problem = nameProblem(name);
  if (problem) return { kind: 'refuse', error: `${live.path} cannot be renamed to ${name}: ${problem}` };
  let targetDir = own.parentDir;
  if (parentSegments.join('\u0000') !== own.segments.slice(0, -1).join('\u0000')) {
    const folder = projectDirectory(context.projectFile, parentSegments);
    if ('reason' in folder) return { kind: 'refuse', error: `${live.path} cannot move there, since the new parent has no project folder: ${folder.reason}` };
    targetDir = real(folder.dir);
    if (!insideRoot(context, targetDir)) return { kind: 'refuse', error: `the new parent's folder resolves outside the project folder` };
    if (live.parentUnique === false) return { kind: 'refuse', error: 'another instance on the path to the new parent in Studio has the same name, so where it goes is ambiguous' };
    // emitLegacyScripts decides a .server or .client file's RunContext, which the sourcemap does not show: refuse a move that would change it.
    const legacy = (projectFile: string) => readProject(projectFile).emitLegacyScripts !== false;
    const hasRunScripts = (node: SourcemapNode): boolean => node.className === 'Script' || node.className === 'LocalScript' || (node.children ?? []).some(hasRunScripts);
    if (legacy(own.projectFile) !== legacy(folder.projectFile) && hasRunScripts(own.node)) {
      return { kind: 'refuse', error: `${live.path} would move into a project with a different emitLegacyScripts setting, which changes its scripts' RunContext; move it within its own project, or edit the project files yourself` };
    }
  }
  if (live.nameTaken) {
    return { kind: 'refuse', error: `${formatInstancePath(parentSegments)} already has a child named ${name} in Studio; a second would make its path ambiguous` };
  }
  const parentNode = walkSourcemap(await context.sourcemap(), parentSegments);
  if (parentNode !== 'ambiguous' && parentNode && (parentNode.children ?? []).some((child) => child.name === name && child !== own.node)) {
    return { kind: 'refuse', error: `${formatInstancePath(parentSegments)} already has a child named ${name} in the Rojo project; a second would make its path ambiguous` };
  }
  // Rojo makes the moved instance again from its files, so anything under it that only Studio holds would be dropped.
  if (live.descendants > descendantCount(own.node)) {
    return { kind: 'refuse', error: `${live.path} holds ${live.descendants - descendantCount(own.node)} instance(s) only Studio has; Rojo would drop them when it remakes ${live.path} from its moved files` };
  }
  const conflict = await sourcesAgree(context, live);
  if (conflict) return conflict;
  const oldName = own.segments.at(-1)!;
  const renames: Array<{ from: string; to: string }> = [];
  for (const entry of own.entries) {
    const base = path.basename(entry);
    if (!own.folder && !base.startsWith(oldName)) {
      return { kind: 'refuse', error: `${shown(context, entry)} is named by its own contents rather than its file name, so Roqer cannot rename it` };
    }
    renames.push({ from: entry, to: path.join(targetDir, own.folder ? name : name + base.slice(oldName.length)) });
  }
  const sameEntries = new Set(own.entries.map((entry) => path.basename(entry).toLowerCase()));
  const clash = entriesNamed(targetDir, name, { ignoreCase: true })
    .find((entry) => !(targetDir === own.parentDir && sameEntries.has(entry.toLowerCase())));
  if (clash) return { kind: 'refuse', error: `${shown(context, path.join(targetDir, clash))} would collide with ${name} (file names ignore case)` };
  const generated = await generatedAmong(context, renames.map((rename) => rename.to));
  if (generated) return { kind: 'refuse', code: 'rojo_generated', file: shown(context, generated), error: `${shown(context, generated)} would be package or build output, not source` };
  const newSegments = [...parentSegments, name];
  const main = own.folder ? undefined : renames.find((rename) => !/\.meta\.jsonc?$/i.test(rename.to))?.to;
  const newPath = formatInstancePath(newSegments);
  return {
    kind: 'files',
    change: {
      ops: renames.map((rename) => ({ kind: 'rename' as const, ...rename })),
      checks: [
        ...(newPath.toLowerCase() === live.path.toLowerCase() ? [] : [{ segments: own.segments, present: false as const }]),
        { segments: newSegments, present: true, className: live.className, ...(main ? { file: main } : {}) },
      ],
      studio: [
        ...(newPath === live.path ? [] : [{ path: live.path, absent: true as const }]),
        { path: newPath, className: live.className },
      ],
      renamed: renames,
    },
  };
}

/** Where one edit, removal, rename or move of a live instance goes. */
async function planLive(context: StructureContext, live: PlannedLive): Promise<Part> {
  const segments = parseInstancePath(live.path);
  if (!segments) return { kind: 'refuse', error: `${live.path} could not be matched to the project` };
  const parentSegments = live.parent !== undefined ? parseInstancePath(live.parent) : segments.slice(0, -1);
  if (!parentSegments) return { kind: 'refuse', error: `${live.parent} could not be matched to the project` };
  // A name or parent it already has is no rename or move.
  const renamed = live.name !== undefined && live.name !== segments.at(-1);
  const moved = live.parent !== undefined && parentSegments.join('\u0000') !== segments.slice(0, -1).join('\u0000');
  const structural = live.op === 'remove' || renamed || moved;
  let located: Located;
  try {
    located = locate(context.projectFile, segments);
  } catch (error) {
    // Unreadable project file: a property edit stays in Studio, saying why; a removal, rename or move is refused.
    if (!(error instanceof RojoError) || structural) throw error;
    return { kind: 'studio', note: `${error.message}, so changes to ${live.path} are not saved to the Rojo project` };
  }
  const own = await owned(context, live, located, segments);
  if (own.kind === 'refuse') return structural ? { kind: 'refuse', error: own.error, ...(own.code ? { code: own.code } : {}), ...(own.file ? { file: own.file } : {}) } : { kind: 'studio' };
  if (own.kind === 'not-owned') {
    // Moved into a project folder, it is still not saved there: Rojo would take it out on its next sync.
    if (moved && !('reason' in projectDirectory(context.projectFile, parentSegments))) {
      return { kind: 'studio', note: `${live.path} is moved into a project folder but is not saved to the Rojo project` };
    }
    return { kind: 'studio', ...(own.note ? { note: own.note } : {}) };
  }
  const others = (live.properties ?? []).length > 0 || live.placement === true || live.tags === true || live.attributes === true;
  if (live.op === 'remove') return planRemove(context, live, own);
  if (!structural) {
    return { kind: 'studio', note: `${live.path} comes from ${shown(context, own.entries[0])}, so property changes to it are not saved to the Rojo project` };
  }
  if (others) {
    return { kind: 'refuse', error: `${live.path} comes from the Rojo project, where a rename or move is saved by moving its files but its other changes are not; rename or move it on its own` };
  }
  return planMove(context, live, own, renamed ? live.name! : segments.at(-1)!, parentSegments);
}

/**
 * Where a planned batch belongs. Every part must agree: all saved to files,
 * or all in Studio. A batch mixing them is refused, since it could be applied
 * neither all at once nor all the same way.
 */
export async function planStructure(context: StructureContext, tops: PlannedTop[], lives: PlannedLive[]): Promise<Disposition> {
  const claimed = new Set<string>();
  const parts: Part[] = [];
  const removing = new Set(lives.filter((live) => live.op === 'remove').map((live) => live.path));
  for (const top of tops) {
    const part = await planTop(context, top, claimed);
    const segments = parseInstancePath(top.parentPath);
    const replaced = segments ? formatInstancePath([...segments, top.node.name]) : undefined;
    // Replacing something in one batch (a scatter's replace) would delete and rewrite one file at once, which a save does not do yet.
    parts.push(part.kind === 'refuse' && replaced !== undefined && removing.has(replaced)
      ? { kind: 'refuse', error: `This batch removes ${replaced} and makes a new one in its place, which the Rojo project cannot take in one save; remove it in one call, then build the new one in another` }
      : part);
  }
  for (const live of lives) parts.push(await planLive(context, live));
  const refused = parts.find((part): part is Extract<Part, { kind: 'refuse' }> => part.kind === 'refuse');
  if (refused) return { kind: 'refuse', error: refused.error, code: refused.code ?? 'rojo_unsupported', ...(refused.file ? { file: refused.file } : {}) };
  const files = parts.filter((part): part is Extract<Part, { kind: 'files' }> => part.kind === 'files');
  if (files.length === 0) {
    return { kind: 'studio', notes: [...new Set(parts.flatMap((part) => (part.kind === 'studio' && part.note ? [part.note] : [])))] };
  }
  if (files.length < parts.length) {
    return {
      kind: 'refuse',
      code: 'rojo_unsupported',
      error: 'This batch changes what the linked Rojo project holds, which is saved to its files, and also makes changes that stay in Studio only; '
        + 'send the project changes in a call of their own',
    };
  }
  const change: ProjectChange = { ops: [], checks: [], studio: [], created: [], removed: [], renamed: [], instances: [] };
  for (const part of files) {
    change.ops.push(...(part.change.ops ?? []));
    change.checks.push(...(part.change.checks ?? []));
    change.studio.push(...(part.change.studio ?? []));
    change.created.push(...(part.change.created ?? []));
    change.removed.push(...(part.change.removed ?? []));
    change.renamed.push(...(part.change.renamed ?? []));
    change.instances.push(...(part.change.instances ?? []));
  }
  return { kind: 'files', change, needsSerialize: files.some((part) => part.needsSerialize === true) };
}

/** A folder outside the project where removed files are kept, one per save. */
export function backupFolder(projectName: string, stamp: number): string {
  const safe = projectName.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60) || 'project';
  return path.join(os.tmpdir(), 'roqer-rojo-backups', `${safe}-${stamp}-${Math.random().toString(16).slice(2, 8)}`);
}

/**
 * Applies a change, then reads Rojo's sourcemap back and checks every
 * instance is where the change put it, with the expected class and file.
 * Anything else undoes the whole change and rejects with ProjectFilesError,
 * naming whatever could not be put back.
 */
export async function applyStructure(context: StructureContext, change: ProjectChange, backup: string): Promise<void> {
  const done = await applyFileOps(change.ops, context.root, backup);
  let mismatch: string | undefined;
  try {
    const tree = await context.sourcemap();
    for (const check of change.checks) {
      const where = check.segments.join('.');
      const parent = nodeAt(tree, check.segments.slice(0, -1));
      const matches = (parent?.children ?? []).filter((child) => child.name === check.segments.at(-1));
      if (!check.present) {
        if (matches.length > 0) mismatch = `it still lists ${where}`;
      } else if (matches.length !== 1) {
        mismatch = `it lists no single ${where}`;
      } else if (matches[0].className !== check.className) {
        mismatch = `it makes ${where} a ${matches[0].className}, not a ${check.className}`;
      } else if (check.file && !(matches[0].filePaths ?? []).some((file) => real(path.resolve(context.root, file)) === real(check.file!))) {
        mismatch = `it does not read ${where} from ${shown(context, check.file)}`;
      }
      if (mismatch) break;
    }
  } catch (error) {
    throw new ProjectFilesError(error, await undoFileOps(done));
  }
  if (mismatch) {
    throw new ProjectFilesError(`Rojo did not read the project files as planned (${mismatch})`, await undoFileOps(done), 'rojo_unsupported');
  }
}
