import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWindowsNodeCli } from './lib/node-cli.mjs';
import { spawnSync } from 'node:child_process';

let root;
let execPath;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'roqer npm cli-'));
  execPath = path.join(root, 'node', 'node.exe');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(relative) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, '// fixture');
  return target;
}

test('the npm entry point supports spaces, Unicode and shell metacharacters', () => {
  const npmCli = file('npm 中文 & %!/npm-cli.js');
  assert.equal(resolveWindowsNodeCli('npm.cmd', 'win32', { npm_execpath: npmCli }, execPath), npmCli);
});

test('a resolved CLI and its arguments reach Node without shell expansion', () => {
  const npmCli = file('npm 中文 & %!/npm-cli.js');
  writeFileSync(npmCli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const resolved = resolveWindowsNodeCli('npm.cmd', 'win32', { npm_execpath: npmCli }, execPath);
  const args = ['argument with spaces', '中文 & %PATH% !'];
  const result = spawnSync(process.execPath, [resolved, ...args], {
    cwd: path.dirname(npmCli), encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('npx resolves beside the npm which launched the parent', () => {
  const npmCli = file('custom/npm-cli.js');
  const npxCli = file('custom/npx-cli.js');
  assert.equal(resolveWindowsNodeCli('C:\\tools\\NPX.CMD', 'win32', { npm_execpath: npmCli }, execPath), npxCli);
});

test('direct Node invocation can find the npm installed beside Node', () => {
  const npmCli = file('node/node_modules/npm/bin/npm-cli.js');
  assert.equal(resolveWindowsNodeCli('npm', 'win32', {}, execPath), npmCli);
});

test('a missing inherited npm entry falls back to the installed CLI', () => {
  const npmCli = file('node/node_modules/npm/bin/npm-cli.js');
  assert.equal(resolveWindowsNodeCli('npm', 'win32', { npm_execpath: path.join(root, 'missing/npm-cli.js') }, execPath), npmCli);
});

test('the lib/node_modules layout remains supported', () => {
  const npmCli = file('lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(resolveWindowsNodeCli('npm', 'win32', {}, execPath), npmCli);
});

test('missing CLIs and directories are not reported as executable scripts', () => {
  assert.equal(resolveWindowsNodeCli('npm', 'win32', {}, execPath), undefined);
  const candidate = path.join(root, 'node/node_modules/npm/bin/npm-cli.js');
  mkdirSync(candidate, { recursive: true });
  assert.equal(resolveWindowsNodeCli('npm', 'win32', {}, execPath), undefined);
});

test('other commands and non-Windows launch paths are unchanged', () => {
  const npmCli = file('custom/npm-cli.js');
  assert.equal(resolveWindowsNodeCli('node', 'win32', { npm_execpath: npmCli }, execPath), undefined);
  assert.equal(resolveWindowsNodeCli('npm', 'linux', { npm_execpath: npmCli }, execPath), undefined);
});
