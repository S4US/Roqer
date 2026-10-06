import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { checkFile, gitIgnored, locateScript, scriptFiles } from '../rojo/ownership.js';
import type { SourcemapNode } from '../rojo/sourcemap.js';

const tree: SourcemapNode = { name: 'Game', className: 'DataModel', filePaths: ['default.project.json'], children: [
  { name: 'ServerScriptService', className: 'ServerScriptService', children: [
    { name: 'Main', className: 'Script', filePaths: ['src/server/Main.server.luau'] },
    { name: 'Combat', className: 'ModuleScript', filePaths: ['src/server/Combat/init.luau', 'src/server/Combat/init.meta.json'] },
    { name: 'Renamed', className: 'ModuleScript', filePaths: ['src/server/actual_file.luau'] },
    { name: 'Twin', className: 'ModuleScript', filePaths: ['src/server/Twin.luau'] },
    { name: 'Twin', className: 'ModuleScript', filePaths: ['src/server/Twin2/init.luau'] },
    { name: 'FromModel', className: 'Model', filePaths: ['assets/thing.rbxm'], children: [
      { name: 'Inner', className: 'Script' },
    ] },
  ] },
  { name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [
    { name: 'Packages', className: 'Folder', filePaths: ['Packages'], children: [
      { name: 'Promise', className: 'ModuleScript', filePaths: ['Packages/_Index/evaera_promise@4.0.0/promise/lib/init.lua'] },
    ] },
    { name: 'Shared', className: 'Folder', filePaths: ['shared.project.json'], children: [
      { name: 'Util', className: 'ModuleScript', filePaths: ['src/shared/Util.luau'] },
    ] },
  ] },
] };

describe('locateScript', () => {
  test('plain, init and $path-renamed scripts map to their file', () => {
    expect(locateScript(tree, ['ServerScriptService', 'Main'], 'Script', true)).toEqual({ found: 'src/server/Main.server.luau' });
    expect(locateScript(tree, ['ServerScriptService', 'Combat'], 'ModuleScript', true)).toEqual({ found: 'src/server/Combat/init.luau' });
    expect(locateScript(tree, ['ServerScriptService', 'Renamed'], 'ModuleScript', true)).toEqual({ found: 'src/server/actual_file.luau' });
  });
  test('a nested project is walked like any other node', () => {
    expect(locateScript(tree, ['ReplicatedStorage', 'Shared', 'Util'], 'ModuleScript', true)).toEqual({ found: 'src/shared/Util.luau' });
  });
  test('a script Rojo does not know is studio_only', () => {
    expect(locateScript(tree, ['ServerScriptService', 'MadeInStudio'], 'Script', true)).toMatchObject({ persistence: 'studio_only' });
  });
  test('duplicate siblings in the project or in Studio are ambiguous', () => {
    expect(locateScript(tree, ['ServerScriptService', 'Twin'], 'ModuleScript', true)).toMatchObject({ persistence: 'unsupported', reason: expect.stringMatching(/ambiguous/) });
    expect(locateScript(tree, ['ServerScriptService', 'Main'], 'Script', false)).toMatchObject({ persistence: 'unsupported', reason: expect.stringMatching(/ambiguous/) });
  });
  test('a script inside a model file has no source file of its own', () => {
    expect(locateScript(tree, ['ServerScriptService', 'FromModel', 'Inner'], 'Script', true)).toMatchObject({ persistence: 'unsupported', reason: expect.stringMatching(/model or project file/) });
  });
  test('a class that differs from the project is a mismatch', () => {
    expect(locateScript(tree, ['ServerScriptService', 'Main'], 'LocalScript', true)).toMatchObject({ persistence: 'unsupported', reason: expect.stringMatching(/class does not match/) });
  });
  test('a non-place project is refused', () => {
    const library: SourcemapNode = { name: 'Lib', className: 'ModuleScript', filePaths: ['src/init.luau'] };
    expect(locateScript(library, ['ReplicatedStorage', 'Lib'], 'ModuleScript', true)).toMatchObject({ persistence: 'unsupported', reason: expect.stringMatching(/DataModel/) });
  });
  test('scriptFiles lists every script source file once', () => {
    expect(scriptFiles(tree).sort()).toEqual([
      'Packages/_Index/evaera_promise@4.0.0/promise/lib/init.lua',
      'src/server/Combat/init.luau', 'src/server/Main.server.luau', 'src/server/Twin.luau',
      'src/server/Twin2/init.luau', 'src/server/actual_file.luau', 'src/shared/Util.luau',
    ]);
  });
});

describe('checkFile', () => {
  let root: string;
  let outside: string;
  let symlinked = true;
  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer rojo ')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer outside ')));
    fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'server', 'Main.server.luau'), 'print(1)\n');
    fs.mkdirSync(path.join(root, 'Packages', '_Index', 'p'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Packages', '_Index', 'p', 'init.lua'), 'return {}\n');
    fs.writeFileSync(path.join(root, 'src', 'server', 'Built.luau'), '-- compiled\n');
    fs.writeFileSync(path.join(outside, 'Evil.luau'), 'print(2)\n');
    fs.writeFileSync(path.join(root, 'src', 'server', 'notes.txt'), 'x');
    try {
      fs.symlinkSync(path.join(outside, 'Evil.luau'), path.join(root, 'src', 'server', 'Link.luau'));
    } catch {
      // Windows without Developer Mode cannot make symlinks; that case is then not exercised here.
      symlinked = false;
    }
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const none = () => false;

  test('resolves a project path containing spaces', () => {
    expect(checkFile(root, 'src/server/Main.server.luau', none)).toMatchObject({
      persistence: 'file',
      file: path.join(root, 'src', 'server', 'Main.server.luau'),
      relativeFile: path.join('src', 'server', 'Main.server.luau'),
    });
  });
  test('Wally _Index is generated', () => {
    expect(checkFile(root, 'Packages/_Index/p/init.lua', none)).toMatchObject({ persistence: 'generated' });
  });
  test('a git-ignored file is generated', () => {
    expect(checkFile(root, 'src/server/Built.luau', (real) => real.endsWith('Built.luau'))).toMatchObject({ persistence: 'generated' });
  });
  test('a symlink that leaves the project is unsupported', () => {
    if (!symlinked) return;
    expect(checkFile(root, 'src/server/Link.luau', none)).toMatchObject({ persistence: 'unsupported', reason: expect.stringMatching(/outside/) });
  });
  test('a ../ path and a missing file are unsupported', () => {
    expect(checkFile(root, '../Evil.luau', none)).toMatchObject({ persistence: 'unsupported' });
    expect(checkFile(root, 'src/server/Gone.luau', none)).toMatchObject({ persistence: 'unsupported', reason: expect.stringMatching(/missing/) });
  });
  test('only .lua and .luau files are written', () => {
    expect(checkFile(root, 'src/server/notes.txt', none)).toMatchObject({ persistence: 'unsupported' });
  });
});

describe('gitIgnored', () => {
  let root: string;
  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer ignore ')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), 'out/\n');
    fs.writeFileSync(path.join(root, 'out', 'Built.luau'), '-- compiled\n');
    fs.writeFileSync(path.join(root, 'src', 'Main.luau'), 'print(1)\n');
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reports exactly the files Git ignores', async () => {
    const built = path.join(root, 'out', 'Built.luau');
    const main = path.join(root, 'src', 'Main.luau');
    const ignored = await gitIgnored(root, [built, main]);
    expect(ignored).toEqual(new Set([built]));
  });

  test('an empty file list is answered without asking Git', async () => {
    expect(await gitIgnored(root, [])).toEqual(new Set());
  });

  test('a directory that is not a Git repository ignores nothing', async () => {
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer notrepo ')));
    try {
      const file = path.join(outside, 'Main.luau');
      fs.writeFileSync(file, 'print(1)\n');
      expect(await gitIgnored(outside, [file])).toEqual(new Set());
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
