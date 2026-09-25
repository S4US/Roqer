import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

/**
 * The plugin's own property conversion, run outside Studio. A model sent
 * build_instances Color [107, 64, 31] meaning brown; Color3.new took it without
 * complaint and the cart came out pale blue, which only a screenshot showed.
 */

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

class Color3 {
  constructor(readonly R: number, readonly G: number, readonly B: number) {}
}
class Vector3 {
  constructor(readonly X: number, readonly Y: number, readonly Z: number) {}
}

type Convert = (instance: object, property: string, value: unknown) => unknown;

async function loadConvert(): Promise<Convert> {
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/Utils.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    Color3,
    Vector3,
    math: Math,
    game: { GetService: () => ({ GenerateGUID: () => 'plugin-color3-session' }) },
    typeIs: (value: unknown, kind: string) => (kind === 'table' ? typeof value === 'object' && value !== null : typeof value === kind),
    typeOf: (value: unknown) => (value instanceof Color3 ? 'Color3' : value instanceof Vector3 ? 'Vector3' : typeof value),
    tostring: (value: unknown) => String(value),
    pcall: (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      try {
        return [true, callback(...args)];
      } catch (error) {
        return [false, error instanceof Error ? error.message : error];
      }
    },
    error: (message: unknown) => {
      throw new Error(String(message));
    },
    warn: () => undefined,
  });
  vm.runInContext(`
    Array.prototype.size = function() { return this.length; };
    String.prototype.lower = function() { return String(this).toLowerCase(); };
    String.prototype.gsub = function(search, replacement) {
      const parts = String(this).split(search);
      return [parts.join(replacement), parts.length - 1];
    };
    String.prototype.size = function() { return String(this).length; };
    String.prototype.sub = function(start, end) { return String(this).slice(start - 1, end); };
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  const exported = commonJsModule.exports as { default?: { convertPropertyValue?: Convert }; convertPropertyValue?: Convert };
  const convert = exported.default?.convertPropertyValue ?? exported.convertPropertyValue;
  if (!convert) throw new Error('Utils does not export convertPropertyValue');
  return convert;
}

describe('plugin Color3 conversion', () => {
  const part = { Color: new Color3(0.5, 0.5, 0.5) };

  // The values under test are made in this realm, not the module's, so they
  // need roblox-ts's size() here too: Luau's # of an array, and 0 for a table
  // with only named keys, such as { R, G, B }.
  beforeAll(() => {
    Object.defineProperty(Object.prototype, 'size', {
      configurable: true,
      value(this: unknown) {
        return Array.isArray(this) ? this.length : 0;
      },
    });
  });
  afterAll(() => {
    delete (Object.prototype as unknown as { size?: unknown }).size;
  });

  test('0-1 components become a Color3, as arrays or R/G/B objects', async () => {
    const convert = await loadConvert();
    expect(convert(part, 'Color', [0.42, 0.25, 0.12])).toEqual(new Color3(0.42, 0.25, 0.12));
    expect(convert(part, 'Color', { R: 0, G: 1, B: 0.5 })).toEqual(new Color3(0, 1, 0.5));
  });

  test('0-255 components are refused with the fix, not stored as another colour', async () => {
    const convert = await loadConvert();
    expect(() => convert(part, 'Color', [107, 64, 31])).toThrow(/0 to 1, got \[107, 64, 31\]; divide 0-255 values by 255/);
    expect(() => convert(part, 'Color', { R: 107, G: 64, B: 31 })).toThrow(/0 to 1/);
    expect(() => convert(part, 'Color', [-0.1, 0, 0])).toThrow(/0 to 1/);
  });

  test('a Color3-typed property under another name is checked the same way', async () => {
    const convert = await loadConvert();
    const light = { Ambient: new Color3(0, 0, 0) };
    expect(() => convert(light, 'Ambient', [200, 200, 200])).toThrow(/0 to 1/);
    expect(convert(light, 'Ambient', [0.2, 0.2, 0.2])).toEqual(new Color3(0.2, 0.2, 0.2));
  });
});
