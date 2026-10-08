import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { RojoIntegration } from '../rojo/index.js';
import type { RojoRunner } from '../rojo/sourcemap.js';

function project(files: Record<string, string>) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer link ')));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}
const sourcemap = { name: 'Game', className: 'DataModel', children: [
  { name: 'ServerScriptService', className: 'ServerScriptService', children: [
    { name: 'Main', className: 'Script', filePaths: ['src/Main.server.luau'] },
  ] },
] };
const runner = (map: unknown = sourcemap, version = 'Rojo 7.6.1'): RojoRunner => async (args) => (args[0] === '--version' ? version : JSON.stringify(map));
const deps = (run: RojoRunner) => ({ run, ignored: async () => new Set<string>(), probe: async () => ({ reachable: false }) });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('RojoIntegration', () => {
  test('links a place project and summarises it', async () => {
    const root = project({ 'default.project.json': '{"name":"Foo","servePort":40000,"tree":{"$className":"DataModel"}}', 'src/Main.server.luau': 'print(1)\n' });
    roots.push(root);
    const rojo = new RojoIntegration(deps(runner()));
    const summary = await rojo.link('place:1', path.join(root, 'default.project.json'));
    expect(summary).toMatchObject({ rojoVersion: '7.6.1', scripts: { file: 1, studio_only: 0, generated: 0, unsupported: 0 }, rojoServer: { port: 40000, reachable: false } });
    expect(rojo.hasLinks()).toBe(true);
    expect(rojo.linkFor('place:1')?.projectName).toBe('Foo');
  });
  test('refuses a path that is not an existing *.project.json file', async () => {
    const root = project({ 'notes.json': '{}' });
    roots.push(root);
    const rojo = new RojoIntegration(deps(runner()));
    await expect(rojo.link('place:1', path.join(root, 'notes.json'))).rejects.toMatchObject({ code: 'rojo_link_invalid' });
    await expect(rojo.link('place:1', path.join(root, 'missing.project.json'))).rejects.toMatchObject({ code: 'rojo_link_invalid' });
  });
  test('refuses one project for two places', async () => {
    const root = project({ 'default.project.json': '{"name":"Foo","tree":{"$className":"DataModel"}}', 'src/Main.server.luau': '' });
    roots.push(root);
    const rojo = new RojoIntegration(deps(runner()));
    await rojo.link('place:1', path.join(root, 'default.project.json'));
    await expect(rojo.link('anon:2', path.join(root, 'default.project.json'))).rejects.toMatchObject({ code: 'rojo_link_invalid', message: expect.stringMatching(/already linked/) });
  });
  test('refuses a non-place project at link time', async () => {
    const root = project({ 'default.project.json': '{"name":"Lib","tree":{"$path":"src"}}' });
    roots.push(root);
    const rojo = new RojoIntegration(deps(runner({ name: 'Lib', className: 'ModuleScript' })));
    await expect(rojo.link('place:1', path.join(root, 'default.project.json'))).rejects.toMatchObject({ code: 'rojo_link_invalid' });
  });
  test('resolve uses the cache for reads and re-runs rojo for writes', async () => {
    const root = project({ 'default.project.json': '{"name":"Foo","tree":{"$className":"DataModel"}}', 'src/Main.server.luau': '' });
    roots.push(root);
    let sourcemapRuns = 0;
    const run: RojoRunner = async (args) => {
      if (args[0] === 'sourcemap') sourcemapRuns += 1;
      return args[0] === '--version' ? 'Rojo 7.6.1' : JSON.stringify(sourcemap);
    };
    let now = 0;
    const rojo = new RojoIntegration({ ...deps(run), now: () => now });
    await rojo.link('place:1', path.join(root, 'default.project.json'));
    const link = rojo.linkFor('place:1')!;
    expect(sourcemapRuns).toBe(1);
    await rojo.resolve(link, ['ServerScriptService', 'Main'], 'Script', true, { fresh: false });
    expect(sourcemapRuns).toBe(1);
    await rojo.resolve(link, ['ServerScriptService', 'Main'], 'Script', true, { fresh: true });
    expect(sourcemapRuns).toBe(2);
    now = 10_001;
    await rojo.resolve(link, ['ServerScriptService', 'Main'], 'Script', true, { fresh: false });
    expect(sourcemapRuns).toBe(3);
  });
  test('unlink forgets the place', async () => {
    const root = project({ 'default.project.json': '{"name":"Foo","tree":{"$className":"DataModel"}}', 'src/Main.server.luau': '' });
    roots.push(root);
    const rojo = new RojoIntegration(deps(runner()));
    await rojo.link('place:1', path.join(root, 'default.project.json'));
    expect(rojo.unlink('place:1')).toBe(true);
    expect(rojo.linkFor('place:1')).toBeUndefined();
    expect(rojo.hasLinks()).toBe(false);
  });
});
