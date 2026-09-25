import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: (...args: never[]) => unknown): [boolean, unknown] {
  try {
    return [true, callback()];
  } catch (error) {
    return [false, error];
  }
}

async function loadInstanceReferences(globals: Record<string, unknown>) {
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/InstanceReferences.ts')],
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
    ...globals,
  });
  vm.runInContext(`
    String.prototype.gsub = function(search, replacement) {
      const parts = String(this).split(search);
      return [parts.join(replacement), parts.length - 1];
    };
    String.prototype.sub = function(start, end) {
      return String(this).slice(start - 1, end);
    };
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  return commonJsModule.exports as {
    getInstanceReference(instance: object): string;
    resolveInstanceReference(reference: string): object | undefined;
  };
}

function createGame(namespace: string) {
  const game = {
    GetService: () => ({ GenerateGUID: () => namespace }),
  };
  return game;
}

function createInstance(game: object, parent: object | undefined = game) {
	let currentParent: object | undefined = parent;
  return {
    get Parent() {
      return currentParent;
    },
    set Parent(value: object | undefined) {
      currentParent = value;
    },
    IsDescendantOf(ancestor: object) {
		let cursor: object | undefined = currentParent;
      while (cursor !== undefined) {
        if (cursor === ancestor) return true;
        cursor = (cursor as { Parent?: object }).Parent;
      }
      return false;
    },
  };
}

describe('session-local instance references', () => {
  test('is stable for one live instance, distinct for another, and rejects unknown handles', async () => {
    const game = createGame('session-a');
    const references = await loadInstanceReferences({ game, pcall: robloxPcall, error: (message: unknown) => { throw new Error(String(message)); } });
    const first = createInstance(game);
    const second = createInstance(game);

    const firstReference = references.getInstanceReference(first);

    expect(references.getInstanceReference(first)).toBe(firstReference);
    expect(references.getInstanceReference(second)).not.toBe(firstReference);
    expect(references.resolveInstanceReference(firstReference)).toBe(first);
    const gameReference = references.getInstanceReference(game);
    expect(references.resolveInstanceReference(gameReference)).toBe(game);
    expect(references.resolveInstanceReference('instance:session-a:999')).toBeUndefined();
  });

  test('keeps a reference through rename or reparenting inside game, then invalidates it after removal', async () => {
    const game = createGame('session-b');
    const references = await loadInstanceReferences({ game, pcall: robloxPcall, error: (message: unknown) => { throw new Error(String(message)); } });
    const firstParent = createInstance(game);
    const secondParent = createInstance(game);
    const instance = createInstance(game, firstParent) as { Parent: object | undefined; Name?: string };
    const reference = references.getInstanceReference(instance);

    instance.Name = 'Renamed';
    instance.Parent = secondParent;
    expect(references.resolveInstanceReference(reference)).toBe(instance);

    instance.Parent = undefined;
    expect(references.resolveInstanceReference(reference)).toBeUndefined();
    instance.Parent = game;
    expect(references.resolveInstanceReference(reference)).toBeUndefined();
  });

  test('uses a different namespace for each loaded plugin-module session', async () => {
    const firstGame = createGame('session-one');
    const secondGame = createGame('session-two');
    const firstReferences = await loadInstanceReferences({ game: firstGame, pcall: robloxPcall, error: (message: unknown) => { throw new Error(String(message)); } });
    const secondReferences = await loadInstanceReferences({ game: secondGame, pcall: robloxPcall, error: (message: unknown) => { throw new Error(String(message)); } });
    const firstReference = firstReferences.getInstanceReference(createInstance(firstGame));

    expect(firstReference).not.toBe(secondReferences.getInstanceReference(createInstance(secondGame)));
    expect(secondReferences.resolveInstanceReference(firstReference)).toBeUndefined();
  });
});
