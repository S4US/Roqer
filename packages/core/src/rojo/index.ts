import * as fs from 'fs';
import * as path from 'path';
import { checkFile, gitIgnored, locateScript, scriptFiles, type Ownership, type Persistence } from './ownership.js';
import { parseInstancePath } from './instance-path.js';
import {
  NewFilesError, containsScript, createNew, layoutNew, nameInDirectory, nodeAt, projectDirectory, projectNaming, removeNew,
  type NewEntry, type NewInstance, type PlannedTop,
} from './new-files.js';
import { probeRojoServer } from './rojo-server.js';
import { RojoError, execRojo, loadSourcemap, rojoVersion, type RojoRunner, type SourcemapNode } from './sourcemap.js';

export { RojoError } from './sourcemap.js';
export type { Ownership, Persistence } from './ownership.js';
export { NewFilesError, containsScript } from './new-files.js';
export type { NewInstance, PlannedNode, PlannedTop } from './new-files.js';

/**
 * Where one new instance tree of a build belongs on a linked place: saved as
 * files, made in Studio only (`scripts` says whether it holds any), or
 * refused with why.
 */
export type NewPlacement =
  | { persistence: 'studio_only'; scripts: boolean; reason?: string }
  | { persistence: 'file'; entries: NewEntry[]; instances: NewInstance[] }
  | { persistence: 'generated' | 'unsupported'; reason: string; relativeFile?: string };

export type FilePlacement = Extract<NewPlacement, { persistence: 'file' }>;

const DEFAULT_SERVE_PORT = 34872;
const READ_CACHE_MS = 10_000;
const MAX_PROBLEMS = 5;

export interface ProjectLink {
  instanceId: string;
  projectFile: string;
  root: string;
  projectName: string;
  rojoVersion: string;
  port: number;
}

export interface LinkSummary {
  project: string;
  root: string;
  rojoVersion: string;
  scripts: Record<Persistence, number>;
  problems: string[];
  rojoServer: { port: number; reachable: boolean; matches?: boolean };
}

interface Deps {
  run?: RojoRunner;
  ignored?: typeof gitIgnored;
  probe?: typeof probeRojoServer;
  now?: () => number;
}

/**
 * Which Rojo project each connected place is linked to, and what Rojo's
 * sourcemap says about its scripts. Links live as long as this server.
 */
export class RojoIntegration {
  private readonly links = new Map<string, ProjectLink>();
  private readonly cache = new Map<string, { at: number; tree: SourcemapNode }>();
  private readonly run: RojoRunner;
  private readonly ignored: typeof gitIgnored;
  private readonly probeServer: typeof probeRojoServer;
  private readonly now: () => number;

  constructor(deps: Deps = {}) {
    this.run = deps.run ?? execRojo;
    this.ignored = deps.ignored ?? gitIgnored;
    this.probeServer = deps.probe ?? probeRojoServer;
    this.now = deps.now ?? Date.now;
  }

  hasLinks(): boolean {
    return this.links.size > 0;
  }

  linkFor(instanceId: string | undefined): ProjectLink | undefined {
    return instanceId === undefined ? undefined : this.links.get(instanceId);
  }

  unlink(instanceId: string): boolean {
    const link = this.links.get(instanceId);
    if (link) this.cache.delete(link.projectFile);
    return this.links.delete(instanceId);
  }

  async link(instanceId: string, projectPath: string): Promise<LinkSummary> {
    if (!/\.project\.json$/i.test(projectPath)) {
      throw new RojoError('rojo_link_invalid', 'project must be a Rojo *.project.json file, such as default.project.json');
    }
    let projectFile: string;
    try {
      projectFile = fs.realpathSync.native(path.resolve(projectPath));
      if (!fs.statSync(projectFile).isFile()) throw new Error('not a file');
    } catch {
      throw new RojoError('rojo_link_invalid', `No project file at ${projectPath}`);
    }
    for (const other of this.links.values()) {
      if (other.projectFile === projectFile && other.instanceId !== instanceId) {
        throw new RojoError('rojo_link_invalid', `${path.basename(projectFile)} is already linked to ${other.instanceId}; unlink it there first`);
      }
    }
    let config: { name?: unknown; servePort?: unknown };
    try {
      config = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    } catch {
      throw new RojoError('rojo_link_invalid', `${path.basename(projectFile)} is not valid JSON`);
    }
    const root = path.dirname(projectFile);
    const version = await rojoVersion(this.run, root);
    const tree = await loadSourcemap(projectFile, this.run);
    if (tree.className !== 'DataModel') {
      throw new RojoError('rojo_link_invalid', `${path.basename(projectFile)} builds a ${tree.className}, not a place; link the place's project file`);
    }
    const link: ProjectLink = {
      instanceId,
      projectFile,
      root,
      projectName: typeof config.name === 'string' ? config.name : path.basename(root),
      rojoVersion: version,
      port: typeof config.servePort === 'number' ? config.servePort : DEFAULT_SERVE_PORT,
    };
    this.links.set(instanceId, link);
    this.cache.set(projectFile, { at: this.now(), tree });

    const files = scriptFiles(tree);
    const ignored = await this.ignored(root, files.map((file) => path.resolve(root, file)));
    const scripts: Record<Persistence, number> = { file: 0, studio_only: 0, generated: 0, unsupported: 0 };
    const problems: string[] = [];
    for (const file of files) {
      const owner = checkFile(root, file, (real) => ignored.has(real) || ignored.has(path.resolve(root, file)));
      scripts[owner.persistence] += 1;
      if (owner.persistence === 'unsupported' && problems.length < MAX_PROBLEMS && owner.reason) problems.push(owner.reason);
    }
    return {
      project: path.basename(projectFile),
      root,
      rojoVersion: version,
      scripts,
      problems,
      rojoServer: { port: link.port, ...(await this.probe(link)) },
    };
  }

  async probe(link: ProjectLink): Promise<{ reachable: boolean; matches?: boolean }> {
    const server = await this.probeServer(link.port);
    return server.reachable
      ? { reachable: true, ...(server.projectName !== undefined ? { matches: server.projectName === link.projectName } : {}) }
      : { reachable: false };
  }

  async resolve(
    link: ProjectLink,
    segments: string[],
    studioClassName: string | undefined,
    uniqueInStudio: boolean,
    options: { fresh: boolean },
  ): Promise<Ownership> {
    const cached = this.cache.get(link.projectFile);
    let tree = cached?.tree;
    if (!cached || !tree || options.fresh || this.now() - cached.at > READ_CACHE_MS) {
      tree = await loadSourcemap(link.projectFile, this.run);
      this.cache.set(link.projectFile, { at: this.now(), tree });
    }
    const located = locateScript(tree, segments, studioClassName, uniqueInStudio);
    if (!('found' in located)) return located;
    const absolute = path.resolve(link.root, located.found);
    const ignored = await this.ignored(link.root, [absolute]);
    return checkFile(link.root, located.found, (real) => ignored.has(real) || ignored.has(absolute));
  }

  /**
   * Where each new instance tree a build would add belongs. A tree with a
   * script in it, going into an instance the project gives a folder, becomes
   * files there; one going anywhere else stays in Studio, as before. Anything
   * that would be ambiguous, collide, or need more than a name, class, and
   * source to describe is refused rather than half-saved.
   */
  async placeNew(link: ProjectLink, tops: PlannedTop[]): Promise<NewPlacement[]> {
    // Read only once a script needs a folder: a build with no new scripts must
    // not start depending on Rojo, or on the project file being valid.
    let tree: SourcemapNode | undefined;
    const sourcemap = async () => (tree ??= await loadSourcemap(link.projectFile, this.run, { nonScripts: true }));
    const claimed = new Set<string>();
    const placements: NewPlacement[] = [];
    for (const top of tops) {
      const name = top.node.name;
      if (!containsScript(top.node)) {
        placements.push({ persistence: 'studio_only', scripts: false });
        continue;
      }
      const segments = parseInstancePath(top.parentPath);
      if (!segments) {
        placements.push({ persistence: 'unsupported', reason: `${top.parentPath} could not be matched to the project` });
        continue;
      }
      const located = projectDirectory(link.projectFile, segments);
      if ('reason' in located) {
        placements.push({ persistence: 'studio_only', scripts: true, reason: located.reason });
        continue;
      }
      let dir: string;
      try {
        dir = fs.realpathSync.native(located.dir);
      } catch {
        placements.push({ persistence: 'unsupported', reason: `the folder for ${top.parentPath} is missing on disk` });
        continue;
      }
      const relativeDir = path.relative(link.root, dir);
      if (relativeDir === '..' || relativeDir.startsWith('..' + path.sep) || path.isAbsolute(relativeDir)) {
        placements.push({ persistence: 'unsupported', reason: `the folder for ${top.parentPath} resolves outside the project folder` });
        continue;
      }
      const shown = (file: string) => path.relative(link.root, file) || '.';
      const refuse = (reason: string) => placements.push({ persistence: 'unsupported', reason });
      if (!top.parentUnique) {
        refuse(`another instance on the path to ${top.parentPath} in Studio has the same name, so where ${name} goes is ambiguous`);
        continue;
      }
      const parentNode = nodeAt(await sourcemap(), segments);
      if (!parentNode) {
        refuse(`Rojo's sourcemap does not list ${top.parentPath} exactly once, so ${shown(dir)} cannot be matched to it`);
        continue;
      }
      if (top.nameTaken || (parentNode.children ?? []).some((child) => child.name === name)) {
        refuse(`${top.parentPath} already has a child named ${name}; a second would make its path ambiguous`);
        continue;
      }
      const existing = nameInDirectory(dir, name);
      const key = path.join(dir, name.toLowerCase());
      if (existing !== undefined || claimed.has(key)) {
        refuse(`${shown(path.join(dir, existing ?? name))} would collide with the new ${name} (file names ignore case)`);
        continue;
      }
      claimed.add(key);
      const naming = projectNaming(located, await sourcemap());
      if ('reason' in naming) {
        refuse(naming.reason);
        continue;
      }
      const entries: NewEntry[] = [];
      const instances: NewInstance[] = [];
      const reason = layoutNew(dir, segments, top.node, naming, entries, instances);
      if (reason) {
        refuse(reason);
        continue;
      }
      const ignored = await this.ignored(link.root, entries.map((entry) => entry.path));
      const generated = entries.find((entry) => ignored.has(entry.path) || path.relative(link.root, entry.path).split(path.sep).includes('_Index'));
      if (generated) {
        placements.push({
          persistence: 'generated',
          relativeFile: shown(generated.path),
          reason: `${shown(generated.path)} would be package or build output, not source`,
        });
        continue;
      }
      placements.push({ persistence: 'file', entries, instances });
    }
    return placements;
  }

  /**
   * Creates the planned files, then reads Rojo's sourcemap back to check it
   * makes exactly the planned instances from them. Anything else (a glob the
   * project ignores, a name Rojo reads differently) takes every new file back
   * out and rejects with NewFilesError (`rojo_unsupported`), as does a write
   * that fails (`rojo_write_failed`); either names any file it could not
   * remove. Resolves with the new files, relative to the project folder.
   */
  async saveNew(link: ProjectLink, placements: FilePlacement[]): Promise<string[]> {
    const entries = placements.flatMap((placement) => placement.entries);
    const instances = placements.flatMap((placement) => placement.instances);
    const created = await createNew(entries);
    // Script ownership is read from a cached sourcemap; it no longer matches the files.
    this.cache.delete(link.projectFile);
    // Rojo names a file by the path the project gave it, which may run through a link.
    const real = (file: string) => {
      try {
        return fs.realpathSync.native(file);
      } catch {
        return file;
      }
    };
    let mismatch: string | undefined;
    try {
      const tree = await loadSourcemap(link.projectFile, this.run, { nonScripts: true });
      for (const instance of instances) {
        const where = instance.segments.join('.');
        const node = nodeAt(tree, instance.segments);
        if (!node) mismatch = `it lists no single ${where}`;
        else if (node.className !== instance.className) mismatch = `it makes ${where} a ${node.className}, not a ${instance.className}`;
        else if (instance.file && !(node.filePaths ?? []).some((file) => real(path.resolve(link.root, file)) === instance.file)) {
          mismatch = `it does not read ${where} from ${path.relative(link.root, instance.file)}`;
        }
        if (mismatch) break;
      }
    } catch (error) {
      throw new NewFilesError(error, await removeNew(created));
    }
    if (mismatch) {
      throw new NewFilesError(`Rojo did not read the new files as planned (${mismatch})`, await removeNew(created), 'rojo_unsupported');
    }
    return entries.filter((entry) => entry.kind === 'file').map((entry) => path.relative(link.root, entry.path));
  }
}
