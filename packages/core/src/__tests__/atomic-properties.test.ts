import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: (...args: unknown[]) => unknown): [boolean, unknown] {
  try {
    return [true, callback()];
  } catch (error) {
    return [false, error];
  }
}

async function loadPropertyHandlers(
  utils: Record<string, unknown>,
  recording: Record<string, unknown>,
) {
  const dependencyPlugin: Plugin = {
    name: 'atomic-properties-dependencies',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/Utils$/ }, () => ({ path: 'Utils', namespace: 'atomic-properties' }));
      build.onResolve({ filter: /^\.\.\/Recording$/ }, () => ({ path: 'Recording', namespace: 'atomic-properties' }));
      build.onLoad({ filter: /.*/, namespace: 'atomic-properties' }, (args) => ({
        contents: args.path === 'Utils'
          ? 'export default globalThis.__ATOMIC_PROPERTIES_UTILS__;'
          : 'export default globalThis.__ATOMIC_PROPERTIES_RECORDING__;',
        loader: 'js',
      }));
    },
  };
  const built = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/handlers/PropertyHandlers.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [dependencyPlugin],
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    __ATOMIC_PROPERTIES_UTILS__: utils,
    __ATOMIC_PROPERTIES_RECORDING__: recording,
    pcall: robloxPcall,
    pairs: (value: Record<string, unknown>) => Object.entries(value),
    typeIs: (value: unknown, expected: string) => expected === 'table'
      ? value !== null && typeof value === 'object'
      : typeof value === expected,
    tostring: (value: unknown) => String(value),
    error: (message: unknown) => { throw new Error(String(message)); },
  });
  vm.runInContext('Array.prototype.size = function() { return this.length; };', context);
  vm.runInContext(built.outputFiles[0].text, context);
  return commonJsModule.exports as { setProperties: (request: Record<string, unknown>) => Record<string, unknown> };
}

function defaults(instance: object) {
  return {
    resolveInstance: jest.fn((path: unknown, ref: unknown) => (ref === 'stable-ref' || path === 'game.Target' ? instance : undefined)),
    getInstanceReference: jest.fn(() => 'stable-ref'),
    getInstancePath: jest.fn(() => 'game.Target'),
    convertPropertyValue: jest.fn((_instance: object, _property: string, value: unknown) => value),
    // Utils.samePropertyValue's tolerances matter only for Roblox numeric and
    // color types; these tests write strings and instances, which must match.
    samePropertyValue: jest.fn((actual: unknown, requested: unknown) => actual === requested),
  };
}

describe('atomic set_properties', () => {
  test('preflights then applies every property deterministically with Parent last and commits only on success', async () => {
    const writes: string[] = [];
    const parent = { Name: 'NewParent' };
    const state: Record<string, unknown> = { Alpha: 'old-alpha', Zebra: 'old-zebra', Parent: undefined };
    const instance: Record<string, unknown> = {};
    for (const property of ['Alpha', 'Zebra', 'Parent'] as const) {
      Object.defineProperty(instance, property, {
        get: () => state[property],
        set: (value) => { writes.push(property); state[property] = value; },
        enumerable: true,
      });
    }
    const utils = defaults(instance);
    utils.resolveInstance = jest.fn((path: unknown, ref: unknown) => {
      if (ref === 'stable-ref') return instance;
      return path === 'game.NewParent' ? parent : undefined;
    });
    const recording = { beginRecording: jest.fn(() => 'recording-id'), finishRecording: jest.fn() };
    const handlers = await loadPropertyHandlers(utils, recording);

    const result = handlers.setProperties({
      instancePath: 'stale.path', instanceRef: 'stable-ref',
      properties: { Zebra: 'new-zebra', Parent: 'game.NewParent', Alpha: 'new-alpha' },
    });

    expect(utils.resolveInstance).toHaveBeenCalledWith('stale.path', 'stable-ref');
    expect(state).toEqual({ Alpha: 'new-alpha', Zebra: 'new-zebra', Parent: parent });
    expect(writes).toEqual(['Alpha', 'Zebra', 'Parent']);
    expect(result).toMatchObject({
      instancePath: 'game.Target', instanceRef: 'stable-ref',
      summary: { total: 3, succeeded: 3, failed: 0 },
      results: [{ property: 'Alpha', success: true }, { property: 'Zebra', success: true }, { property: 'Parent', success: true }],
    });
    expect(recording.finishRecording).toHaveBeenCalledWith('recording-id', true);
  });

  test('a preflight error performs no writes and opens no recording', async () => {
    const instance: Record<string, unknown> = { Good: 'old' };
    Object.defineProperty(instance, 'Unreadable', { get: () => { throw new Error('read denied'); } });
    const utils = defaults(instance);
    const recording = { beginRecording: jest.fn(() => 'recording-id'), finishRecording: jest.fn() };
    const handlers = await loadPropertyHandlers(utils, recording);

    const result = handlers.setProperties({ instancePath: 'game.Target', properties: { Good: 'new', Unreadable: 'x' } });

    expect(result.error).toContain('preflight failed for Unreadable');
    expect(instance.Good).toBe('old');
    expect(recording.beginRecording).not.toHaveBeenCalled();
    expect(recording.finishRecording).not.toHaveBeenCalled();
  });

  test('a mid-apply failure restores all touched properties and cancels the recording', async () => {
    const values = { Alpha: 'old-alpha', Beta: 'old-beta' };
    const instance: Record<string, unknown> = {};
    Object.defineProperty(instance, 'Alpha', { get: () => values.Alpha, set: (value) => { values.Alpha = value as string; } });
    Object.defineProperty(instance, 'Beta', {
      get: () => values.Beta,
      set: (value) => { if (value === 'new-beta') throw new Error('write denied'); values.Beta = value as string; },
    });
    const recording = { beginRecording: jest.fn(() => 'recording-id'), finishRecording: jest.fn() };
    const handlers = await loadPropertyHandlers(defaults(instance), recording);

    const result = handlers.setProperties({ instancePath: 'game.Target', properties: { Beta: 'new-beta', Alpha: 'new-alpha' } });

    expect(result.error).toContain('Atomic set_properties failed for Beta');
    expect(values).toEqual({ Alpha: 'old-alpha', Beta: 'old-beta' });
    expect(result.rolledBack).toBe(true);
    expect(recording.finishRecording).toHaveBeenCalledWith('recording-id', false);
  });

  test('rejects Source with guidance to set_script_source before any mutation', async () => {
    const instance: Record<string, unknown> = { Source: 'old source' };
    const recording = { beginRecording: jest.fn(() => 'recording-id'), finishRecording: jest.fn() };
    const handlers = await loadPropertyHandlers(defaults(instance), recording);

    const result = handlers.setProperties({ instancePath: 'game.Target', properties: { Source: 'new source' } });

    expect(result.error).toContain('use set_script_source instead');
    expect(instance.Source).toBe('old source');
    expect(recording.beginRecording).not.toHaveBeenCalled();
  });

  test('reports rollback failures explicitly while still cancelling the recording', async () => {
    const values = { Alpha: 'old-alpha', Beta: 'old-beta' };
    const instance: Record<string, unknown> = {};
    Object.defineProperty(instance, 'Alpha', {
      get: () => values.Alpha,
      set: (value) => { if (value === 'old-alpha') throw new Error('restore denied'); values.Alpha = value as string; },
    });
    Object.defineProperty(instance, 'Beta', {
      get: () => values.Beta,
      set: (value) => { if (value === 'new-beta') throw new Error('write denied'); values.Beta = value as string; },
    });
    const recording = { beginRecording: jest.fn(() => 'recording-id'), finishRecording: jest.fn() };
    const handlers = await loadPropertyHandlers(defaults(instance), recording);

    const result = handlers.setProperties({ instancePath: 'game.Target', properties: { Alpha: 'new-alpha', Beta: 'new-beta' } });

    expect(result.error).toContain('Rollback failures: Alpha:');
    expect(result.rolledBack).toBe(false);
    expect(result.rollbackFailures).toEqual([{ property: 'Alpha', error: expect.stringContaining('restore denied') }]);
    expect(recording.finishRecording).toHaveBeenCalledWith('recording-id', false);
  });
});
