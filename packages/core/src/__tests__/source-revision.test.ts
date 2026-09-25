import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

async function loadSourceRevision(): Promise<(source: string) => string> {
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/SourceRevision.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  const commonJsModule = { exports: {} as { sourceRevision: (source: string) => string } };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    Buffer,
    string: {
      byte: (source: string, index: number): [number] => [Buffer.from(source).at(index - 1)!],
      format: (_format: string, value: number): string => value.toString(16).padStart(8, '0'),
    },
    tostring: (value: unknown): string => String(value),
  });
  vm.runInContext(`String.prototype.size = function() { return Buffer.from(String(this)).length; };`, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  return commonJsModule.exports.sourceRevision;
}

describe('sourceRevision', () => {
  test('is deterministic and labels the fingerprint format', async () => {
    const revision = await loadSourceRevision();
    const source = 'print("stable")';

    expect(revision(source)).toBe(revision(source));
    expect(revision(source)).toMatch(/^sr1:\d+:[0-9a-f]{16}$/);
  });

  test('changes for single-character and content changes', async () => {
    const revision = await loadSourceRevision();
    const original = 'local value = 1';

    expect(revision('local value = 2')).not.toBe(revision(original));
    expect(revision('local value = 1 ')).not.toBe(revision(original));
  });

  test('distinguishes empty, multiline, Unicode, and different-length source', async () => {
    const revision = await loadSourceRevision();
    const empty = revision('');
    const multiline = revision('local greeting = "h\u00e9i"\nprint(greeting)\n');
    const unicodeChanged = revision('local greeting = "hei"\nprint(greeting)\n');

    expect(empty).toMatch(/^sr1:0:[0-9a-f]{16}$/);
    expect(multiline).not.toBe(empty);
    expect(multiline).not.toBe(unicodeChanged);
    expect(revision('a')).not.toBe(revision('aa'));
  });
});
