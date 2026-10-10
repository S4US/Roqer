import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { SourcemapNode } from './sourcemap.js';

export type Persistence = 'file' | 'studio_only' | 'generated' | 'unsupported';

export interface Ownership {
  persistence: Persistence;
  /** Absolute real path of the source file, for file and generated. */
  file?: string;
  /** The file relative to the project folder, as shown to the caller. */
  relativeFile?: string;
  reason?: string;
}

const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);
const isScriptFile = (file: string) => /\.luau?$/i.test(file);

/**
 * Finds the file Rojo builds a Studio script from, by walking the script's
 * name segments down Rojo's own sourcemap. Anything that cannot be matched to
 * exactly one script file is answered with why, never guessed.
 */
export function locateScript(
  tree: SourcemapNode,
  segments: string[],
  studioClassName: string | undefined,
  uniqueInStudio: boolean,
): { found: string } | Ownership {
  if (tree.className !== 'DataModel') {
    return { persistence: 'unsupported', reason: `the project's root is a ${tree.className}, not a place (DataModel)` };
  }
  if (!uniqueInStudio) {
    return { persistence: 'unsupported', reason: 'another instance on this script\'s path in Studio has the same name, so its file is ambiguous' };
  }
  let node = tree;
  for (const segment of segments) {
    const matches = (node.children ?? []).filter((child) => child.name === segment);
    if (matches.length === 0) {
      return { persistence: 'studio_only', reason: `${segment} is not in the Rojo project; this edit is saved in Studio only` };
    }
    if (matches.length > 1) {
      return { persistence: 'unsupported', reason: `the project has ${matches.length} instances named ${segment} under ${node.name}, so the file is ambiguous` };
    }
    node = matches[0];
  }
  if (!SCRIPT_CLASSES.has(node.className)) {
    return { persistence: 'unsupported', reason: `the project makes this a ${node.className}, not a script` };
  }
  if (studioClassName !== undefined && node.className !== studioClassName) {
    return { persistence: 'unsupported', reason: `Studio has a ${studioClassName} but the project makes a ${node.className}; the class does not match` };
  }
  const files = (node.filePaths ?? []).filter(isScriptFile);
  if (files.length === 0) {
    return { persistence: 'unsupported', reason: 'this script comes from a model or project file, not a script file of its own' };
  }
  if (files.length > 1) {
    return { persistence: 'unsupported', reason: `this script has ${files.length} source files, so the one to write is ambiguous` };
  }
  return { found: files[0] };
}

/**
 * Whether a project-relative path is a source file Roqer may write: inside the
 * project folder after resolving symlinks and junctions, a .lua or .luau file,
 * and not a package or build output.
 */
export function checkFile(
  root: string,
  relativePath: string,
  ignored: (realPath: string) => boolean,
  realpath: (p: string) => string | undefined = (p) => {
    try { return fs.realpathSync.native(p); } catch { return undefined; }
  },
): Ownership {
  if (!isScriptFile(relativePath)) {
    return { persistence: 'unsupported', reason: `${path.normalize(relativePath)} is not a .lua or .luau file` };
  }
  const real = realpath(path.resolve(root, relativePath));
  if (real === undefined) {
    return { persistence: 'unsupported', reason: `${path.normalize(relativePath)} is missing on disk; check the project file` };
  }
  const relative = path.relative(root, real);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return { persistence: 'unsupported', reason: `${path.normalize(relativePath)} resolves outside the project folder` };
  }
  if (relative.split(path.sep).includes('_Index') || ignored(real)) {
    return { persistence: 'generated', file: real, relativeFile: relative, reason: `${relative} is a package or build output, not source` };
  }
  return { persistence: 'file', file: real, relativeFile: relative };
}

export function scriptFiles(tree: SourcemapNode): string[] {
  const found = new Set<string>();
  const visit = (node: SourcemapNode) => {
    if (SCRIPT_CLASSES.has(node.className)) {
      for (const file of node.filePaths ?? []) if (isScriptFile(file)) found.add(file);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return [...found];
}

async function confirmedOutsideGit(root: string, environment: NodeJS.ProcessEnv, callerDirectory?: string): Promise<boolean> {
  // Exit 128 also covers broken configuration and unsafe/corrupt repositories.
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'].some(key => environment[key] !== undefined)) return false;
  let directory = path.resolve(root);
  for (let depth = 0; depth < 256; depth += 1) {
    try { fs.lstatSync(path.join(directory, '.git')); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return new Promise(resolve => {
        // Validate configuration without printing or retaining its values.
        execFile('git', ['-C', root, 'config', '--get', 'core.ignorecase'], {
          env: environment, ...(callerDirectory === undefined ? {} : { cwd: callerDirectory }),
          timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
        }, error => resolve(!error || (error as { code?: unknown }).code === 1));
      });
    }
    directory = parent;
  }
  return false;
}

/** The files Git ignores under root; delegation must confirm a non-repository failure. */
export function gitIgnored(root: string, files: string[], environment?: NodeJS.ProcessEnv, callerDirectory?: string): Promise<Set<string>> {
  if (files.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', root, 'check-ignore', '--stdin', '-z'], { ...(environment === undefined ? {} : { env: environment }), ...(callerDirectory === undefined ? {} : { cwd: callerDirectory }), timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      // Exit 1 means none are ignored; 128 means not a repository. Either way, nothing is ignored.
      if (error && (error as { code?: unknown }).code !== 1) {
        if (environment !== undefined) {
          const refusal = () => reject(new Error('The client Git environment could not verify ignored source files. No source operation ran.'));
          if ((error as { code?: unknown }).code === 128) {
            void confirmedOutsideGit(root, environment, callerDirectory).then(outside => outside ? resolve(new Set()) : refusal(), refusal);
            return;
          }
          return refusal();
        }
        return resolve(new Set());
      }
      resolve(new Set(String(stdout).split('\0').filter(Boolean).map((file) => path.resolve(root, file))));
    });
    // Git can exit (e.g. not a repository) before reading stdin; the write then fails with EPIPE.
    // The exit code above already decides the result, so a broken pipe is not an error here.
    child.stdin?.on('error', () => {});
    child.stdin?.end(files.join('\0') + '\0');
  });
}
