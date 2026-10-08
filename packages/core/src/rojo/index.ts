import * as fs from 'fs';
import * as path from 'path';
import { checkFile, gitIgnored, locateScript, scriptFiles, type Ownership, type Persistence } from './ownership.js';
import { probeRojoServer } from './rojo-server.js';
import { RojoError, execRojo, loadSourcemap, rojoVersion, type RojoRunner, type SourcemapNode } from './sourcemap.js';

export { RojoError } from './sourcemap.js';
export type { Ownership, Persistence } from './ownership.js';

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
}
