#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWindowsNodeCli } from './lib/node-cli.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prepackScript = path.join(repoRoot, 'scripts', 'prepack.mjs');
const packages = [
  {
    directory: 'robloxstudio-mcp',
    name: '@roqer/mcp',
    asset: 'MCPPlugin.rbxmx',
  },
  {
    directory: 'robloxstudio-mcp-inspector',
    name: '@roqer/mcp-inspector',
    asset: 'MCPInspectorPlugin.rbxmx',
  },
];

// What each published package lists in "files"; npm adds LICENSE on its own.
const packageFiles = (asset) => ['dist/**/*', `studio-plugin/${asset}`, 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'];
const licenseFiles = {
  LICENSE: 'licence-text',
  'NOTICE.md': 'notice-text',
  'THIRD_PARTY_NOTICES.md': 'third-party-notices-text',
};

const npmCli = resolveWindowsNodeCli('npm', process.platform, process.env);
assert.ok(process.platform !== 'win32' || npmCli,
  'Cannot find npm-cli.js. Run npm run test:package-contents with an installed npm.');

// Exercise cwd handling without allowing these characters to become shell syntax.
// npm 10 cannot pack a cwd containing a bare percent sign (URI malformed).
// The launcher regression exercises percent signs separately from npm itself.
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'roqer prepack 中文 & !-'));
const fixtureScriptsDir = path.join(fixtureRoot, 'scripts');

try {
  mkdirSync(fixtureScriptsDir, { recursive: true });
  copyFileSync(prepackScript, path.join(fixtureScriptsDir, 'prepack.mjs'));
  const sourcePluginDir = path.join(fixtureRoot, 'studio-plugin');
  mkdirSync(path.join(sourcePluginDir, 'src'), { recursive: true });
  mkdirSync(path.join(sourcePluginDir, 'include'), { recursive: true });
  writeFileSync(path.join(sourcePluginDir, 'MCPPlugin.rbxmx'), 'main-built-plugin');
  writeFileSync(path.join(sourcePluginDir, 'MCPInspectorPlugin.rbxmx'), 'inspector-built-plugin');
  writeFileSync(path.join(sourcePluginDir, 'src', 'source.ts'), 'source-only');
  writeFileSync(path.join(sourcePluginDir, 'include', 'LibMP.lua'), 'large-runtime-source');
  for (const [name, content] of Object.entries(licenseFiles)) {
    writeFileSync(path.join(fixtureRoot, name), content);
  }

  for (const packageDefinition of packages) {
    const packageDir = path.join(fixtureRoot, 'packages', packageDefinition.directory);
    const destination = path.join(packageDir, 'studio-plugin');
    mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(packageDir, 'dist', 'index.js'), 'runtime-server');
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageDefinition.name,
        version: '1.0.0',
        files: packageFiles(packageDefinition.asset),
        scripts: { prepack: 'node ../../scripts/prepack.mjs' },
      }),
    );
    writeFileSync(path.join(destination, 'stale-source.ts'), 'left by an interrupted pack');

    const result = spawnSync(
      npmCli ? process.execPath : 'npm',
      [...(npmCli ? [npmCli] : []), 'pack', '--dry-run', '--json', '--silent',
        '--cache', path.join(fixtureRoot, 'npm-cache')],
      {
        cwd: packageDir,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `${packageDefinition.name} npm pack succeeds: ${result.stderr || result.stdout}`,
    );
    const reportJson = result.stdout.match(/^\[[\s\S]*$/m)?.[0];
    assert.ok(reportJson, `npm pack returned a JSON report: ${result.stdout}`);
    const [packReport] = JSON.parse(reportJson);
    assert.deepEqual(
      packReport.files.map((file) => file.path).sort(),
      [
        ...Object.keys(licenseFiles),
        'dist/index.js',
        'package.json',
        `studio-plugin/${packageDefinition.asset}`,
      ].sort(),
      `${packageDefinition.name} tarball contains only runtime and licence files`,
    );
    for (const [name, content] of Object.entries(licenseFiles)) {
      assert.equal(
        readFileSync(path.join(packageDir, name), 'utf8'),
        content,
        `${packageDefinition.name} stages the repository's ${name}`,
      );
    }
    assert.deepEqual(
      readdirSync(destination),
      [packageDefinition.asset],
      `${packageDefinition.name} stages only its runtime plugin asset`,
    );
    assert.equal(
      readFileSync(path.join(destination, packageDefinition.asset), 'utf8'),
      packageDefinition.asset === 'MCPPlugin.rbxmx'
        ? 'main-built-plugin'
        : 'inspector-built-plugin',
    );

    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'packages', packageDefinition.directory, 'package.json'), 'utf8'),
    );
    assert.deepEqual(
      manifest.files,
      packageFiles(packageDefinition.asset),
      `${packageDefinition.name} publishes only dist, its runtime plugin asset and the licence notices`,
    );
  }

  const missingPackageDir = path.join(fixtureRoot, 'packages', packages[0].directory);
  rmSync(path.join(sourcePluginDir, packages[0].asset));
  const missingResult = spawnSync(
    process.execPath,
    [path.join(fixtureScriptsDir, 'prepack.mjs')],
    { cwd: missingPackageDir, encoding: 'utf8' },
  );
  assert.notEqual(missingResult.status, 0, 'prepack fails when its built plugin is missing');
  assert.match(
    missingResult.stderr + missingResult.stdout,
    /Run npm run build:plugins first/,
    'prepack explains how to produce a missing plugin build',
  );

  writeFileSync(path.join(sourcePluginDir, packages[0].asset), 'main-built-plugin');
  rmSync(path.join(fixtureRoot, 'NOTICE.md'));
  const unlicensedResult = spawnSync(
    process.execPath,
    [path.join(fixtureScriptsDir, 'prepack.mjs')],
    { cwd: missingPackageDir, encoding: 'utf8' },
  );
  assert.notEqual(unlicensedResult.status, 0, 'prepack fails when a licence file is missing');
  assert.match(
    unlicensedResult.stderr + unlicensedResult.stdout,
    /NOTICE\.md not found[\s\S]*never published without its licence files/,
    'prepack names the missing licence file',
  );

  console.log('prepack package contents passed');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
