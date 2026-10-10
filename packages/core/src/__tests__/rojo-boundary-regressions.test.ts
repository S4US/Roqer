import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { BridgeService } from '../bridge-service.js';
import { RojoPlaytestGuard, type RojoScriptObservation } from '../rojo/playtest-guard.js';
import { RojoPrimaryService, type RojoDelegateRequest } from '../rojo/primary-service.js';
import { sourceRevision } from '../rojo/source-revision.js';

describe('primary authority boundary regressions (real disk, simulated Studio observations)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer boundary ')); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  test('confirmed anon-to-place identity remains guarded after transport alias TTL', async () => {
    const bridge = new BridgeService();
    const guard = new RojoPlaytestGuard({ equivalentIds: (id) => bridge.getEquivalentInstanceIds(id) });
    const learn = (ids: string[]) => (guard as unknown as { rememberInstanceIds?: (ids: string[]) => void }).rememberInstanceIds?.(ids);
    bridge.onInstanceRegistered((peer) => learn(bridge.getEquivalentInstanceIds(peer.instanceId)));
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const register = (instanceId: string, placeId: number) => bridge.registerInstance({ pluginSessionId: 'peer', physicalSessionId: 'peer', instanceId, placeId, role: 'edit', placeName: 'Fixture', dataModelName: 'Fixture', isRunning: false, pluginVersion: '3.0.3', serverVersion: '3.0.3', pluginVariant: 'main' });
    register('anon:A', 0);
    const file = path.join(root, 'Main.server.luau'); fs.writeFileSync(file, 'new\n');
    guard.finishWrite(guard.beginWrite({ instanceId: 'anon:A', instancePath: 'game.ServerScriptService.Main', instanceRef: 'ref:main', className: 'Script', file,
      inspect: async () => ({ instanceRef: 'ref:main', className: 'Script', uniquePath: true, revision: sourceRevision('old\n'), instancePath: 'game.ServerScriptService.Main' }),
      resolve: async () => ({ persistence: 'file', file }),
    }), true);
    register('place:42', 42);
    bridge.unregisterInstance('peer');
    now += 6 * 60 * 1000;
    bridge.cleanupStaleInstances();
    register('place:42', 42);
    expect(bridge.getEquivalentInstanceIds('place:42')).not.toContain('anon:A');
    const result = await guard.beforeRequest('/api/start-playtest', 'place:42');
    expect(result?.refusal?.errorCode).toBe('rojo_sync_pending');
  });

  test('duplicate Studio paths cannot validate a tracked file despite matching revisions', async () => {
    const guard = new RojoPlaytestGuard({ equivalentIds: (id) => [id] });
    const file = path.join(root, 'Main.server.luau'); fs.writeFileSync(file, 'same\n');
    guard.finishWrite(guard.beginWrite({ instanceId: 'place:42', instancePath: 'game.ServerScriptService.Main', instanceRef: 'ref:main', className: 'Script', file,
      inspect: async () => ({ instanceRef: 'ref:main', className: 'Script', revision: sourceRevision('same\n'), uniquePath: false } as RojoScriptObservation),
      resolve: async () => ({ persistence: 'file', file }),
    }), true);
    const result = await guard.beforeRequest('/api/start-playtest', 'place:42');
    expect(result?.refusal?.errorCode).toBe('rojo_sync_unknown');
  });

  test('a plugin without fresh uniqueness metadata cannot admit a start', async () => {
    const guard = new RojoPlaytestGuard({ equivalentIds: id => [id] });
    const file = path.join(root, 'Main.server.luau'); fs.writeFileSync(file, 'same\n');
    guard.finishWrite(guard.beginWrite({ instanceId: 'place:42', instancePath: 'game.ServerScriptService.Main', instanceRef: 'ref:main', className: 'Script', file,
      inspect: async () => ({ instanceRef: 'ref:main', className: 'Script', revision: sourceRevision('same\n') }),
      resolve: async () => ({ persistence: 'file', file }),
    }), true);
    expect((await guard.beforeRequest('/api/start-playtest', 'place:42'))?.refusal?.errorCode).toBe('rojo_sync_unknown');
  });

  test.each(['set_script_source', 'manage_instance'])('inspector without an allowlist refuses hidden %s before invoke', async (toolName) => {
    const invoke = jest.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    const owner = new RojoPrimaryService(new BridgeService(), invoke, 'inspector');
    const request: RojoDelegateRequest = { protocol: 1, clientId: randomUUID(), operationId: randomUUID(), epoch: owner.epoch, kind: 'call', toolName,
      args: toolName === 'manage_instance' ? { action: 'link_project', project: path.join(root, 'default.project.json') } : { instancePath: 'game.Main', source: 'bad', expectedRevision: 'rev' },
      cwd: root, environment: {}, state: { version: 0, defaultAttempted: false, bindings: [] },
    };
    const reply = await owner.handle(request);
    expect(reply.errorCode).toBe('read_only_inspector');
    expect(invoke).not.toHaveBeenCalled();
    owner.close();
  });
});
