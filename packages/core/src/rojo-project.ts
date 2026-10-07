import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import type { BigIntStats } from 'node:fs';

type RecordValue = Record<string, unknown>;
type StudioCall = (endpoint: string, data: RecordValue) => Promise<RecordValue>;
export type RojoProjectConfig = { projectFile: string; instanceId: string; executable?: string; backupDirectory?: string };

const SCRIPT_ENDPOINTS = new Set([
  '/api/get-script-source', '/api/set-script-source', '/api/edit-script-lines',
  '/api/edit-script-batch', '/api/insert-script-lines', '/api/delete-script-lines',
]);
const SCRIPT_CLASSES = new Set(['Script', 'LocalScript', 'ModuleScript']);
const PLAYTEST_START_ENDPOINTS = new Set(['/api/start-playtest', '/api/multiplayer-test-start']);
const PLAYTEST_READINESS = '/roqer/rojo-playtest-readiness';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const normalize = (source: string) => source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const failure = (error: string, errorCode = 'rojo_mapping_unavailable'): RecordValue => ({ error, errorCode });
const fileIdentity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.nlink}`;

/** Configuration is host-owned. A model cannot choose a project, executable, or Studio binding. */
export function rojoProjectConfig(environment: NodeJS.ProcessEnv): RojoProjectConfig | undefined {
  const projectFile = environment.ROBLOX_STUDIO_ROJO_PROJECT?.trim();
  const instanceId = environment.ROBLOX_STUDIO_ROJO_INSTANCE_ID?.trim();
  if (!projectFile && !instanceId) return undefined;
  if (!projectFile || !instanceId) {
    throw new Error('Rojo requires both ROBLOX_STUDIO_ROJO_PROJECT and ROBLOX_STUDIO_ROJO_INSTANCE_ID; never infer a writable Studio target.');
  }
  if (!path.isAbsolute(projectFile) || !projectFile.endsWith('.project.json')) {
    throw new Error('ROBLOX_STUDIO_ROJO_PROJECT must be an absolute path to an existing .project.json file.');
  }
  return { projectFile, instanceId, executable: environment.ROBLOX_STUDIO_ROJO_EXECUTABLE?.trim() || undefined };
}

type MappedNode = { className: string; filePaths: string[]; ambiguous: boolean };

/** Consume Rojo's own mapping, including nested projects, init scripts, and ignore rules. */
function indexSourcemap(value: unknown): Map<string, MappedNode> {
  if (!record(value) || value.className !== 'DataModel') throw new Error('The Rojo project must describe a DataModel. Model-only projects are not supported.');
  const indexed = new Map<string, MappedNode>();
  const pending = [{ node: value, target: 'game', ambiguous: false }];
  let count = 0;
  while (pending.length > 0) {
    if (++count > 50000) throw new Error('The Rojo sourcemap exceeds 50,000 instances.');
    const { node, target, ambiguous } = pending.pop()!;
    if (target.length > 8192) throw new Error('A Rojo instance path exceeds 8,192 characters.');
    if (typeof node.className !== 'string' || (node.filePaths !== undefined &&
      (!Array.isArray(node.filePaths) || !node.filePaths.every((entry) => typeof entry === 'string')))) {
      throw new Error('Rojo returned an invalid sourcemap node.');
    }
    const duplicate = indexed.has(target);
    indexed.set(target, {
      className: node.className,
      filePaths: (node.filePaths as string[] | undefined) ?? [],
      ambiguous: ambiguous || duplicate || indexed.get(target)?.ambiguous === true,
    });
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('Rojo returned invalid sourcemap children.');
    for (const child of (node.children as unknown[] | undefined) ?? []) {
      if (!record(child) || typeof child.name !== 'string' || child.name.length === 0) throw new Error('Rojo returned an unnamed sourcemap child.');
      pending.push({ node: child, target: `${target}.${child.name}`, ambiguous: ambiguous || child.name.includes('.') });
    }
  }
  // Duplicate container paths make every descendant ambiguous as well.
  const duplicates = new Set([...indexed].filter(([, node]) => node.ambiguous).map(([target]) => target));
  for (const [target, node] of indexed) {
    for (let end = target.lastIndexOf('.'); end > 0; end = target.lastIndexOf('.', end - 1)) {
      if (duplicates.has(target.slice(0, end))) { node.ambiguous = true; break; }
    }
  }
  return indexed;
}

function splitLines(source: string): { lines: string[]; trailing: boolean } {
  const trailing = source.endsWith('\n');
  const lines = source.split('\n');
  if (trailing) lines.pop();
  if (lines.length === 0) lines.push('');
  return { lines, trailing };
}

function matchOffset(source: string, needle: string, startLine: unknown): number {
  if (needle.length === 0) throw new Error('old_string must not be empty.');
  const matches: number[] = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) matches.push(at);
  if (matches.length === 0) throw new Error('old_string not found in script. Read it again and copy the exact text, including indentation.');
  if (matches.length === 1) return matches[0];
  if (!Number.isInteger(startLine) || Number(startLine) < 1) throw new Error('old_string matches several locations. Provide more context or line_range.');
  let anchor = 0;
  for (let line = 1; line < Number(startLine); line++) {
    const newline = source.indexOf('\n', anchor);
    if (newline < 0) throw new Error('line_range is past the end of the script. Provide more context.');
    anchor = newline + 1;
  }
  return matches.reduce((best, at) => Math.abs(at - anchor) < Math.abs(best - anchor) ? at : best);
}

/** Same literal, anchored, non-overlapping edits as the public Studio script operations. */
function editedSource(endpoint: string, data: RecordValue, source: string): string {
  if (endpoint === '/api/set-script-source') {
    if (typeof data.source !== 'string') throw new Error('source must be a string.');
    return normalize(data.source);
  }
  if (endpoint === '/api/edit-script-lines' || endpoint === '/api/edit-script-batch') {
    const edits = endpoint === '/api/edit-script-lines' ? [data] : data.edits;
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > 20) throw new Error('edits must contain between one and twenty entries.');
    const resolved = edits.map((edit: unknown) => {
      if (!record(edit) || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') throw new Error('Every edit needs string old_string and new_string.');
      const needle = normalize(edit.old_string);
      const start = matchOffset(source, needle, edit.startLine);
      return { start, end: start + needle.length, replacement: normalize(edit.new_string) };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < resolved.length; i++) if (resolved[i].start < resolved[i - 1].end) throw new Error('Edits overlap. Combine them into one edit.');
    let result = '';
    let cursor = 0;
    for (const edit of resolved) {
      result += source.slice(cursor, edit.start) + edit.replacement;
      cursor = edit.end;
    }
    return result + source.slice(cursor);
  }
  const { lines, trailing } = splitLines(source);
  if (endpoint === '/api/insert-script-lines') {
    if (!Number.isInteger(data.afterLine) || Number(data.afterLine) < 0 || Number(data.afterLine) > lines.length || typeof data.newContent !== 'string' || data.newContent === '') throw new Error('afterLine or newContent is invalid.');
    lines.splice(Number(data.afterLine), 0, ...splitLines(normalize(data.newContent)).lines);
  } else if (endpoint === '/api/delete-script-lines') {
    if (!Number.isInteger(data.startLine) || !Number.isInteger(data.endLine) || Number(data.startLine) < 1 || Number(data.endLine) < Number(data.startLine) || Number(data.endLine) > lines.length) throw new Error('startLine or endLine is out of range.');
    lines.splice(Number(data.startLine) - 1, Number(data.endLine) - Number(data.startLine) + 1);
  } else throw new Error('Unsupported Rojo script operation.');
  const result = lines.join('\n');
  return trailing && !result.endsWith('\n') ? `${result}\n` : result;
}

type FileSnapshot = { file: string; bytes: Buffer; source: string; revision: string; mode: number; identity: string; directories: string };

/** An opt-in, existing-file backend for the existing MCP script surface. */
export class RojoScriptProject {
  private queue: Promise<unknown> = Promise.resolve();
  private managedScripts = new Set<string>();
  private pendingWrites = new Map<string, string>();
  private selectedRoot?: { project: string; root: string; ino: number; dev: number };

  constructor(readonly config: RojoProjectConfig, private readonly sourcemap = async (signal?: AbortSignal): Promise<unknown> => {
    const { stdout } = await promisify(execFile)(config.executable ?? 'rojo',
      ['sourcemap', '--include-non-scripts', '--absolute', config.projectFile],
      { cwd: path.dirname(config.projectFile), timeout: 8000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal });
    return JSON.parse(stdout);
  }, private readonly openFile: typeof fs.open = fs.open) {}

  handles(endpoint: string, instanceId: string): boolean {
    return instanceId === this.config.instanceId && (SCRIPT_ENDPOINTS.has(endpoint) || endpoint === '/api/find-and-replace-in-scripts');
  }

  /** The primary checks again after runtime approval, including starts in a later run. */
  async checkPlaytestStart(endpoint: string, instanceId: string, role: string, studio: StudioCall, signal?: AbortSignal): Promise<RecordValue | undefined> {
    if (instanceId !== this.config.instanceId || !PLAYTEST_START_ENDPOINTS.has(endpoint)) return undefined;
    const checked = await this.handle(PLAYTEST_READINESS, {}, role, studio, signal);
    return checked.success === true ? undefined : checked;
  }

  handle(endpoint: string, data: RecordValue, role: string, studio: StudioCall, callerSignal?: AbortSignal): Promise<RecordValue> {
    const cancellation = new AbortController();
    const cancelled = () => cancellation.abort(callerSignal?.reason ?? new Error('Tool call was cancelled.'));
    if (callerSignal?.aborted) cancelled();
    else callerSignal?.addEventListener('abort', cancelled, { once: true });
    // Includes queue time. Do not keep a filesystem mutation pending past the ordinary client's 20s budget.
    const timer = setTimeout(() => cancellation.abort(new Error('Rojo operation exceeded its 18-second budget.')), 18000);
    // Serialize this project's operations so concurrent Roqer writes cannot pass the same comparison.
    const result = this.queue.catch(() => undefined).then(async () => {
      try { cancellation.signal.throwIfAborted(); return await this.perform(endpoint, data, role, studio, cancellation.signal); }
      catch (error) { return failure(`Rojo operation refused: ${error instanceof Error ? error.message : String(error)}`, cancellation.signal.aborted ? 'rojo_operation_cancelled' : (error as NodeJS.ErrnoException).code === 'ELOCKED' ? 'rojo_write_locked' : 'rojo_mapping_unavailable'); }
      finally { clearTimeout(timer); callerSignal?.removeEventListener('abort', cancelled); }
    });
    this.queue = result;
    return result;
  }

  private async mappedFile(target: string, className: string, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted();
    const node = indexSourcemap(await this.sourcemap(signal)).get(target);
    signal.throwIfAborted();
    if (!node) return undefined; // An instance absent from Rojo's graph is Studio-owned.
    if (node.ambiguous || node.className !== className) throw new Error(`Ambiguous or mismatched Rojo mapping for ${target}.`);
    if (!SCRIPT_CLASSES.has(node.className)) throw new Error(`${target} is not a mapped script.`);
    const sources = node.filePaths.filter((file) => /\.(lua|luau)$/.test(file));
    if (sources.length !== 1) throw new Error(`${target} has no unique editable Lua/Luau source file. Generated JSON/TOML/model sources are not supported by this backend.`);
    const file = path.resolve(path.dirname(this.config.projectFile), sources[0]);
    await this.validatePath(file, signal);
    return file;
  }

  /** Recheck directory identities after every external wait, rather than following a newly introduced junction. */
  private async validatePath(file: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const project = await fs.realpath(this.config.projectFile);
    const root = path.dirname(project);
    const rootStat = await fs.lstat(root);
    if (this.selectedRoot === undefined) this.selectedRoot = { project, root, ino: rootStat.ino, dev: rootStat.dev };
    if (project !== this.selectedRoot.project || rootStat.ino !== this.selectedRoot.ino || rootStat.dev !== this.selectedRoot.dev) throw new Error('The selected Rojo project directory moved or was replaced. Reconfigure the binding.');
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Rojo source is outside the selected project directory: ${file}`);
    // Refuse links/junctions instead of following them into an unapproved directory or replacing an alias.
    let part = root;
    const identities: string[] = [];
    for (const component of relative.split(path.sep)) {
      part = path.join(part, component);
      const stat = await fs.lstat(part);
      if (stat.isSymbolicLink()) throw new Error(`Rojo source paths must not contain symlinks or junctions: ${part}`);
      if (part !== file) identities.push(`${stat.dev}:${stat.ino}`);
    }
    if (path.relative(file, await fs.realpath(file)) !== '') throw new Error('Rojo source no longer resolves to the checked path.');
    signal.throwIfAborted();
    return identities.join('/');
  }

  private async readFile(file: string, target: string, signal: AbortSignal): Promise<FileSnapshot> {
    const directories = await this.validatePath(file, signal);
    const opened = await this.openFile(file, 'r');
    try {
      const stat = await opened.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_SOURCE_BYTES)) throw new Error('Rojo sources must be regular files with one hard link, at most 2 MiB.');
      const bytes = await opened.readFile();
      if (directories !== await this.validatePath(file, signal)) throw new Error('Rojo source directories changed during the read.');
      const descriptor = await opened.stat({ bigint: true });
      const named = await fs.lstat(file, { bigint: true });
      if (fileIdentity(stat) !== fileIdentity(descriptor) || fileIdentity(descriptor) !== fileIdentity(named)) throw new Error('Source revision conflict; the file changed or was atomically replaced during the read.');
      if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Rojo source exceeds 2 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { file, bytes, source: normalize(text), mode: Number(stat.mode), identity: fileIdentity(named), directories,
        revision: `rojo:${hash(`${target}\0${file}\0${hash(bytes)}`)}` };
    } finally { await opened.close(); }
  }

  private dataDirectory(): string { return this.config.backupDirectory ?? path.join(homedir(), '.robloxstudio-mcp', 'rojo-backups'); }

  private async writeLease(file: string, signal: AbortSignal): Promise<{ release: () => Promise<void>; check: () => void }> {
    const directory = path.join(this.dataDirectory(), 'write-leases');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const release = await lockfile.lock(file, {
      lockfilePath: path.join(directory, `${hash(await fs.realpath(file))}.lock`),
      stale: 30000, update: 1000, retries: 0,
      onCompromised: (error) => { compromised = error; },
    });
    return { release, check: () => { signal.throwIfAborted(); if (compromised) throw compromised; } };
  }

  private async backup(snapshot: FileSnapshot): Promise<string> {
    // Recovery bytes live in host-owned data, outside Rojo's source graph. No Git commands or project files are added.
    const directory = path.join(this.dataDirectory(), hash(snapshot.file));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${hash(snapshot.bytes)}.bak`);
    try { await fs.writeFile(file, snapshot.bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await fs.readFile(file)).equals(snapshot.bytes)) throw new Error('The existing recovery copy is damaged; refusing to write.');
    }
    return file;
  }

  private async perform(endpoint: string, data: RecordValue, role: string, studio: StudioCall, signal: AbortSignal): Promise<RecordValue> {
    if (role !== 'edit') return failure('Rojo scripts require the explicitly bound edit-mode Studio instance.', 'rojo_edit_mode_required');
    if (endpoint === PLAYTEST_READINESS) {
      // This ledger lives on the primary, beyond any one desktop runner. Recheck
      // even previously synchronized sources: disk/Studio can change during approval.
      for (const target of this.managedScripts) {
        const read = await this.perform('/api/get-script-source', { instancePath: target, startLine: 1 }, role, studio, signal);
        if (read.error || read.sourceOrigin !== 'rojo' || read.syncStatus !== 'synced') {
          return { ...failure('Playtest was not started: a previously read or written Rojo script is not verified in Studio. Connect/sync Rojo and read it again.', 'rojo_sync_pending'),
            success: false, instancePath: target, filePath: read.filePath, revision: read.revision, syncStatus: read.syncStatus,
            reason: read.error };
        }
      }
      return { success: true };
    }
    if (endpoint === '/api/find-and-replace-in-scripts') return failure('Bulk Studio script replacement is disabled for a Rojo-bound instance. Read and edit each script through the structured script tools.', 'rojo_bulk_write_unsupported');
    let observed = await studio('/api/get-script-source', { instancePath: data.instancePath, instanceRef: data.instanceRef, startLine: 1 });
    signal.throwIfAborted();
    if (observed.error) return observed;
    if (typeof observed.instancePath !== 'string' || typeof observed.className !== 'string' || typeof observed.instanceRef !== 'string' || typeof observed.source !== 'string') throw new Error('Studio did not return a complete, resolved script identity and source.');
    const target = observed.instancePath;
    const mappedClass = observed.className;
    const file = await this.mappedFile(target, mappedClass, signal);
    if (!file) {
      if (this.managedScripts.has(target) || (typeof data.expectedRevision === 'string' && data.expectedRevision.startsWith('rojo:'))) {
        return failure('The previously mapped script is absent from the Rojo sourcemap now. Resolve the mapping before writing; Studio source was not changed.');
      }
      return studio(endpoint, data);
    }
    this.managedScripts.add(target);
    let snapshot = await this.readFile(file, target, signal);
    const identity = { instancePath: target, instanceRef: observed.instanceRef, sourceOrigin: 'rojo', filePath: file };
    if (endpoint === '/api/get-script-source') {
      // A write reaches disk first. Give the already-running Rojo connection a short bounded chance to sync.
      const deadline = Date.now() + 2000;
      while (this.pendingWrites.get(target) === snapshot.revision && normalize(String(observed.source)) !== snapshot.source && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        signal.throwIfAborted();
        observed = await studio('/api/get-script-source', { instancePath: target, instanceRef: identity.instanceRef, startLine: 1 });
        if (observed.error || observed.instancePath !== target) break;
      }
      if (await this.mappedFile(target, mappedClass, signal) !== file) throw new Error('Rojo mapping changed while reading back.');
      snapshot = await this.readFile(file, target, signal);
      const synced = !observed.error && observed.instancePath === target && observed.instanceRef === identity.instanceRef && normalize(String(observed.source)) === snapshot.source;
      if (synced) this.pendingWrites.delete(target);
      const { lines, trailing } = splitLines(snapshot.source);
      const explicit = data.startLine !== undefined || data.endLine !== undefined;
      const truncated = !explicit && (snapshot.source.length > 25000 || lines.length > 400);
      const start = Math.max(1, Number(data.startLine ?? 1));
      const end = Math.min(lines.length, truncated ? 300 : Number(data.endLine ?? lines.length));
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error('Script line range must use integer lines.');
      const selected = lines.slice(start - 1, end);
      return { ...observed, ...identity, className: observed.className, revision: snapshot.revision,
        lineCount: lines.length, sourceLength: snapshot.source.length, startLine: start, endLine: end, isPartial: explicit, truncated,
        source: selected.join('\n') + (trailing && end === lines.length ? '\n' : ''),
        numberedSource: selected.map((line, i) => `${start + i}: ${line}`).join('\n'), syncStatus: synced ? 'synced' : 'pending',
        note: `Source is ${path.relative(path.dirname(this.config.projectFile), file)} on disk. ${synced ? 'Rojo and Studio match.' : 'Studio does not match disk yet; connect/sync Rojo before writing or playtesting.'}` +
          (truncated ? ` Truncated to the first ${end} of ${lines.length} lines; use line_range for more.` : '') };
    }
    const lease = await this.writeLease(file, signal);
    try {
      lease.check();
      snapshot = await this.readFile(file, target, signal); // Another bridge may have written before this lease was acquired.
      const expected = data.expectedRevision;
      if (typeof expected !== 'string') return { ...identity, ...failure('Rojo script writes require expectedRevision from get_script_source, including exact and line-addressed edits.', 'rojo_revision_required') };
      if (expected !== snapshot.revision) return { ...identity, ...failure('Source revision conflict; the file or its mapping changed after the read. Read it again before writing.', 'source_revision_conflict'), expectedRevision: expected, actualRevision: snapshot.revision };
      if (normalize(observed.source) !== snapshot.source) return { ...identity, ...failure('Studio and the Rojo file differ. Sync Rojo or resolve the Studio edit before writing; neither copy was changed.', 'rojo_sync_conflict') };
      const source = editedSource(endpoint, data, snapshot.source);
      const text = snapshot.bytes.toString('utf8');
      if (new Set(text.match(/\r\n|\r|\n/g) ?? []).size > 1) throw new Error('Rojo file has mixed newline conventions. Normalize it in your editor before writing; nothing was changed.');
      // Preserve the existing file's BOM and newline convention. Compare revisions over the actual bytes.
      const eol = text.includes('\r\n') ? '\r\n' : text.includes('\r') && !text.includes('\n') ? '\r' : '\n';
      const bytes = Buffer.from((text.startsWith('\uFEFF') ? '\uFEFF' : '') + source.replace(/\n/g, eol));
      if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Edited Rojo source exceeds 2 MiB.');
      let syntax: RecordValue;
      let backupPath: string | undefined;
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.roqer-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: snapshot.mode });
        await fs.chmod(temporary, snapshot.mode);
        // Regenerate the mapping and compare the original file immediately before the atomic replacement.
        if (await this.mappedFile(target, mappedClass, signal) !== file) throw new Error('Rojo mapping changed during the write; nothing was changed.');
        // This check runs after mapping generation, so a Studio edit or renamed instance during that work is refused too.
        if (!bytes.equals(snapshot.bytes)) backupPath = await this.backup(snapshot);
        syntax = await studio('/api/check-script-source', { instancePath: target, instanceRef: identity.instanceRef, expectedRevision: observed.revision, source });
        lease.check();
        if (syntax.error) return { ...identity, ...syntax };
        if (syntax.instancePath !== target || syntax.instanceRef !== identity.instanceRef) throw new Error('Studio resolved a different script during validation.');
        const current = await this.readFile(file, target, signal);
        if (current.revision !== snapshot.revision || current.identity !== snapshot.identity || current.directories !== snapshot.directories) return { ...identity, ...failure('Source revision conflict; the file changed during the write. Read it again.', 'source_revision_conflict'), expectedRevision: snapshot.revision, actualRevision: current.revision };
        if (await this.validatePath(file, signal) !== snapshot.directories) throw new Error('Rojo source directories changed before replacement.');
        if (fileIdentity(await fs.lstat(file, { bigint: true })) !== current.identity) throw new Error('Source revision conflict; the file changed immediately before replacement.');
        lease.check();
        if (!bytes.equals(snapshot.bytes)) await fs.rename(temporary, file);
      } finally { await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
      const expectedAfter = `rojo:${hash(`${target}\0${file}\0${hash(bytes)}`)}`;
      let verified = false;
      let readbackError: string | undefined;
      try { verified = (await this.readFile(file, target, signal)).revision === expectedAfter; }
      catch (error) { readbackError = error instanceof Error ? error.message : String(error); }
      this.pendingWrites.set(target, expectedAfter);
      return { ...identity, success: true, method: 'rojo-file', previousRevision: snapshot.revision, revision: expectedAfter,
        ...(backupPath === undefined ? {} : { backupPath }),
        syncStatus: bytes.equals(snapshot.bytes) ? 'synced' : 'pending', fileVerified: verified,
        ...(readbackError === undefined ? {} : { readbackError }),
        oldSourceLength: snapshot.source.length, newSourceLength: source.length,
        ...(syntax.syntaxError === undefined ? {} : { syntaxError: syntax.syntaxError }),
        ...(syntax.syntaxCheck === undefined ? {} : { syntaxCheck: syntax.syntaxCheck }),
        message: 'Updated the existing source file on disk. The running Rojo connection owns synchronization into Studio; read back before playtesting.' };
    } finally { await lease.release().catch((error) => console.warn('[roqer:rojo] Could not release the write lease:', error.message)); }
  }
}
