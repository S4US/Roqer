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

describe('script source update safety', () => {
  test('applyScriptSource leaves the original instance intact when both in-place writes fail', async () => {
    const parent = { name: 'parent' };
    const destroy = jest.fn();
    const source = 'old source';
    const instance = { Parent: parent, Destroy: destroy };
    Object.defineProperty(instance, 'Source', {
      get: () => source,
      set: () => {
        throw new Error('direct assignment blocked');
      },
    });
    const updateSourceAsync = jest.fn(() => {
      throw new Error('editor update blocked');
    });

    const utils = await loadPluginModule<{
      applyScriptSource: (
        target: object,
        newSource: string,
      ) => { success: boolean; error?: string };
    }>('studio-plugin/src/modules/Utils.ts', {
      game: {
        GetService: (serviceName: string) => serviceName === 'HttpService'
          ? { GenerateGUID: () => 'script-source-safety-session' }
          : {
              FindScriptDocument: () => undefined,
              UpdateSourceAsync: updateSourceAsync,
            },
      },
      pcall: robloxPcall,
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      warn: jest.fn(),
    });

    const result = utils.applyScriptSource(instance, 'new source');

    expect(result.success).toBe(false);
    expect(result.error).toContain('editor update blocked');
    expect(result.error).toContain('direct assignment blocked');
    expect(source).toBe('old source');
    expect(instance.Parent).toBe(parent);
    expect(destroy).not.toHaveBeenCalled();
  });

  test('setScriptSource returns the in-place failure without constructing a replacement', async () => {
    const parent = { name: 'parent' };
    const destroy = jest.fn();
    const original = {
      Name: 'Main',
      ClassName: 'ModuleScript',
      Parent: parent,
      attributes: { preserved: true },
      Destroy: destroy,
      IsA: (className: string) => className === 'LuaSourceContainer',
    };
    const replacement = {
      Name: '',
      ClassName: 'ModuleScript',
      Parent: undefined as object | undefined,
      Source: '',
      IsA: () => false,
    };
    const instanceConstructor = jest.fn(function MockInstance() {
      return replacement;
    });
    const applyScriptSource = jest.fn(() => ({
      success: false,
      method: 'direct',
      error: 'UpdateSourceAsync failed: editor blocked. Direct assignment failed: source locked.',
    }));
    const finishRecording = jest.fn();

    const dependencyPlugin: Plugin = {
      name: 'script-source-test-dependencies',
      setup(build) {
        build.onResolve({ filter: /^\.\.\/Utils$/ }, () => ({
          path: 'Utils',
          namespace: 'script-source-test',
        }));
        build.onResolve({ filter: /^\.\.\/Recording$/ }, () => ({
          path: 'Recording',
          namespace: 'script-source-test',
        }));
        build.onResolve({ filter: /^\.\.\/SourceRevision$/ }, () => ({
          path: 'SourceRevision',
          namespace: 'script-source-test',
        }));
        build.onLoad({ filter: /.*/, namespace: 'script-source-test' }, (args) => ({
          contents: args.path === 'Utils'
            ? 'export default globalThis.__SCRIPT_SOURCE_TEST_UTILS__;'
            : args.path === 'Recording'
              ? 'export default globalThis.__SCRIPT_SOURCE_TEST_RECORDING__;'
              : 'export const sourceRevision = globalThis.__SCRIPT_SOURCE_TEST_REVISION__;',
          loader: 'js',
        }));
      },
    };
    const loaded = await loadPluginModule<{
      default?: { setScriptSource: (request: Record<string, unknown>) => Record<string, unknown> };
      setScriptSource?: (request: Record<string, unknown>) => Record<string, unknown>;
    }>('studio-plugin/src/modules/handlers/ScriptHandlers.ts', {
      __SCRIPT_SOURCE_TEST_UTILS__: {
        getInstancePath: () => 'game.ServerScriptService.Main',
        getInstanceByPath: () => original,
        resolveInstance: () => original,
        getInstanceReference: () => 'instance:test:1',
        readScriptSource: (target: unknown) => target === original ? 'old source' : replacement.Source,
        applyScriptSource,
        splitLines: jest.fn(),
        joinLines: jest.fn(),
      },
      __SCRIPT_SOURCE_TEST_RECORDING__: {
        beginRecording: () => 'recording-id',
        finishRecording,
      },
      __SCRIPT_SOURCE_TEST_REVISION__: (sourceText: string) => `revision:${sourceText}`,
      typeIs: (value: unknown, expectedType: string) => typeof value === expectedType,
      pcall: robloxPcall,
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      Instance: instanceConstructor,
    }, [dependencyPlugin]);
    const handlers = loaded.default ?? loaded;

    const result = handlers.setScriptSource!({
      instancePath: 'game.ServerScriptService.Main',
      source: 'new source',
      expectedRevision: 'revision:old source',
    });

    expect(result.error).toContain('UpdateSourceAsync failed: editor blocked');
    expect(result.success).not.toBe(true);
    expect(applyScriptSource).toHaveBeenCalledWith(original, 'new source', 'old source');
    expect(instanceConstructor).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(original.Parent).toBe(parent);
    expect(original.attributes).toEqual({ preserved: true });
    expect(finishRecording).toHaveBeenCalledWith('recording-id', false);

    applyScriptSource.mockClear();
    finishRecording.mockClear();
    const conflict = handlers.setScriptSource!({
      instancePath: 'game.ServerScriptService.Main',
      source: 'stale replacement',
      expectedRevision: 'revision:older source',
    });

    expect(conflict).toMatchObject({
      errorCode: 'source_revision_conflict',
      expectedRevision: 'revision:older source',
      actualRevision: 'revision:old source',
      instanceRef: 'instance:test:1',
    });
    expect(applyScriptSource).not.toHaveBeenCalled();
    expect(finishRecording).not.toHaveBeenCalled();
  });

  describe('line edits check the revision they were read at', () => {
    type LineHandlers = {
      insertScriptLines: (request: Record<string, unknown>) => Record<string, unknown>;
      deleteScriptLines: (request: Record<string, unknown>) => Record<string, unknown>;
      editScriptLines: (request: Record<string, unknown>) => Record<string, unknown>;
      checkScriptSource: (request: Record<string, unknown>) => Record<string, unknown>;
    };

    async function loadLineHandlers(currentSource: string) {
      const script = {
        Name: 'Main',
        ClassName: 'ModuleScript',
        IsA: (className: string) => className === 'LuaSourceContainer',
      };
      const applyScriptSource = jest.fn(() => ({ success: true, method: 'editor' }));
      const beginRecording = jest.fn(() => 'recording-id');
      const dependencyPlugin: Plugin = {
        name: 'line-edit-test-dependencies',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/(Utils|Recording|SourceRevision)$/ }, (args) => ({
            path: args.path.slice(3),
            namespace: 'line-edit-test',
          }));
          build.onLoad({ filter: /.*/, namespace: 'line-edit-test' }, (args) => ({
            contents: args.path === 'Utils'
              ? 'export default globalThis.__LINE_TEST_UTILS__;'
              : args.path === 'Recording'
                ? 'export default globalThis.__LINE_TEST_RECORDING__;'
                : 'export const sourceRevision = globalThis.__LINE_TEST_REVISION__;',
            loader: 'js',
          }));
        },
      };
      const loaded = await loadPluginModule<{ default?: LineHandlers } & Partial<LineHandlers>>(
        'studio-plugin/src/modules/handlers/ScriptHandlers.ts',
        {
          __LINE_TEST_UTILS__: {
            getInstancePath: () => 'game.ServerScriptService.Main',
            resolveInstance: () => script,
            getInstanceReference: () => 'instance:test:1',
            readScriptSource: () => currentSource,
            applyScriptSource,
            // Built outside the VM, so it needs the roblox-ts size() the VM's arrays get.
            splitLines: (text: string) => [Object.assign(text.split('\n'), {
              size(this: string[]) { return this.length; },
            }), false],
            joinLines: (lines: string[]) => lines.join('\n'),
          },
          __LINE_TEST_RECORDING__: { beginRecording, finishRecording: jest.fn() },
          __LINE_TEST_REVISION__: (sourceText: string) => `revision:${sourceText}`,
          typeIs: (value: unknown, expectedType: string) => typeof value === expectedType,
          pcall: robloxPcall,
          error: (message: unknown) => {
            throw new Error(String(message));
          },
        },
        [dependencyPlugin],
      );
      return { handlers: (loaded.default ?? loaded) as LineHandlers, applyScriptSource, beginRecording };
    }

    // Line 2 was "b" when the model read the script; the user has since added
    // a line above it, so deleting line 2 now would remove their "new" line.
    const readSource = 'a\nb\nc';
    const changedSource = 'a\nnew\nb\nc';

    test('the private source check validates revision and identity without recording or assigning Source', async () => {
      const { handlers, applyScriptSource, beginRecording } = await loadLineHandlers(readSource);
      const checked = handlers.checkScriptSource({ instancePath: 'game.ServerScriptService.Main', source: 'return 2', expectedRevision: `revision:${readSource}` });
      expect(checked).toMatchObject({ instancePath: 'game.ServerScriptService.Main', instanceRef: 'instance:test:1', syntaxCheck: 'unavailable' });
      const stale = handlers.checkScriptSource({ instancePath: 'game.ServerScriptService.Main', source: 'return 3', expectedRevision: 'revision:stale' });
      expect(stale.errorCode).toBe('source_revision_conflict');
      expect(applyScriptSource).not.toHaveBeenCalled();
      expect(beginRecording).not.toHaveBeenCalled();
    });

    test('an exact edit supplied with a stale revision is refused before matching or writing', async () => {
      const { handlers, applyScriptSource, beginRecording } = await loadLineHandlers(changedSource);
      const result = handlers.editScriptLines({ instancePath: 'game.ServerScriptService.Main', old_string: 'b', new_string: 'edited', expectedRevision: `revision:${readSource}` });
      expect(result.errorCode).toBe('source_revision_conflict');
      expect(applyScriptSource).not.toHaveBeenCalled();
      expect(beginRecording).not.toHaveBeenCalled();
    });

    test('a stale delete is refused before anything is recorded or written', async () => {
      const { handlers, applyScriptSource, beginRecording } = await loadLineHandlers(changedSource);
      const result = handlers.deleteScriptLines({
        instancePath: 'game.ServerScriptService.Main',
        startLine: 2,
        endLine: 2,
        expectedRevision: `revision:${readSource}`,
      });
      expect(result).toMatchObject({
        errorCode: 'source_revision_conflict',
        expectedRevision: `revision:${readSource}`,
        actualRevision: `revision:${changedSource}`,
      });
      expect(applyScriptSource).not.toHaveBeenCalled();
      expect(beginRecording).not.toHaveBeenCalled();
    });

    test('a stale insert is refused too', async () => {
      const { handlers, applyScriptSource } = await loadLineHandlers(changedSource);
      const result = handlers.insertScriptLines({
        instancePath: 'game.ServerScriptService.Main',
        afterLine: 1,
        newContent: 'inserted',
        expectedRevision: `revision:${readSource}`,
      });
      expect(result.errorCode).toBe('source_revision_conflict');
      expect(applyScriptSource).not.toHaveBeenCalled();
    });

    test('a current revision, or none, edits as before', async () => {
      const { handlers, applyScriptSource } = await loadLineHandlers(readSource);
      const current = handlers.deleteScriptLines({
        instancePath: 'game.ServerScriptService.Main',
        startLine: 2,
        endLine: 2,
        expectedRevision: `revision:${readSource}`,
      });
      expect(current).toMatchObject({ success: true, previousRevision: `revision:${readSource}` });
      expect(applyScriptSource).toHaveBeenLastCalledWith(expect.anything(), 'a\nc', readSource);

      const unchecked = handlers.insertScriptLines({
        instancePath: 'game.ServerScriptService.Main',
        afterLine: 1,
        newContent: 'inserted',
      });
      expect(unchecked).toMatchObject({ success: true });
      expect(applyScriptSource).toHaveBeenLastCalledWith(expect.anything(), 'a\ninserted\nb\nc', readSource);
    });
  });

  describe('a write says whether its source compiles', () => {
    type SyntaxReport = { syntaxError?: { line?: number; message: string }; syntaxCheck?: string };

    // Enough of Luau's string library for the check: `%d` and `.` in the one
    // pattern it matches, and plain finds.
    const luaString = {
      find: (text: string, needle: string, init = 1, plain = false) => {
        if (!plain) throw new Error('only plain finds are shimmed');
        const index = text.indexOf(needle, init - 1);
        return index < 0 ? [undefined] : [index + 1, index + needle.length];
      },
      match: (text: string, pattern: string) => {
        const source = pattern.replace(/%d|\./g, (token) => (token === '%d' ? '\\d' : '[\\s\\S]'));
        const found = new RegExp(source).exec(text);
        return found ? found.slice(1) : [undefined];
      },
    };
    const luauGlobals = (loadstring: unknown) => ({
      loadstring,
      string: luaString,
      tostring: String,
      tonumber: (text: string) => (/^\d+$/.test(text) ? Number(text) : undefined),
      pcall: robloxPcall,
    });

    async function loadCheck(loadstring: unknown) {
      const loaded = await loadPluginModule<{ checkSyntax: (source: string) => SyntaxReport }>(
        'studio-plugin/src/modules/ScriptSyntax.ts',
        luauGlobals(loadstring),
      );
      return loaded.checkSyntax;
    }

    test('source that compiles adds nothing to the result', async () => {
      const loadstring = jest.fn(() => [() => undefined]);
      const checkSyntax = await loadCheck(loadstring);
      expect(checkSyntax('return 1')).toEqual({});
      // Named, so the error reads `source:N:` whatever the first line holds; a
      // first line with a quote in it would otherwise garble the default name.
      expect(loadstring).toHaveBeenCalledWith('return 1', '=source');
    });

    test('a compile error comes back with its line and message', async () => {
      const checkSyntax = await loadCheck(() => [undefined, "source:3: Expected 'end' (to close 'function' at line 1), got <eof>"]);
      expect(checkSyntax('function f()\n\n')).toEqual({
        syntaxError: { line: 3, message: "Expected 'end' (to close 'function' at line 1), got <eof>" },
      });
    });

    test('an error in another shape is passed on whole rather than dropped', async () => {
      const checkSyntax = await loadCheck(() => [undefined, 'something unexpected']);
      expect(checkSyntax('x')).toEqual({ syntaxError: { message: 'something unexpected' } });
    });

    test('a Studio that cannot compile a chunk says the check did not run', async () => {
      const unavailable = await loadCheck(() => [undefined, 'loadstring() is not available']);
      expect(unavailable('return 1')).toEqual({ syntaxCheck: 'unavailable' });
      const throwing = await loadCheck(() => {
        throw new Error('loadstring() is not available');
      });
      expect(throwing('return 1')).toEqual({ syntaxCheck: 'unavailable' });
    });

    test('a line edit that breaks the script still lands, and its result says where', async () => {
      const script = { Name: 'Main', ClassName: 'Script', IsA: (className: string) => className === 'LuaSourceContainer' };
      const applyScriptSource = jest.fn(() => ({ success: true, method: 'UpdateSourceAsync' }));
      const dependencyPlugin: Plugin = {
        name: 'syntax-test-dependencies',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/(Utils|Recording|SourceRevision)$/ }, (args) => ({
            path: args.path.slice(3),
            namespace: 'syntax-test',
          }));
          build.onLoad({ filter: /.*/, namespace: 'syntax-test' }, (args) => ({
            contents: args.path === 'Utils'
              ? 'export default globalThis.__SYNTAX_TEST_UTILS__;'
              : args.path === 'Recording'
                ? 'export default globalThis.__SYNTAX_TEST_RECORDING__;'
                : 'export const sourceRevision = (text) => `revision:${text}`;',
            loader: 'js',
          }));
        },
      };
      type InsertHandler = { insertScriptLines: (request: Record<string, unknown>) => Record<string, unknown> };
      const loaded = await loadPluginModule<{ default?: InsertHandler } & Partial<InsertHandler>>('studio-plugin/src/modules/handlers/ScriptHandlers.ts', {
        __SYNTAX_TEST_UTILS__: {
          getInstancePath: () => 'game.ServerScriptService.Main',
          resolveInstance: () => script,
          getInstanceReference: () => 'instance:test:1',
          readScriptSource: () => 'local a = 1\nreturn a',
          applyScriptSource,
          splitLines: (text: string) => [Object.assign(text.split('\n'), {
            size(this: string[]) { return this.length; },
          }), false],
          joinLines: (lines: string[]) => lines.join('\n'),
        },
        __SYNTAX_TEST_RECORDING__: { beginRecording: () => 'recording-id', finishRecording: jest.fn() },
        // Compiles anything but the inserted line, which it rejects as Luau would.
        ...luauGlobals((source: string) => (source.includes('= =')
          ? [undefined, "source:2: Expected identifier when parsing expression, got '='"]
          : [() => undefined])),
        typeIs: (value: unknown, expectedType: string) => typeof value === expectedType,
        error: (message: unknown) => {
          throw new Error(String(message));
        },
      }, [dependencyPlugin]);
      const { insertScriptLines } = (loaded.default ?? loaded) as InsertHandler;

      const broken = insertScriptLines({ instancePath: 'game.ServerScriptService.Main', afterLine: 1, newContent: 'local b = = 2' });
      expect(broken).toMatchObject({
        success: true,
        syntaxError: { line: 2, message: "Expected identifier when parsing expression, got '='" },
      });
      expect(applyScriptSource).toHaveBeenCalledWith(script, 'local a = 1\nlocal b = = 2\nreturn a', 'local a = 1\nreturn a');

      const clean = insertScriptLines({ instancePath: 'game.ServerScriptService.Main', afterLine: 1, newContent: 'local b = 2' });
      expect(clean.success).toBe(true);
      expect(clean).not.toHaveProperty('syntaxError');
      expect(clean).not.toHaveProperty('syntaxCheck');
    });
  });
});
