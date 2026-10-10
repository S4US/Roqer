import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  RojoPlaytestGuard,
  type RojoPlaytestAdmission,
  type RojoScriptObservation,
  type RojoScriptResolution,
  type TrackedRojoWrite,
} from '../rojo/playtest-guard.js';
import { sourceRevision } from '../rojo/source-revision.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer playtest guard ')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// Files are real temporary files. Only Studio observation and Rojo ownership
// callbacks are simulated; this suite does not prove live Studio propagation.
function script(name = 'Main', instanceId = 'primary', disk = 'new\n', studioSource = 'old\n') {
  const file = path.join(dir, `${instanceId}-${name}.server.luau`);
  fs.writeFileSync(file, disk);
  const state: { studio: RojoScriptObservation; ownership: RojoScriptResolution } = {
    studio: {
      revision: sourceRevision(studioSource),
      instancePath: `game.ServerScriptService.${name}`,
      instanceRef: `ref:${instanceId}:${name}`,
      className: 'Script',
      uniquePath: true,
    },
    ownership: { persistence: 'file', file },
  };
  const inspect = jest.fn(async () => ({ ...state.studio }));
  const resolve = jest.fn<(observation: RojoScriptObservation) => Promise<RojoScriptResolution>>(async () => ({ ...state.ownership }));
  const entry: TrackedRojoWrite = {
    instanceId,
    instancePath: state.studio.instancePath!,
    instanceRef: state.studio.instanceRef,
    className: state.studio.className,
    file,
    inspect,
    resolve,
  };
  return { entry, file, state, inspect, resolve };
}

function guard(maxEntries?: number) {
  return new RojoPlaytestGuard({ equivalentIds: (id) => id === 'primary' || id === 'alias' ? ['primary', 'alias'] : [id], maxEntries });
}

function commit(subject: RojoPlaytestGuard, entry: TrackedRojoWrite) {
  subject.finishWrite(subject.beginWrite(entry), true);
}

async function start(subject: RojoPlaytestGuard, instanceId = 'primary', endpoint = '/api/start-playtest') {
  return subject.beforeRequest(endpoint, instanceId);
}

function expectRefusal(admission: RojoPlaytestAdmission | undefined, code: string, file?: string) {
  expect(admission?.refusal).toMatchObject({ success: false, error: expect.any(String), errorCode: code, ...(file ? { file } : {}) });
  expect(admission?.done).toBeUndefined();
}

function expectBusy(action: () => unknown, code: string) {
  try {
    action();
    throw new Error('Expected the operation to be refused');
  } catch (error) {
    expect(error).toMatchObject({ errorCode: code });
  }
}

describe('RojoPlaytestGuard primary ledger', () => {
  test.each(['/api/start-playtest', '/api/multiplayer-test-start'])('raw %s refuses pending disk and then admits synchronized Studio', async (endpoint) => {
    const subject = guard();
    const tracked = script();
    commit(subject, tracked.entry);
    expectRefusal(await start(subject, 'primary', endpoint), 'rojo_sync_pending', tracked.file);
    expect(tracked.state.studio.revision).toBe(sourceRevision('old\n'));
    tracked.state.studio.revision = sourceRevision('new\n');
    const admitted = await start(subject, 'primary', endpoint);
    expect(admitted?.refusal).toBeUndefined();
    expect(admitted?.done).toEqual(expect.any(Function));
    admitted?.done?.();
  });

  test('returns synchronously without callbacks for unrelated endpoints or untracked instances', () => {
    const subject = guard();
    const tracked = script();
    expect(subject.beforeRequest('/api/start-playtest', 'primary')).toBeUndefined();
    commit(subject, tracked.entry);
    expect(subject.beforeRequest('/api/stop-playtest', 'primary')).toBeUndefined();
    expect(subject.beforeRequest('/api/get-script-source', 'primary')).toBeUndefined();
    expect(subject.beforeRequest('/api/start-playtest', 'other')).toBeUndefined();
    expect(tracked.inspect).not.toHaveBeenCalled();
    expect(tracked.resolve).not.toHaveBeenCalled();
  });

  test('compares BOM and CRLF disk content with the normalized Studio revision', async () => {
    const subject = guard();
    const tracked = script('Formatted', 'primary', '\ufeffnew\r\nline\r\n', 'new\nline\n');
    commit(subject, tracked.entry);
    const admitted = await start(subject);
    expect(admitted?.refusal).toBeUndefined();
    admitted?.done?.();
    expect(fs.readFileSync(tracked.file, 'utf8')).toBe('\ufeffnew\r\nline\r\n');
  });

  test('retains a synced entry and reads current disk, Studio and ownership on every start', async () => {
    const subject = guard();
    const tracked = script('Fresh', 'primary', 'new\n', 'new\n');
    commit(subject, tracked.entry);
    (await start(subject))?.done?.();
    fs.writeFileSync(tracked.file, 'external edit\n');
    expectRefusal(await start(subject), 'rojo_sync_pending');
    tracked.state.studio.revision = sourceRevision('external edit\n');
    tracked.state.ownership = { persistence: 'unknown', reason: 'Rojo CLI is unavailable' };
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    expect(tracked.inspect).toHaveBeenCalledTimes(3);
    expect(tracked.resolve).toHaveBeenCalledTimes(3);
    expect(tracked.resolve).toHaveBeenLastCalledWith(tracked.state.studio);
  });

  test('aliases share a ledger and independent instances do not block one another', async () => {
    const subject = guard();
    const tracked = script();
    const independent = script('Main', 'independent', 'new\n', 'new\n');
    commit(subject, tracked.entry);
    expectRefusal(await start(subject, 'alias'), 'rojo_sync_pending');
    commit(subject, independent.entry);
    const admitted = await start(subject, 'independent');
    expect(admitted?.refusal).toBeUndefined();
    admitted?.done?.();
  });

  test('checks every script for the requested primary', async () => {
    const subject = guard();
    const first = script('First', 'primary', 'new\n', 'new\n');
    const second = script('Second');
    commit(subject, first.entry);
    commit(subject, second.entry);
    expectRefusal(await start(subject), 'rojo_sync_pending', second.file);
    second.state.studio.revision = sourceRevision('new\n');
    const admitted = await start(subject);
    expect(admitted?.refusal).toBeUndefined();
    admitted?.done?.();
    expect(first.inspect).toHaveBeenCalledTimes(2);
    expect(second.inspect).toHaveBeenCalledTimes(2);
  });

  test('later successful writes replace the same script through alias and same-ref rename', async () => {
    const subject = guard();
    const older = script('Main');
    commit(subject, older.entry);
    const newer = script('Renamed', 'alias', 'later\n', 'later\n');
    newer.entry.instanceRef = older.entry.instanceRef;
    newer.state.studio.instanceRef = older.entry.instanceRef;
    commit(subject, newer.entry);
    const admitted = await start(subject);
    expect(admitted?.refusal).toBeUndefined();
    admitted?.done?.();
    expect(older.inspect).not.toHaveBeenCalled();
    expect(newer.inspect).toHaveBeenCalledTimes(1);
  });

  test('a same-ref rename is resolved from the fresh Studio path', async () => {
    const subject = guard();
    const tracked = script('Main', 'primary', 'new\n', 'new\n');
    commit(subject, tracked.entry);
    tracked.state.studio.instancePath = 'game.ServerScriptService.Renamed';
    const admitted = await start(subject);
    expect(admitted?.refusal).toBeUndefined();
    expect(tracked.resolve).toHaveBeenCalledWith(expect.objectContaining({ instancePath: 'game.ServerScriptService.Renamed', instanceRef: tracked.entry.instanceRef }));
    admitted?.done?.();
    tracked.state.studio.instanceRef = 'ref:replaced';
    expectRefusal(await start(subject), 'rojo_sync_unknown');
  });

  test('confirmed failed replacement and abort preserve the previously committed ledger', async () => {
    const subject = guard();
    const older = script();
    commit(subject, older.entry);
    const failed = { ...older.entry, inspect: jest.fn(async () => ({ ...older.state.studio, revision: sourceRevision('new\n') })) };
    subject.finishWrite(subject.beginWrite(failed), false);
    expectRefusal(await start(subject), 'rojo_sync_pending');
    subject.abortWrite(subject.beginWrite(failed));
    expectRefusal(await start(subject), 'rojo_sync_pending');
    expect(failed.inspect).not.toHaveBeenCalled();
    expect(older.inspect).toHaveBeenCalledTimes(2);
  });

  test('a confirmed uncommitted first write creates no ledger entry', () => {
    const subject = guard();
    const tracked = script();
    subject.finishWrite(subject.beginWrite(tracked.entry), false);
    expect(subject.beforeRequest('/api/start-playtest', 'primary')).toBeUndefined();
    expect(tracked.inspect).not.toHaveBeenCalled();
  });

  test('uncertain commit outcome releases inflight but retains the script for verification', async () => {
    const subject = guard();
    const tracked = script();
    const token = subject.beginWrite(tracked.entry);
    fs.writeFileSync(tracked.file, 'possibly committed\n');
    subject.uncertainWrite(token);
    expectRefusal(await start(subject), 'rojo_sync_pending');
    tracked.state.studio.revision = sourceRevision('possibly committed\n');
    (await start(subject))?.done?.();
    // Duplicate completion calls cannot add or delete another record.
    subject.finishWrite(token, true);
    subject.abortWrite(token);
    fs.writeFileSync(tracked.file, 'another edit\n');
    expectRefusal(await start(subject), 'rojo_sync_pending');
  });

  test('full ledger refuses new scripts without evicting pending records and allows replacement', async () => {
    const subject = guard(1);
    const tracked = script();
    const other = script('Other');
    commit(subject, tracked.entry);
    expectBusy(() => subject.beginWrite(other.entry), 'rojo_write_in_progress');
    expectRefusal(await start(subject), 'rojo_sync_pending', tracked.file);
    const replacement = { ...tracked.entry };
    commit(subject, replacement);
    expectRefusal(await start(subject), 'rojo_sync_pending', tracked.file);
    expect(other.inspect).not.toHaveBeenCalled();
  });
});

describe('RojoPlaytestGuard admission windows', () => {
  test('an inflight write immediately refuses starts, before and after disk commit until finishWrite', async () => {
    const subject = guard();
    const tracked = script();
    const token = subject.beginWrite(tracked.entry);
    const first = subject.beforeRequest('/api/start-playtest', 'alias');
    expect(first).not.toBeInstanceOf(Promise);
    expectRefusal(first as RojoPlaytestAdmission, 'rojo_write_in_progress');
    fs.writeFileSync(tracked.file, 'committed\n');
    expectRefusal(await start(subject), 'rojo_write_in_progress');
    expect(tracked.inspect).not.toHaveBeenCalled();
    subject.finishWrite(token, true);
    expectRefusal(await start(subject), 'rojo_sync_pending');
  });

  test('same source file reservations serialize writes across primaries', () => {
    const subject = guard();
    const tracked = script();
    const token = subject.beginWrite(tracked.entry);
    const sameFile = { ...tracked.entry, instanceId: 'independent', instanceRef: 'ref:other' };
    expectBusy(() => subject.beginWrite(sameFile), 'rojo_write_in_progress');
    const unrelated = script('Other', 'independent');
    const unrelatedToken = subject.beginWrite(unrelated.entry);
    subject.abortWrite(unrelatedToken);
    subject.abortWrite(token);
    subject.abortWrite(subject.beginWrite(sameFile));
  });

  test('a start whose ledger uses another primary\'s inflight file is refused', async () => {
    const subject = guard();
    const tracked = script('Main', 'primary', 'new\n', 'new\n');
    commit(subject, tracked.entry);
    const token = subject.beginWrite({ ...tracked.entry, instanceId: 'independent', instanceRef: 'ref:other' });
    expectRefusal(await start(subject), 'rojo_write_in_progress');
    expect(tracked.inspect).not.toHaveBeenCalled();
    subject.abortWrite(token);
  });

  test('the barrier covers validation through actual start dispatch completion via done', async () => {
    const subject = guard();
    const tracked = script('Main', 'primary', 'new\n', 'new\n');
    let finishInspection!: (observation: RojoScriptObservation) => void;
    tracked.entry.inspect = () => new Promise((resolve) => { finishInspection = resolve; });
    commit(subject, tracked.entry);
    const pendingAdmission = start(subject);
    expectBusy(() => subject.beginWrite(tracked.entry), 'rojo_start_in_progress');
    expectBusy(() => subject.beginWrite({ ...tracked.entry, instanceId: 'independent' }), 'rojo_start_in_progress');
    const independent = script('Other', 'independent');
    subject.abortWrite(subject.beginWrite(independent.entry));
    await Promise.resolve();
    finishInspection({ ...tracked.state.studio });
    const admitted = await pendingAdmission;
    expect(admitted?.refusal).toBeUndefined();
    expectBusy(() => subject.beginWrite({ ...tracked.entry, instanceId: 'alias' }), 'rojo_start_in_progress');
    admitted?.done?.();
    admitted?.done?.();
    subject.abortWrite(subject.beginWrite(tracked.entry));
  });

  test('refusals and callback exceptions release the start barrier', async () => {
    const subject = guard();
    const tracked = script();
    commit(subject, tracked.entry);
    expectRefusal(await start(subject), 'rojo_sync_pending');
    subject.abortWrite(subject.beginWrite(tracked.entry));
    tracked.inspect.mockRejectedValueOnce(new Error('Studio disconnected'));
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    subject.abortWrite(subject.beginWrite(tracked.entry));
    tracked.resolve.mockRejectedValueOnce(new Error('Rojo CLI unavailable'));
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    subject.abortWrite(subject.beginWrite(tracked.entry));
  });

  test('synchronously thrown callback errors also keep records and release admission', async () => {
    const subject = guard();
    const tracked = script();
    tracked.entry.inspect = () => { throw new Error('Synchronous inspection error'); };
    commit(subject, tracked.entry);
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    expect(tracked.resolve).toHaveBeenCalledWith(expect.objectContaining({ error: 'Synchronous inspection error' }));
    subject.abortWrite(subject.beginWrite(tracked.entry));
    tracked.entry.inspect = tracked.inspect;
    tracked.entry.resolve = () => { throw new Error('Synchronous resolution error'); };
    commit(subject, tracked.entry);
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    subject.abortWrite(subject.beginWrite(tracked.entry));
  });
});

describe('RojoPlaytestGuard conservative retirement', () => {
  test('only retires confirmed both-gone entries after a fresh absent mapping', async () => {
    const subject = guard(1);
    const tracked = script();
    commit(subject, tracked.entry);
    fs.unlinkSync(tracked.file);
    tracked.state.studio = { missing: true };
    expectRefusal(await start(subject), 'rojo_sync_unknown'); // Old mapping still exists.
    tracked.state.ownership = { persistence: 'studio_only', reason: 'No longer in the project' };
    const admitted = await start(subject);
    expect(admitted?.refusal).toBeUndefined();
    admitted?.done?.();
    expect(tracked.resolve).toHaveBeenCalledTimes(2);
    expect(subject.beforeRequest('/api/start-playtest', 'primary')).toBeUndefined();
    const next = script('Next');
    subject.abortWrite(subject.beginWrite(next.entry));
  });

  test.each(['file', 'studio'] as const)('keeps the entry when only %s is missing', async (missingSide) => {
    const subject = guard();
    const tracked = script();
    commit(subject, tracked.entry);
    if (missingSide === 'file') fs.unlinkSync(tracked.file);
    else tracked.state.studio = { missing: true };
    tracked.state.ownership = { persistence: 'studio_only' };
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    expect(tracked.inspect).toHaveBeenCalledTimes(2);
  });

  test.each(['unknown', 'unsupported', 'missing-file-field'] as const)('both-gone with %s resolution remains guarded', async (resolution) => {
    const subject = guard();
    const tracked = script();
    commit(subject, tracked.entry);
    fs.unlinkSync(tracked.file);
    tracked.state.studio = { missing: true };
    tracked.state.ownership = resolution === 'missing-file-field'
      ? { persistence: 'file' }
      : { persistence: resolution, reason: 'Could not establish a unique current mapping' };
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    expectRefusal(await start(subject), 'rojo_sync_unknown');
  });

  test('both-gone can retire when a fresh mapping points at a different file', async () => {
    const subject = guard();
    const tracked = script();
    const replacement = script('Replacement');
    commit(subject, tracked.entry);
    fs.unlinkSync(tracked.file);
    tracked.state.studio = { missing: true };
    tracked.state.ownership = { persistence: 'file', file: replacement.file };
    const admitted = await start(subject);
    expect(admitted?.refusal).toBeUndefined();
    admitted?.done?.();
    expect(subject.beforeRequest('/api/start-playtest', 'primary')).toBeUndefined();
  });

  test('non-ENOENT disk failure cannot retire a record even when Studio is missing', async () => {
    const subject = guard();
    const tracked = script();
    fs.unlinkSync(tracked.file);
    fs.mkdirSync(tracked.file); // readFile on a directory is not evidence of file deletion.
    commit(subject, tracked.entry);
    tracked.state.studio = { missing: true };
    tracked.state.ownership = { persistence: 'studio_only' };
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    expect(tracked.resolve).toHaveBeenCalledTimes(2);
  });

  test('missing reports containing errors or a revision cannot retire a record', async () => {
    const subject = guard();
    const tracked = script();
    commit(subject, tracked.entry);
    fs.unlinkSync(tracked.file);
    tracked.state.ownership = { persistence: 'studio_only' };
    tracked.state.studio = { missing: true, error: 'Studio could not inspect the ref' };
    expectRefusal(await start(subject), 'rojo_sync_unknown');
    tracked.state.studio = { missing: true, revision: sourceRevision('old\n') };
    expectRefusal(await start(subject), 'rojo_sync_unknown');
  });
});
