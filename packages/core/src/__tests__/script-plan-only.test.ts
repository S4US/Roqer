import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: (...args: unknown[]) => unknown, ...args: unknown[]): [boolean, unknown] {
  try {
    return [true, callback(...args)];
  } catch (error) {
    return [false, error];
  }
}

async function loadPluginModule<T>(
  relativePath: string,
  globals: Record<string, unknown>,
  plugins: Plugin[] = [],
): Promise<T> {
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins,
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    ...globals,
  });

  vm.runInContext(`
    String.prototype.gsub = function(search, replacement) {
      const parts = String(this).split(search);
      return [parts.join(replacement), parts.length - 1];
    };
    String.prototype.size = function() {
      return String(this).length;
    };
    String.prototype.sub = function(start, end) {
      return String(this).slice(start - 1, end);
    };
    Array.prototype.size = function() {
      return this.length;
    };
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  return commonJsModule.exports as T;
}

import { describe, expect, jest, test } from '@jest/globals';

type Handlers = Record<'getScriptSource' | 'setScriptSource' | 'editScriptLines' | 'editScriptBatch' | 'insertScriptLines' | 'deleteScriptLines', (request: Record<string, unknown>) => Record<string, unknown>>;

const luauString = {
  find: (source: string, needle: string, init = 1): [number | undefined, number | undefined] => {
    const at = source.indexOf(needle, init - 1);
    return at < 0 ? [undefined, undefined] : [at + 1, at + needle.length];
  },
  sub: (source: string, start: number, finish?: number) => source.slice(start - 1, finish === undefined ? undefined : finish),
};

async function load(currentSource: string, uniquePath = true) {
  const script = { Name: 'Main', ClassName: 'Script', IsA: (className: string) => className === 'LuaSourceContainer' };
  const applyScriptSource = jest.fn(() => ({ success: true, method: 'editor' }));
  const beginRecording = jest.fn(() => 'recording-id');
  const finishRecording = jest.fn();
  const plugin: Plugin = {
    name: 'plan-only-test-dependencies',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/(Utils|Recording|SourceRevision|ScriptSyntax)$/ }, (args) => ({ path: args.path.slice(3), namespace: 'plan-only' }));
      build.onLoad({ filter: /.*/, namespace: 'plan-only' }, (args) => ({
        contents: ({
          Utils: 'export default globalThis.__PLAN_UTILS__;',
          Recording: 'export default globalThis.__PLAN_RECORDING__;',
          SourceRevision: 'export const sourceRevision = globalThis.__PLAN_REVISION__;',
          ScriptSyntax: 'export const checkSyntax = () => ({});',
        } as Record<string, string>)[args.path],
        loader: 'js',
      }));
    },
  };
  const loaded = await loadPluginModule<{ default?: Handlers } & Partial<Handlers>>('studio-plugin/src/modules/handlers/ScriptHandlers.ts', {
    __PLAN_UTILS__: {
      getInstancePath: () => 'game.ServerScriptService.Main',
      getInstanceByPath: () => script,
      resolveInstance: () => script,
      getInstanceReference: () => 'instance:test:1',
      hasUniquePath: () => uniquePath,
      readScriptSource: () => currentSource,
      applyScriptSource,
      splitLines: (text: string) => [Object.assign(text.split('\n'), { size(this: string[]) { return this.length; } }), false],
      joinLines: (lines: string[]) => lines.join('\n'),
    },
    __PLAN_RECORDING__: { beginRecording, finishRecording },
    __PLAN_REVISION__: (text: string) => `revision:${text}`,
    string: luauString,
    math: { min: Math.min, max: Math.max },
    // editScriptBatch sorts its resolved edits with table.sort(t, (a, b) => a.start < b.start);
    // Luau's comparator is a strict less-than, so a tie (impossible here pre-sort
    // since starts are distinct) falls through to equal.
    table: {
      sort: <T>(list: T[], comp?: (a: T, b: T) => boolean) => {
        list.sort((a, b) => {
          if (!comp) return a < b ? -1 : a > b ? 1 : 0;
          if (comp(a, b)) return -1;
          if (comp(b, a)) return 1;
          return 0;
        });
      },
    },
    typeIs: (value: unknown, expectedType: string) => (expectedType === 'table' ? typeof value === 'object' && value !== null : typeof value === expectedType),
    pcall: robloxPcall,
    error: (message: unknown) => { throw new Error(String(message)); },
  }, [plugin]);
  return { handlers: (loaded.default ?? loaded) as Handlers, applyScriptSource, beginRecording, finishRecording };
}

const source = 'a\nb\nc';
const base = { instancePath: 'game.ServerScriptService.Main', planOnly: true };
const cases: [keyof Handlers, Record<string, unknown>, string][] = [
  ['setScriptSource', { source: 'x', expectedRevision: `revision:${source}` }, 'x'],
  ['editScriptLines', { old_string: 'b', new_string: 'B' }, 'a\nB\nc'],
  // Built outside the VM, so it needs the roblox-ts size() the VM's arrays get (see splitLines above).
  ['editScriptBatch', { edits: Object.assign([{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }], { size(this: unknown[]) { return this.length; } }), expectedRevision: `revision:${source}` }, 'A\nb\nC'],
  ['insertScriptLines', { afterLine: 1, newContent: 'new' }, 'a\nnew\nb\nc'],
  ['deleteScriptLines', { startLine: 2, endLine: 2 }, 'a\nc'],
];

describe('planOnly computes the edit and applies nothing', () => {
  test.each([true, false])('fresh getScriptSource reports real handler uniqueness=%s', async unique => {
    const { handlers, applyScriptSource } = await load(source, unique);
    expect(handlers.getScriptSource({ instancePath: base.instancePath, startLine: 1, endLine: 1 })).toMatchObject({ uniquePath: unique, instanceRef: 'instance:test:1', revision: `revision:${source}` });
    expect(applyScriptSource).not.toHaveBeenCalled();
  });
  test.each(cases)('%s', async (handler, request, expected) => {
    const { handlers, applyScriptSource, beginRecording, finishRecording } = await load(source);
    const result = handlers[handler]({ ...base, ...request });
    expect(result).toMatchObject({
      planned: true,
      instancePath: 'game.ServerScriptService.Main',
      instanceRef: 'instance:test:1',
      className: 'Script',
      uniquePath: true,
      previousRevision: `revision:${source}`,
      revision: `revision:${expected}`,
      source: expected,
    });
    expect(applyScriptSource).not.toHaveBeenCalled();
    expect(beginRecording).not.toHaveBeenCalled();
    expect(finishRecording).not.toHaveBeenCalled();
  });

  test.each(cases)('%s without planOnly still applies the same source', async (handler, request, expected) => {
    const { handlers, applyScriptSource } = await load(source);
    handlers[handler]({ instancePath: base.instancePath, ...request });
    expect(applyScriptSource).toHaveBeenCalledWith(expect.anything(), expected, source);
  });

  test('a stale plan is the same conflict as a stale edit', async () => {
    const { handlers } = await load('changed');
    expect(handlers.setScriptSource({ ...base, source: 'x', expectedRevision: `revision:${source}` })).toMatchObject({ errorCode: 'source_revision_conflict' });
  });

  test('a duplicate name on the path is reported', async () => {
    const { handlers } = await load(source, false);
    expect(handlers.editScriptLines({ ...base, old_string: 'b', new_string: 'B' })).toMatchObject({ planned: true, uniquePath: false });
  });
});
