import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';
import { describe, expect, test } from '@jest/globals';
import { sourceRevision } from '../rojo/source-revision.js';

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

const samples = [
  '',
  'print("hi")',
  'local s = "— em dash, ünïcödé, 日本語"\n',
  'line one\r\nline two\r\n',
  'x'.repeat(200_000),
];

describe('the host hash matches the plugin hash', () => {
  test.each(samples.map((sample) => [sample.slice(0, 20), sample]))('%s', async (_label, sample) => {
    const plugin = await loadSourceRevision();
    expect(sourceRevision(sample)).toBe(plugin(sample));
    expect(sourceRevision(Buffer.from(sample, 'utf8'))).toBe(plugin(sample));
  });
});
