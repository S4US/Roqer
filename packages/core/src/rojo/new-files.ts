import * as path from 'path';
import { nameProblem, readProject, type ProjectFolder } from './project-walk.js';
import type { SourcemapNode } from './sourcemap.js';
import { scriptFiles } from './ownership.js';
import type { FileOp } from './file-ops.js';

/** A new instance as the plugin's build plan describes it (BuildHandlers describeNew). */
export interface PlannedNode {
  name: string;
  className: string;
  id?: string;
  source?: string;
  runContext?: string;
  disabled?: boolean;
  extras?: string[];
  /** The tree as a base64 .rbxm, when it has no script and the plan was asked to serialize. */
  rbxm?: string;
  rbxmError?: string;
  children?: PlannedNode[];
}

/** One new instance tree and the live parent it would be attached to. */
export interface PlannedTop {
  parentPath: string;
  parentUnique: boolean;
  nameTaken: boolean;
  node: PlannedNode;
}

/** A new instance the files should make, checked against Rojo's sourcemap once written. */
export interface NewInstance {
  segments: string[];
  className: string;
  /** The file Rojo should read it from, for a script or a model file (absolute). */
  file?: string;
  /** For a script: the source Studio should end up with. */
  source?: string;
  id?: string;
}

export interface Naming {
  emitLegacyScripts: boolean;
  extension: '.luau' | '.lua';
}

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);

/**
 * How a new script's file is named in `folder`, or why Roqer cannot tell: the
 * project file governing that folder decides emitLegacyScripts (Rojo does not
 * carry it into a nested project), and syncRules anywhere on the way there
 * could rename it. The extension follows the project's existing source.
 */
export function projectNaming(folder: ProjectFolder, tree: SourcemapNode): Naming | { reason: string } {
  if (folder.syncRules) {
    return { reason: 'the project sets syncRules, so Roqer cannot tell which file name Rojo reads a new script from' };
  }
  let lua = 0;
  let luau = 0;
  for (const file of scriptFiles(tree)) {
    if (file.split('/').includes('_Index')) continue;
    if (/\.luau$/i.test(file)) luau += 1;
    else lua += 1;
  }
  return { emitLegacyScripts: readProject(folder.projectFile).emitLegacyScripts !== false, extension: lua > luau ? '.lua' : '.luau' };
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

/** What laying a tree out produces: file operations in order, the instances they should make, and whether a model still needs serializing. */
export interface Layout {
  ops: FileOp[];
  instances: NewInstance[];
  needsSerialize: boolean;
}

/**
 * The files and folders that make `node` under `dir`, in the order to create
 * them, plus every instance they should make; a reason instead when Rojo
 * could not make exactly this tree from files Roqer writes.
 *
 * A tree with no script in it is one .rbxm, exactly as Studio serialized it.
 * A script is a file (a folder with an init file when it has children); a
 * Folder of scripts is a folder, and any other container of scripts a folder
 * whose init.meta.json names its class, so its scripts stay files of their
 * own. Those carry only a name, class and source, so anything else set on
 * them is refused rather than dropped.
 */
export function layoutNew(dir: string, parentSegments: string[], node: PlannedNode, naming: Naming | undefined, out: Layout): string | undefined {
  const where = [...parentSegments, node.name].join('.');
  const problem = nameProblem(node.name);
  if (problem) return `${where} cannot be saved to a file: ${problem}`;
  const segments = [...parentSegments, node.name];
  const id = node.id !== undefined ? { id: node.id } : {};

  if (!containsScript(node)) {
    if (node.rbxmError !== undefined) return `${where} could not be serialized as a model file: ${node.rbxmError}`;
    const file = path.join(dir, `${node.name}.rbxm`);
    if (node.rbxm === undefined) out.needsSerialize = true;
    else out.ops.push({ kind: 'write', path: file, content: Buffer.from(node.rbxm, 'base64') });
    out.instances.push({ segments, className: node.className, file, ...id });
    return undefined;
  }

  if (node.extras && node.extras.length > 0) {
    return `${where} has ${node.extras.join(' and ')} that Roqer cannot save next to its scripts' files yet; create it without them`;
  }
  if (naming === undefined) return `${where}: the project's script naming could not be read`;
  const children = node.children ?? [];
  const seen = new Set<string>();
  for (const child of children) {
    const key = child.name.toLowerCase();
    if (seen.has(key)) return `${where} would hold two children named ${child.name} (file names ignore case), so their files would collide`;
    seen.add(key);
  }
  const folder = path.join(dir, node.name);
  if (SCRIPT_CLASSES.has(node.className)) {
    if (node.disabled) return `${where} is disabled, which needs a meta file Roqer does not write yet; create it enabled`;
    const suffix = scriptSuffix(node, naming);
    if (typeof suffix !== 'string') return `${where}: ${suffix.reason}`;
    const source = (node.source ?? '').replace(/\r\n?/g, '\n');
    const file = children.length === 0
      ? path.join(dir, `${node.name}${suffix}${naming.extension}`)
      : path.join(folder, `init${suffix}${naming.extension}`);
    if (children.length > 0) out.ops.push({ kind: 'mkdir', path: folder });
    out.ops.push({ kind: 'write', path: file, content: source });
    out.instances.push({ segments, className: node.className, file, source, ...id });
  } else {
    out.ops.push({ kind: 'mkdir', path: folder });
    if (node.className !== 'Folder') {
      out.ops.push({ kind: 'write', path: path.join(folder, 'init.meta.json'), content: `${JSON.stringify({ className: node.className }, null, 2)}\n` });
    }
    out.instances.push({ segments, className: node.className, ...id });
  }
  for (const child of children) {
    const reason = layoutNew(folder, segments, child, naming, out);
    if (reason) return reason;
  }
  return undefined;
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

/** How many sourcemap nodes are under `node`, not counting it. */
export function descendantCount(node: SourcemapNode): number {
  return (node.children ?? []).reduce((total, child) => total + 1 + descendantCount(child), 0);
}
