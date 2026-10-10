import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { gitIgnored } from '../rojo/ownership.js';
import { captureSourceEnvironment } from '../rojo/client-environment.js';

describe('delegated Git ownership (actual Git and disk)', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer git cwd ')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  test('relative caller PATH still resolves Git when primary cwd differs', async () => {
    const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
    const executable = inheritedPath.split(path.delimiter).map(p => path.join(p, process.platform === 'win32' ? 'git.exe' : 'git'))
      .find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    expect(executable).toBeDefined();
    const caller = path.join(directory, 'caller'); fs.mkdirSync(caller);
    const project = path.join(directory, 'project'); fs.mkdirSync(project);
    execFileSync(executable!, ['-C', project, 'init', '-q'], { windowsHide: true });
    const file = path.join(project, 'Generated.server.luau');
    fs.writeFileSync(path.join(project, '.gitignore'), 'Generated.server.luau\n'); fs.writeFileSync(file, 'generated\n');
    const environment = { PATH: path.relative(caller, path.dirname(executable!)), SystemRoot: process.env.SystemRoot,
      HOME: directory, USERPROFILE: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'no-global-config') };
    const ignored = await gitIgnored(project, [file], environment, caller);
    expect(ignored.has(file)).toBe(true);
  });

  test('an unavailable delegated Git refuses ownership instead of marking generated files writable', async () => {
    const project = path.join(directory, 'project'); fs.mkdirSync(project);
    const file = path.join(project, 'Generated.server.luau'); fs.writeFileSync(file, 'generated\n');
    const emptyPath = path.join(directory, 'no-tools'); fs.mkdirSync(emptyPath);
    await expect(gitIgnored(project, [file], { PATH: emptyPath, SystemRoot: process.env.SystemRoot }, directory))
      .rejects.toThrow('client Git environment');
    expect(fs.readFileSync(file, 'utf8')).toBe('generated\n');
  });

  test('a fatal Git config inside a repository cannot turn ignored output into writable source', async () => {
    execFileSync('git', ['-C', directory, 'init', '-q'], { windowsHide: true });
    const file = path.join(directory, 'Generated.server.luau');
    fs.writeFileSync(path.join(directory, '.gitignore'), 'Generated.server.luau\n'); fs.writeFileSync(file, 'generated\n');
    const invalidConfig = path.join(directory, 'bad-config'); fs.writeFileSync(invalidConfig, '[broken section\n');
    const environment = { ...captureSourceEnvironment(process.env), GIT_CONFIG_GLOBAL: invalidConfig };
    await expect(gitIgnored(directory, [file], environment, directory)).rejects.toThrow('client Git environment');
    expect(fs.readFileSync(file, 'utf8')).toBe('generated\n');
  });

  test('actual Git outside a repository remains supported with valid caller configuration', async () => {
    const file = path.join(directory, 'Main.server.luau'); fs.writeFileSync(file, 'source\n');
    const environment = { ...captureSourceEnvironment(process.env), HOME: directory, USERPROFILE: directory,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'no-global-config') };
    expect(await gitIgnored(directory, [file], environment, directory)).toEqual(new Set());
    fs.writeFileSync(environment.GIT_CONFIG_GLOBAL, '[broken section\n');
    await expect(gitIgnored(directory, [file], environment, directory)).rejects.toThrow('client Git environment');
  });
});
