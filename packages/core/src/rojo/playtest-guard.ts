import * as fs from 'fs';
import * as path from 'path';
import { sourceRevision } from './source-revision.js';
import { toStudioText } from './text-format.js';
import { createIdentityHistory, rememberIdentities, historicalIdentities, type StudioOwner } from './identity-history.js';

export interface RojoScriptObservation {
  revision?: string;
  instancePath?: string;
  instanceRef?: string;
  className?: string;
  missing?: boolean;
  error?: string;
  uniquePath?: boolean;
}

export interface RojoScriptResolution {
  persistence: 'file' | 'studio_only' | 'generated' | 'unsupported' | 'unknown';
  file?: string;
  reason?: string;
}

export interface TrackedRojoWrite {
  instanceId: string;
  instancePath: string;
  instanceRef?: string;
  className?: string;
  file: string;
  studioOwner?: StudioOwner;
  inspect: () => Promise<RojoScriptObservation>;
  resolve: (observation: RojoScriptObservation) => Promise<RojoScriptResolution>;
}

export type RojoWriteToken = symbol;
export type RojoPlaytestRefusalCode = 'rojo_sync_pending' | 'rojo_sync_unknown' | 'rojo_write_in_progress';
export interface RojoPlaytestAdmission {
  refusal?: Record<string, unknown>;
  error?: string;
  /** Release only after the admitted start RPC has settled, including failure. */
  done?: () => void;
  /** Last synchronous disk check immediately before the start is enqueued. */
  recheck?: () => Record<string, unknown> | undefined;
}

export interface RojoPlaytestGuardOptions {
  equivalentIds: (id: string) => string[];
  liveInstanceIds?: () => string[];
  resolveInstanceId?: (id: string) => string | undefined;
  currentStudioOwner?: (owner: StudioOwner) => StudioOwner | undefined;
  /** Full ledgers refuse new scripts; pending records are never evicted. */
  maxEntries?: number;
}

interface Reservation {
  entry: TrackedRojoWrite;
  fileKey: string;
}

interface StartTicket {
  instanceId: string;
  fileKeys: Set<string>;
  studioOwner?: StudioOwner;
}

type FileObservation = { revision: string; missing?: false; error?: undefined }
  | { revision?: undefined; missing: true; error?: undefined }
  | { revision?: undefined; missing?: false; error: string };

const START_ENDPOINTS = new Set(['/api/start-playtest', '/api/multiplayer-test-start']);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Match already resolved paths, including aliases of an existing source file. */
function fileKey(file: string): string {
  let real = path.resolve(file);
  try { real = fs.realpathSync.native(real); } catch { /* Missing files still have a stable path key. */ }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

async function readFile(file: string): Promise<FileObservation> {
  try {
    return { revision: sourceRevision(toStudioText(await fs.promises.readFile(file))) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { missing: true }
      : { error: messageOf(error) };
  }
}

/**
 * Primary-side ledger and admission barrier for Rojo-backed writes. Callbacks
 * inspect the intended Studio instance and refresh ownership; no Studio or
 * routing implementation is owned here. A synced record is retained because
 * the current file can change again before the next start.
 */
export class RojoPlaytestGuard {
  private readonly entries: TrackedRojoWrite[] = [];
  private readonly writes = new Map<RojoWriteToken, Reservation>();
  private readonly starts = new Set<StartTicket>();
  private readonly equivalentIds: (id: string) => string[];
  private readonly liveInstanceIds?: () => string[];
  private readonly resolveInstanceId?: (id: string) => string | undefined;
  private readonly currentStudioOwner?: (owner: StudioOwner) => StudioOwner | undefined;
  private readonly maxEntries: number;
  private readonly identities = createIdentityHistory();

  constructor(options: RojoPlaytestGuardOptions) {
    this.equivalentIds = options.equivalentIds;
    this.liveInstanceIds = options.liveInstanceIds;
    this.resolveInstanceId = options.resolveInstanceId;
    this.currentStudioOwner = options.currentStudioOwner;
    this.maxEntries = options.maxEntries ?? 1024;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer');
    }
  }

  beginWrite(entry: TrackedRojoWrite): RojoWriteToken {
    this.rememberInstanceIds([entry.instanceId, ...this.equivalentIds(entry.instanceId)]);
    const key = fileKey(entry.file);
    for (const start of this.starts) {
      if ((start.studioOwner && entry.studioOwner
        ? start.studioOwner.physicalSessionId === entry.studioOwner.physicalSessionId
        : this.matchesInstance(entry, start.instanceId)) || start.fileKeys.has(key)) {
        throw this.busy('rojo_start_in_progress', 'A playtest start is validating or dispatching this Rojo write target; retry after it finishes.');
      }
    }
    for (const write of this.writes.values()) {
      if (write.fileKey === key || this.sameScript(write.entry, entry)) {
        throw this.busy('rojo_write_in_progress', 'Another Rojo write is still in progress for this script or source file.');
      }
    }
    const replacesExisting = this.entries.some((previous) => this.sameScript(previous, entry));
    if (this.entries.length + this.writes.size >= this.maxEntries && !replacesExisting) {
      throw this.busy('rojo_write_in_progress', 'The Rojo write ledger is full; pending scripts must be resolved before another script can be written.');
    }
    const token = Symbol('rojo-write');
    this.writes.set(token, { entry: { ...entry }, fileKey: key });
    return token;
  }

  /** A confirmed failed write releases only its reservation, preserving earlier commits. */
  finishWrite(token: RojoWriteToken, committed: boolean): void {
    if (committed) this.uncertainWrite(token);
    else this.abortWrite(token);
  }

  /** A write whose commit outcome is unknown must remain subject to the barrier. */
  uncertainWrite(token: RojoWriteToken): void {
    const write = this.writes.get(token);
    if (!write) return;
    const previous = this.entries.findIndex((entry) => this.sameScript(entry, write.entry));
    if (previous < 0) this.entries.push(write.entry);
    else this.entries[previous] = write.entry;
    this.writes.delete(token);
  }

  abortWrite(token: RojoWriteToken): void {
    this.writes.delete(token);
  }

  beforeRequest(endpoint: string, instanceId: string): RojoPlaytestAdmission | Promise<RojoPlaytestAdmission> | undefined {
    if (!START_ENDPOINTS.has(endpoint)) return undefined;
    const candidates = historicalIdentities(this.identities, instanceId, this.equivalentIds(instanceId));
    const current = new Set(this.liveInstanceIds?.().filter(id => candidates.includes(id)) ?? []);
    if (current.size > 1) {
      const entry = this.entries.find(value => !value.studioOwner && candidates.includes(value.instanceId));
      if (entry) return this.refuse('rojo_sync_unknown', entry, 'The recorded identity now refers to multiple open places. Close the other place, or restart the bridge and verify saved sources before relinking. No start was queued.');
    }
    const legacy = this.entries.find(entry => !entry.studioOwner);
    if (this.identities.overflow && legacy) return this.refuse('rojo_sync_unknown', legacy, 'The recorded Studio identity history is full. Restart the bridge and verify sources before starting.');
    for (const write of this.writes.values()) {
      if (this.matchesInstance(write.entry, instanceId)) {
        return this.refuse('rojo_write_in_progress', write.entry, 'A Rojo write is still in progress; start the playtest after the write and synchronization finish.');
      }
    }
    const entries = this.entries.filter((entry) => this.matchesInstance(entry, instanceId));
    if (entries.length === 0) return undefined;
    // Another instance may currently be writing the same source file.
    const fileKeys = new Set(entries.map((entry) => fileKey(entry.file)));
    for (const write of this.writes.values()) {
      if (fileKeys.has(write.fileKey)) {
        return this.refuse('rojo_write_in_progress', write.entry, 'A Rojo write is still in progress for a source file used by this playtest.');
      }
    }
    if (this.starts.size >= this.maxEntries) {
      return this.refuse('rojo_sync_unknown', entries[0], 'Too many playtest starts are still in progress; retry after they finish.');
    }
    const ticket: StartTicket = { instanceId, fileKeys, studioOwner: entries[0].studioOwner ? { ...entries[0].studioOwner } : undefined };
    this.starts.add(ticket); // Synchronous: writers cannot enter during the first await.
    return this.validate(entries, ticket);
  }

  private sameInstance(left: string, right: string): boolean {
    const leftIds = new Set(historicalIdentities(this.identities, left, this.equivalentIds(left)));
    return historicalIdentities(this.identities, right, this.equivalentIds(right)).some((id) => leftIds.has(id));
  }

  rememberInstanceIds(ids: readonly string[]): void { rememberIdentities(this.identities, ids); }
  rememberStudioOwner(owner: StudioOwner): void {
    for (const entry of [...this.entries, ...[...this.writes.values()].map(write => write.entry)]) {
      if (entry.studioOwner?.physicalSessionId === owner.physicalSessionId) {
        entry.studioOwner.instanceId = owner.instanceId; entry.instanceId = owner.instanceId;
      }
    }
    for (const start of this.starts) if (start.studioOwner?.physicalSessionId === owner.physicalSessionId) start.studioOwner.instanceId = owner.instanceId;
  }
  equivalentInstanceIds(id: string): string[] { return historicalIdentities(this.identities, id, this.equivalentIds(id)); }

  private matchesInstance(entry: TrackedRojoWrite, instanceId: string): boolean {
    if (!entry.studioOwner) return this.sameInstance(entry.instanceId, instanceId);
    // A disconnected owner still blocks starts for its own canonical place,
    // never a different live place that reused an expired historical alias.
    return entry.studioOwner.instanceId === instanceId || entry.studioOwner.instanceId === this.resolveInstanceId?.(instanceId);
  }

  private sameScript(left: TrackedRojoWrite, right: TrackedRojoWrite): boolean {
    if (left.studioOwner || right.studioOwner) {
      if (!left.studioOwner || !right.studioOwner || left.studioOwner.physicalSessionId !== right.studioOwner.physicalSessionId) return false;
    } else if (!this.sameInstance(left.instanceId, right.instanceId)) return false;
    if (left.instanceRef && right.instanceRef) return left.instanceRef === right.instanceRef;
    return left.instancePath === right.instancePath;
  }

  private busy(errorCode: 'rojo_write_in_progress' | 'rojo_start_in_progress', message: string): Error & { errorCode: string } {
    return Object.assign(new Error(message), { errorCode });
  }

  private refuse(errorCode: RojoPlaytestRefusalCode, entry: TrackedRojoWrite, error: string, evidence: Record<string, unknown> = {}): RojoPlaytestAdmission {
    return {
      refusal: { success: false, error, errorCode, instanceId: entry.instanceId, instancePath: entry.instancePath, file: entry.file, ...evidence },
    };
  }

  private async validate(entries: TrackedRojoWrite[], ticket: StartTicket): Promise<RojoPlaytestAdmission> {
    let admitted = false;
    const verified = new Map<TrackedRojoWrite, string>();
    try {
      for (const entry of entries) {
        const refusal = await this.validateEntry(entry, verified);
        if (refusal) return refusal;
      }
      admitted = true;
      const recheck = () => {
        if (ticket.studioOwner) {
          const current = this.currentStudioOwner?.(ticket.studioOwner);
          const target = this.resolveInstanceId?.(ticket.instanceId) ?? ticket.instanceId;
          if (!current || current.instanceId !== ticket.studioOwner.instanceId || target !== ticket.studioOwner.instanceId) {
            return this.refuse('rojo_sync_unknown', entries[0], 'The admitted Studio session or start target changed during validation. Reconnect the intended session and retry.').refusal;
          }
        }
        for (const [entry, studioRevision] of verified) {
          if (entry.studioOwner) {
            const current = this.currentStudioOwner?.(entry.studioOwner);
            const target = this.resolveInstanceId?.(ticket.instanceId) ?? ticket.instanceId;
            if (!current || current.instanceId !== entry.studioOwner.instanceId || target !== entry.studioOwner.instanceId) {
              return this.refuse('rojo_sync_unknown', entry, 'The verified Studio source owner or start target changed during validation. Reconnect the intended session and retry.').refusal;
            }
          }
          try {
            const fileRevision = sourceRevision(toStudioText(fs.readFileSync(entry.file)));
            if (fileRevision !== studioRevision) return this.refuse('rojo_sync_pending', entry,
              'The source file changed during playtest validation. Wait for synchronization and retry.', { fileRevision, studioRevision }).refusal;
          } catch {
            return this.refuse('rojo_sync_unknown', entry, 'The source file became unreadable during playtest validation. Retry after verifying it.').refusal;
          }
        }
        return undefined;
      };
      const refusal = recheck();
      if (refusal) { admitted = false; return { refusal }; }
      return { recheck, done: () => { this.starts.delete(ticket); } };
    } catch (error) {
      return this.refuse('rojo_sync_unknown', entries[0], `Could not verify Rojo synchronization: ${messageOf(error)}`);
    } finally {
      if (!admitted) this.starts.delete(ticket);
    }
  }

  private async validateEntry(entry: TrackedRojoWrite, verified: Map<TrackedRojoWrite, string>): Promise<RojoPlaytestAdmission | undefined> {
    const expectedOwner = entry.studioOwner ? { ...entry.studioOwner } : undefined;
    const [file, studio] = await Promise.all([
      readFile(entry.file),
      Promise.resolve().then(() => entry.inspect()).catch((error: unknown): RojoScriptObservation => ({ error: messageOf(error) })),
    ]);
    // Resolve on every check, using the fresh path/ref (including a same-ref rename).
    const ownership = await Promise.resolve().then(() => entry.resolve(studio))
      .catch((error: unknown): RojoScriptResolution => ({ persistence: 'unknown', reason: messageOf(error) }));
    if (expectedOwner && (entry.studioOwner?.instanceId !== expectedOwner.instanceId
      || this.currentStudioOwner?.(expectedOwner)?.instanceId !== expectedOwner.instanceId)) {
      return this.refuse('rojo_sync_unknown', entry, 'The inspected Studio source owner changed during ownership validation. Retry on its confirmed session; no pending record was retired.');
    }
    const evidence = { fileRevision: file.revision, studioRevision: studio.revision, persistence: ownership.persistence, reason: ownership.reason };
    if (file.error || studio.error || ownership.persistence === 'unknown') {
      return this.refuse('rojo_sync_unknown', entry, 'Rojo synchronization could not be verified; retry after disk, Studio, and project ownership are available.', evidence);
    }
    if (file.missing && studio.missing && !studio.revision) {
      const unmapped = ownership.persistence === 'studio_only' && !ownership.file;
      const remapped = (ownership.persistence === 'file' || ownership.persistence === 'generated')
        && ownership.file && fileKey(ownership.file) !== fileKey(entry.file);
      if (unmapped || remapped) {
        const index = this.entries.indexOf(entry);
        if (index >= 0) this.entries.splice(index, 1);
        return undefined;
      }
    }
    if (file.missing || studio.missing || !studio.revision) {
      return this.refuse('rojo_sync_unknown', entry, 'The tracked source file or Studio script is missing or unreadable; synchronization cannot be verified.', evidence);
    }
    if ((entry.instanceRef && studio.instanceRef !== entry.instanceRef)
      || studio.uniquePath !== true
      || (entry.className && studio.className !== entry.className)
      || (!entry.instanceRef && studio.instancePath && studio.instancePath !== entry.instancePath)) {
      return this.refuse('rojo_sync_unknown', entry, 'Studio did not confirm the identity of the tracked script.', evidence);
    }
    if (ownership.persistence !== 'file' || !ownership.file || fileKey(ownership.file) !== fileKey(entry.file)) {
      return this.refuse('rojo_sync_unknown', entry, 'The current Rojo mapping does not confirm the tracked source file.', evidence);
    }
    if (file.revision !== studio.revision) {
      return this.refuse('rojo_sync_pending', entry, 'Rojo has not synchronized the current source file into Studio; wait for synchronization and retry the playtest start.', evidence);
    }
    verified.set(entry, studio.revision);
    return undefined;
  }
}
