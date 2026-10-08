import { describe, expect, test } from '@jest/globals';
import { RojoError, loadSourcemap, rojoVersion, validateSourcemap, type RojoRunner } from '../rojo/sourcemap.js';

const tree = { name: 'Game', className: 'DataModel', children: [
  { name: 'ServerScriptService', className: 'ServerScriptService', children: [
    { name: 'Main', className: 'Script', filePaths: ['src/server/Main.server.luau'] },
  ] },
] };

describe('rojo sourcemap', () => {
  test('reads the version from rojo --version', async () => {
    const run: RojoRunner = async () => 'Rojo 7.6.1\n';
    await expect(rojoVersion(run, '/p')).resolves.toBe('7.6.1');
  });
  test('refuses Rojo older than 7.3', async () => {
    const run: RojoRunner = async () => 'Rojo 7.2.1\n';
    await expect(rojoVersion(run, '/p')).rejects.toMatchObject({ code: 'rojo_link_invalid' });
  });
  test('a missing rojo binary is rojo_not_found with a fix', async () => {
    const run: RojoRunner = async () => { throw Object.assign(new Error('spawn rojo ENOENT'), { code: 'ENOENT' }); };
    const error = await rojoVersion(run, '/p').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RojoError);
    expect((error as RojoError).code).toBe('rojo_not_found');
    expect((error as RojoError).message).toMatch(/install Rojo|PATH/);
  });
  test('runs sourcemap in the project folder with the project file and no --absolute', async () => {
    const seen: { args: string[]; cwd: string }[] = [];
    const run: RojoRunner = async (args: string[], cwd: string) => { seen.push({ args, cwd }); return JSON.stringify(tree); };
    await expect(loadSourcemap('/games/My Game/default.project.json', run)).resolves.toEqual(tree);
    expect(seen).toEqual([{ args: ['sourcemap', 'default.project.json'], cwd: '/games/My Game' }]);
  });
  test('rejects a tree that is not a sourcemap', () => {
    expect(() => validateSourcemap({ name: 'x' })).toThrow(RojoError);
    expect(() => validateSourcemap({ name: 'x', className: 'Folder', children: [{ name: 1 }] })).toThrow(RojoError);
    expect(() => validateSourcemap({ name: 'x', className: 'Folder', filePaths: ['a', 2] })).toThrow(RojoError);
  });
  test('unparseable output is rojo_link_invalid', async () => {
    const run: RojoRunner = async () => 'error: could not find project';
    await expect(loadSourcemap('/p/default.project.json', run)).rejects.toMatchObject({ code: 'rojo_link_invalid' });
  });
  test('multi-line stderr is collapsed to single line', async () => {
    const run: RojoRunner = async () => { throw Object.assign(new Error('spawn failed'), { stderr: 'error: bad project\n  --> default.project.json:3\n   ^' }); };
    const error = await loadSourcemap('/p/default.project.json', run).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RojoError);
    expect((error as RojoError).message).not.toMatch(/\n/);
  });
  test('ANSI escape sequences are stripped from the error message', async () => {
    const run: RojoRunner = async () => { throw Object.assign(new Error('spawn failed'), { stderr: '\u001b[31mERROR\u001b[0m: bad project' }); };
    const error = await loadSourcemap('/p/default.project.json', run).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RojoError);
    // eslint-disable-next-line no-control-regex
    expect((error as RojoError).message).not.toMatch(/\u001b/);
    expect((error as RojoError).message).toContain('ERROR: bad project');
  });
  test('a Rokit shim with no rojo in the project manifest is rojo_not_found with a fix', async () => {
    const run: RojoRunner = async () => {
      throw Object.assign(new Error('rojo --version failed'), { stderr: "\u001b[31mERROR\u001b[0m Failed to find tool 'rojo' in any project manifest file." });
    };
    const error = await rojoVersion(run, '/p').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RojoError);
    expect((error as RojoError).code).toBe('rojo_not_found');
    expect((error as RojoError).message).toMatch(/rokit add rojo-rbx\/rojo/);
    expect((error as RojoError).message).toMatch(/rokit add --global rojo-rbx\/rojo/);
  });
});
