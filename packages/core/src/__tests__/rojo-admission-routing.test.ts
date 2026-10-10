import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { RojoPlaytestGuard } from '../rojo/playtest-guard.js';
import { sourceRevision } from '../rojo/source-revision.js';

describe('admission and dispatch (real disk/Bridge, simulated Studio observation)', () => {
  let directory: string;
  let bridge: BridgeService;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer admission ')); bridge = new BridgeService(); });
  afterEach(() => { bridge.clearAllPendingRequests(); fs.rmSync(directory, { recursive: true, force: true }); });
  const register = (bridge: BridgeService, id: string, placeId: number) => bridge.registerInstance({ pluginSessionId: 'peer', physicalSessionId: 'physical', instanceId: id, placeId, role: 'edit' });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));

  test('an alias changed during admission is dispatched to the current physical peer', async () => {
    register(bridge, 'anon:A', 0);
    const guard = new RojoPlaytestGuard({ equivalentIds: id => bridge.getEquivalentInstanceIds(id) });
    bridge.onInstanceAliases(ids => guard.rememberInstanceIds(ids));
    bridge.setRequestAdmission((endpoint, id) => guard.beforeRequest(endpoint, id));
    const file = path.join(directory, 'Main.server.luau'); fs.writeFileSync(file, 'same\n');
    let entered!: () => void, release!: () => void;
    const inspecting = new Promise<void>(resolve => { entered = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    guard.finishWrite(guard.beginWrite({ instanceId: 'anon:A', instancePath: 'game.Main', instanceRef: 'ref', file,
      inspect: async () => { entered(); await delayed; return { instanceRef: 'ref', revision: sourceRevision('same\n'), uniquePath: true }; },
      resolve: async () => ({ persistence: 'file', file }),
    }), true);
    const delivered = new Promise<void>(resolve => bridge.onRequestAvailable(physical => {
      const queued = bridge.claimNextRequestForPhysical(physical, 'consumer');
      if (queued) { bridge.resolveRequest(queued.requestId, { success: true }); resolve(); }
    }));
    const start = bridge.sendRequest('/api/start-playtest', {}, 'anon:A', 'edit', 2000);
    await inspecting; register(bridge, 'place:42', 42); release();
    await expect(start).resolves.toEqual({ success: true });
    await delivered;
  });

  test('a caller timeout during admission cannot become a delayed Studio start', async () => {
    register(bridge, 'anon:A', 0);
    let release!: (value: { done: () => void }) => void;
    const done = jest.fn();
    const admission = new Promise<{ done: () => void }>(resolve => { release = resolve; });
    bridge.setRequestAdmission(() => admission);
    await expect(bridge.sendRequest('/api/start-playtest', {}, 'anon:A', 'edit', 10)).rejects.toThrow('Request timeout');
    release({ done }); await tick();
    expect(bridge.claimNextRequestForPhysical('physical', 'consumer')).toBeNull();
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('an external disk save during fresh mapping is caught after the await', async () => {
    const guard = new RojoPlaytestGuard({ equivalentIds: id => [id] });
    const file = path.join(directory, 'Main.server.luau'); fs.writeFileSync(file, 'old\n');
    guard.finishWrite(guard.beginWrite({ instanceId: 'place:42', instancePath: 'game.Main', instanceRef: 'ref', file,
      inspect: async () => ({ instanceRef: 'ref', revision: sourceRevision('old\n'), uniquePath: true }),
      resolve: async () => { fs.writeFileSync(file, 'external\n'); return { persistence: 'file', file }; },
    }), true);
    expect((await guard.beforeRequest('/api/start-playtest', 'place:42'))?.refusal?.errorCode).toBe('rojo_sync_pending');
    expect(fs.readFileSync(file, 'utf8')).toBe('external\n');
  });

  test('checking a later script cannot leave an earlier script with a stale disk match', async () => {
    const guard = new RojoPlaytestGuard({ equivalentIds: id => [id] });
    const first = path.join(directory, 'First.server.luau'), second = path.join(directory, 'Second.server.luau');
    for (const file of [first, second]) fs.writeFileSync(file, 'old\n');
    for (const [index, file] of [first, second].entries()) guard.finishWrite(guard.beginWrite({ instanceId: 'place:42', instancePath: `game.Script${index}`, instanceRef: `ref:${index}`, file,
      inspect: async () => ({ instanceRef: `ref:${index}`, revision: sourceRevision('old\n'), uniquePath: true }),
      resolve: async () => { if (index === 1) fs.writeFileSync(first, 'external\n'); return { persistence: 'file', file }; },
    }), true);
    expect((await guard.beforeRequest('/api/start-playtest', 'place:42'))?.refusal?.errorCode).toBe('rojo_sync_pending');
  });
});
