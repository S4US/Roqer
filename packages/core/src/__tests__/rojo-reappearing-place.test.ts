import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer, type RobloxStudioHttpApp } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { RojoIntegration } from '../rojo/index.js';
import { sourceRevision } from '../rojo/source-revision.js';
import * as syncWait from '../rojo/sync-wait.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';

// Actual Bridge/Tools/ownership and temporary disk writes. Studio delivery and
// Rojo CLI output are fixtures; this suite never starts Studio or a Rojo server.
const SCRIPT = 'game.ServerScriptService.Main';
const OLD = 'local value = 1\n', NEW = 'local value = 2\n';
const tree = { name: 'Fixture', className: 'DataModel', children: [
  { name: 'ServerScriptService', className: 'ServerScriptService', children: [
    { name: 'Main', className: 'Script', filePaths: ['src/Main.server.luau'] },
  ] },
] };
const bodyOf = (result: { content: Array<{ text?: string }> }) => JSON.parse(result.content[0].text!);

describe('reappearing published identities (actual host paths, simulated Studio)', () => {
  let directory: string, bridge: BridgeService, tools: RobloxStudioTools, app: RobloxStudioHttpApp;
  let detach: () => void, offset: number;
  const states = new Map<string, { source: string; ref: string; missing?: boolean }>();
  let holdPlan: ((requestId: string, plan: object) => void) | undefined;
  let run: jest.Mock<Promise<string>, [string[], string]>;
  const register = (physical: string, place: number) => bridge.registerInstance({ pluginSessionId: physical, physicalSessionId: physical,
    instanceId: `place:${place}`, placeId: place, role: 'edit', pluginVersion: '3.0.3', serverVersion: '3.0.3', pluginVariant: 'main' });
  const project = (name: string) => {
    const root = path.join(directory, name); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const projectFile = path.join(root, 'default.project.json'), file = path.join(root, 'src/Main.server.luau');
    fs.writeFileSync(projectFile, JSON.stringify({ name, tree: { $className: 'DataModel' } })); fs.writeFileSync(file, OLD);
    return { projectFile: fs.realpathSync.native(projectFile), file };
  };
  const link = async (instance: number, projectFile: string) => bodyOf(await tools.manageInstance({ action: 'link_project', instance_id: `place:${instance}`, project: projectFile }));
  const write = async (instance: number, source = NEW) => bodyOf(await tools.setScriptSource(SCRIPT, source, `place:${instance}`, sourceRevision(OLD), instance === 42 && bridge.getInstances().some(peer => peer.physicalSessionId === 'owner-B') ? 'ref:B' : 'ref:A'));
  const disconnectPastTTL = () => { bridge.unregisterInstance('owner-A'); offset += 6 * 60 * 1000; bridge.cleanupStaleInstances(); };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer identity ownership '));
    offset = 0; const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    jest.spyOn(syncWait, 'waitForStudio').mockResolvedValue('pending');
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
    states.clear(); states.set('owner-A', { source: OLD, ref: 'ref:A' }); states.set('owner-B', { source: OLD, ref: 'ref:B' }); holdPlan = undefined;
    bridge = new BridgeService(); tools = new RobloxStudioTools(bridge);
    run = jest.fn<Promise<string>, [string[], string]>(async args => args[0] === '--version' ? 'Rojo 7.6.1' : JSON.stringify(tree));
    tools.rojo = new RojoIntegration({ run, ignored: async () => new Set(), probe: async () => ({ reachable: false }) });
    app = createHttpServer(tools, bridge, undefined, undefined, { authToken: 'fixture-only-owner-token' });
    detach = bridge.onRequestAvailable(physical => {
      for (;;) {
        const request = bridge.claimNextRequestForPhysical(physical, 'fixture-delivery'); if (!request) return;
        const data = request.data as Record<string, unknown>;
        const state = states.get(physical)!;
        const identity = { instancePath: SCRIPT, instanceRef: state.ref, className: 'Script', uniquePath: true };
        if (request.endpoint === '/api/get-script-source') bridge.resolveRequest(request.requestId, state.missing
          ? { error: data.instanceRef ? `Instance reference is invalid or no longer live: ${data.instanceRef}` : `Instance not found: ${SCRIPT}` }
          : { ...identity, revision: sourceRevision(state.source), source: state.source });
        else if (request.endpoint === '/api/set-script-source') {
          const source = String(data.source);
          const plan = { ...identity, planned: true, previousRevision: sourceRevision(state.source), revision: sourceRevision(source), source };
          if (data.planOnly && holdPlan) holdPlan(request.requestId, plan);
          else if (data.planOnly) bridge.resolveRequest(request.requestId, plan);
          else { state.source = source; bridge.resolveRequest(request.requestId, { ...identity, success: true }); }
        } else bridge.resolveRequest(request.requestId, { fixtureStart: true });
      }
    });
  });
  afterEach(async () => { await tools.settled(); detach(); bridge.clearAllPendingRequests(); await app.cleanup(); jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

  test.each([false, true])('a new physical on old42 cannot borrow or unlink project43 (onlyB=%s)', async onlyB => {
    register('owner-A', 42); register('owner-A', 43);
    const fixture = project('A'); expect(await link(43, fixture.projectFile)).toMatchObject({ linked: true });
    disconnectPastTTL(); register('owner-B', 42); if (!onlyB) register('owner-A', 43);
    expect(bridge.getEquivalentInstanceIds('place:42')).toEqual(['place:42']);
    const result = await write(42);
    expect(result).toMatchObject({ success: true }); expect(result).not.toHaveProperty('saved');
    expect(states.get('owner-B')!.source).toBe(NEW); expect(fs.readFileSync(fixture.file, 'utf8')).toBe(OLD);
    expect(bodyOf(await tools.manageInstance({ action: 'unlink_project', instance_id: 'place:42' }))).toMatchObject({ unlinked: false });
    expect(tools.rojo.getLinks()).toMatchObject([{ instanceId: 'place:43', projectFile: fixture.projectFile, studioOwner: { physicalSessionId: 'owner-A' } }]);
  });

  test('an existing direct42 binding and pending write follow A43, never the reappearing B42', async () => {
    register('owner-A', 42); const fixture = project('Pending'); await link(42, fixture.projectFile);
    expect(await write(42)).toMatchObject({ saved: { sync: 'pending' } });
    register('owner-A', 43); disconnectPastTTL(); register('owner-B', 42); register('owner-A', 43);
    expect(tools.rojo.linkFor('place:42')).toBeUndefined();
    expect(tools.rojo.getLinks()).toMatchObject([{ instanceId: 'place:43', studioOwner: { instanceId: 'place:43', physicalSessionId: 'owner-A' } }]);
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:43', 'edit')).toMatchObject({ errorCode: 'rojo_sync_pending' });
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:42', 'edit')).toEqual({ fixtureStart: true });
    bridge.unregisterInstance('owner-A');
    expect(bodyOf(await tools.manageInstance({ action: 'unlink_project', instance_id: 'place:42' }))).toMatchObject({ unlinked: false });
    await write(42, 'local value = 3\n'); expect(fs.readFileSync(fixture.file, 'utf8')).toBe(NEW);
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:42', 'edit')).toEqual({ fixtureStart: true });
    register('owner-A', 43);
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:43', 'edit')).toMatchObject({ errorCode: 'rojo_sync_pending' });
    expect(bodyOf(await tools.manageInstance({ action: 'unlink_project', instance_id: 'place:43' }))).toMatchObject({ unlinked: true });
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:43', 'edit')).toMatchObject({ errorCode: 'rojo_sync_pending' });
  });

  test('the same physical anon publication remains bound and guarded after alias TTL', async () => {
    bridge.registerInstance({ pluginSessionId: 'owner-A', physicalSessionId: 'owner-A', instanceId: 'anon:own', placeId: 0, role: 'edit' });
    const fixture = project('Anon'); await tools.manageInstance({ action: 'link_project', instance_id: 'anon:own', project: fixture.projectFile });
    expect(bodyOf(await tools.setScriptSource(SCRIPT, NEW, 'anon:own', sourceRevision(OLD), 'ref:A'))).toMatchObject({ saved: { sync: 'pending' } });
    register('owner-A', 43); disconnectPastTTL(); register('owner-A', 43);
    expect(bridge.getEquivalentInstanceIds('place:43')).not.toContain('anon:own');
    expect(bodyOf(await tools.getScriptSource(SCRIPT, undefined, undefined, 'place:43'))).toMatchObject({ persistence: 'file', fileRevision: sourceRevision(NEW), fileMatchesStudio: false });
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:43', 'edit')).toMatchObject({ errorCode: 'rojo_sync_pending' });
  });

  test('a rejected registration cannot migrate a binding or its pending anchor', async () => {
    register('owner-A', 42); register('owner-B', 43); const fixture = project('Reject'); await link(42, fixture.projectFile); await write(42);
    const observed = jest.fn(); bridge.onInstanceAliases(observed); observed.mockClear();
    expect(register('owner-A', 43)).toMatchObject({ ok: false }); expect(observed).not.toHaveBeenCalled();
    expect(tools.rojo.getLinks()).toMatchObject([{ instanceId: 'place:42', studioOwner: { instanceId: 'place:42' } }]);
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:42', 'edit')).toMatchObject({ errorCode: 'rojo_sync_pending' });
  });

  test('identity change during an explicit rebind preserves the original project', async () => {
    register('owner-A', 43); const first = project('First'), second = project('Second'); await link(43, first.projectFile);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }); const delayed = new Promise<void>(resolve => { release = resolve; });
    run.mockImplementationOnce(async () => { entered(); await delayed; return 'Rojo 7.6.1'; });
    const rebinding = link(43, second.projectFile); await waiting; register('owner-A', 44); release();
    expect(await rebinding).toMatchObject({ errorCode: 'rojo_link_invalid' });
    expect(tools.rojo.getLinks()).toMatchObject([{ instanceId: 'place:44', projectFile: first.projectFile }]);
    expect(fs.readFileSync(first.file, 'utf8')).toBe(OLD); expect(fs.readFileSync(second.file, 'utf8')).toBe(OLD);
  });

  test('identity change after planning refuses the file commit', async () => {
    register('owner-A', 42); const fixture = project('DuringWrite'); await link(42, fixture.projectFile);
    let entered!: () => void, finish!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    holdPlan = (id, plan) => { finish = () => bridge.resolveRequest(id, plan); entered(); };
    const writing = write(42); await waiting; register('owner-A', 43); finish();
    expect(await writing).toHaveProperty('error'); expect(fs.readFileSync(fixture.file, 'utf8')).toBe(OLD);
  });

  test('a replacement physical on the same canonical place cannot silently write Studio-only', async () => {
    register('owner-A', 43); const fixture = project('NewSession'); await link(43, fixture.projectFile);
    bridge.unregisterInstance('owner-A'); register('owner-B', 43);
    await expect(tools.setScriptSource(SCRIPT, NEW, 'place:43', sourceRevision(OLD), 'ref:B')).rejects.toThrow('another Studio session');
    expect(states.get('owner-B')!.source).toBe(OLD); expect(fs.readFileSync(fixture.file, 'utf8')).toBe(OLD);
    expect(tools.rojo.getLinks()).toMatchObject([{ studioOwner: { physicalSessionId: 'owner-A' } }]);
  });

  test('a currently live old identity outranks its former alias without waiting for TTL', async () => {
    register('owner-A', 42); const fixture = project('Immediate'); await link(42, fixture.projectFile);
    register('owner-A', 43); register('owner-B', 42);
    expect(bridge.resolveTarget({ instance_id: 'place:42', target: 'edit' })).toMatchObject({ ok: true, targetInstanceId: 'place:42' });
    await write(42); expect(fs.readFileSync(fixture.file, 'utf8')).toBe(OLD); expect(states.get('owner-B')!.source).toBe(NEW);
    expect(bodyOf(await tools.manageInstance({ action: 'unlink_project', instance_id: 'place:42' }))).toMatchObject({ unlinked: false });
    bridge.unregisterInstance('owner-B');
    expect(bridge.resolveTarget({ instance_id: 'place:42', target: 'edit' })).toMatchObject({ ok: false });
    expect(tools.rojo.getLinks()).toMatchObject([{ instanceId: 'place:43', studioOwner: { physicalSessionId: 'owner-A' } }]);
  });

  test('a start cannot dispatch to a reused canonical identity after checking another owner', async () => {
    register('owner-A', 42); const fixture = project('StartWindow'); await link(42, fixture.projectFile); await write(42);
    states.get('owner-A')!.source = NEW;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }); const delayed = new Promise<void>(resolve => { release = resolve; });
    run.mockImplementationOnce(async () => { entered(); await delayed; return JSON.stringify(tree); });
    const starting = bridge.sendRequest('/api/start-playtest', {}, 'place:42', 'edit', 2000);
    await waiting; register('owner-A', 43); bridge.unregisterInstance('owner-A'); register('owner-B', 42); release();
    expect(await starting).toMatchObject({ errorCode: 'rojo_sync_unknown' });
    expect(bridge.getPendingRequestCount()).toBe(0);
    register('owner-A', 43); states.get('owner-A')!.source = OLD;
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:43', 'edit')).toMatchObject({ errorCode: 'rojo_sync_pending' });
  });

  test('both-gone retirement cannot clear a pending owner that disappears during mapping', async () => {
    register('owner-A', 42); const fixture = project('RetireWindow'); await link(42, fixture.projectFile); await write(42);
    fs.unlinkSync(fixture.file); states.get('owner-A')!.missing = true;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }); const delayed = new Promise<void>(resolve => { release = resolve; });
    const absentMap = JSON.stringify({ name: 'Fixture', className: 'DataModel' });
    run.mockImplementationOnce(async () => { entered(); await delayed; return absentMap; });
    const starting = bridge.sendRequest('/api/start-playtest', {}, 'place:42', 'edit', 2000);
    await waiting; register('owner-A', 43); bridge.unregisterInstance('owner-A'); register('owner-B', 42); release();
    expect(await starting).toMatchObject({ errorCode: 'rojo_sync_unknown' }); expect(bridge.getPendingRequestCount()).toBe(0);
    register('owner-A', 43);
    // An old mapping alone is still not retirement proof on the reconnected owner.
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:43', 'edit')).toMatchObject({ errorCode: 'rojo_sync_unknown' });
    run.mockResolvedValue(absentMap);
    expect(await bridge.sendRequest('/api/start-playtest', {}, 'place:43', 'edit')).toEqual({ fixtureStart: true });
  });
});
