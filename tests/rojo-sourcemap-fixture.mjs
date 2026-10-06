#!/usr/bin/env node
// Checks RojoIntegration's ownership classification (packages/core/src/rojo/)
// against a real `rojo sourcemap`, not the mocked RojoRunner the unit tests
// use. Builds a temp Rojo project covering every design-doc §6 case: a plain
// script, an init-folder script, a $path rename, a nested project file, a
// Wally-style _Index package, and a gitignored build output.
//
// No Studio is involved. Skips (exit 0) when rojo is not on PATH, so this is
// safe to run anywhere. Run via `npm run test:rojo`, which builds
// packages/core first so packages/core/dist/rojo/index.js exists.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_ROJO_INDEX = path.join(REPO_ROOT, 'packages', 'core', 'dist', 'rojo', 'index.js');

async function rojoOnPath() {
  try {
    await execFileAsync('rojo', ['--version'], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function write(root, relativePath, contents) {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function buildFixtureProject(root) {
  // A plain script.
  write(root, 'src/server/Main.server.luau', 'print("main")\n');
  // init.luau: the Combat folder itself becomes the ModuleScript.
  write(root, 'src/server/Combat/init.luau', 'return {}\n');
  // The file a $path rename points at; the instance name ("Renamed") differs
  // from the file name.
  write(root, 'src/shared/actual_file.luau', 'return {}\n');
  // Walked through a nested project file, exactly like any other node.
  write(root, 'src/shared/SharedUtil.luau', 'return {}\n');
  write(root, 'shared.project.json', JSON.stringify({
    name: 'RoqerRojoFixtureShared',
    tree: {
      $className: 'Folder',
      SharedUtil: { $path: 'src/shared/SharedUtil.luau' },
    },
  }, null, 2));
  // A Wally-style package under _Index: generated.
  write(root, 'Packages/_Index/a_b@1.0.0/b/init.lua', 'return {}\n');
  // A build output excluded via .gitignore: generated.
  write(root, 'out/Built.luau', '-- compiled\n');
  write(root, '.gitignore', 'out/\n');

  write(root, 'default.project.json', JSON.stringify({
    name: 'RoqerRojoFixture',
    tree: {
      $className: 'DataModel',
      ServerScriptService: {
        Main: { $path: 'src/server/Main.server.luau' },
        Combat: { $path: 'src/server/Combat' },
        Renamed: { $path: 'src/shared/actual_file.luau' },
        Built: { $path: 'out/Built.luau' },
      },
      ReplicatedStorage: {
        Shared: { $path: 'shared.project.json' },
        Packages: { $path: 'Packages' },
      },
    },
  }, null, 2));
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function main() {
  if (!(await rojoOnPath())) {
    console.log('SKIP: rojo not on PATH');
    process.exit(0);
    return;
  }
  if (!fs.existsSync(CORE_ROJO_INDEX)) {
    console.error(`${CORE_ROJO_INDEX} is missing; run "npm run build" first.`);
    process.exit(1);
    return;
  }

  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rojo-fixture-')));
  let failed = false;
  try {
    buildFixtureProject(root);
    await execFileAsync('git', ['init', '-q'], { cwd: root });

    const { RojoIntegration } = await import(pathToFileURL(CORE_ROJO_INDEX).href);
    const rojo = new RojoIntegration();
    const instanceId = 'fixture:1';
    const summary = await rojo.link(instanceId, path.join(root, 'default.project.json'));
    console.log(`  rojo ${summary.rojoVersion}, scripts: ${JSON.stringify(summary.scripts)}`);

    assert(
      summary.scripts.file === 4 && summary.scripts.studio_only === 0
        && summary.scripts.generated === 2 && summary.scripts.unsupported === 0,
      `link() counts every script exactly once (got ${JSON.stringify(summary.scripts)})`,
    );

    const link = rojo.linkFor(instanceId);
    assert(link !== undefined, 'the link is kept in memory under its instance id');

    const cases = [
      { label: 'a plain script', segments: ['ServerScriptService', 'Main'], className: 'Script', expect: 'file' },
      { label: 'an init.luau folder script', segments: ['ServerScriptService', 'Combat'], className: 'ModuleScript', expect: 'file' },
      { label: 'a $path rename', segments: ['ServerScriptService', 'Renamed'], className: 'ModuleScript', expect: 'file' },
      { label: 'a script reached through a nested project file', segments: ['ReplicatedStorage', 'Shared', 'SharedUtil'], className: 'ModuleScript', expect: 'file' },
      { label: 'a Wally package under _Index', segments: ['ReplicatedStorage', 'Packages', '_Index', 'a_b@1.0.0', 'b'], className: 'ModuleScript', expect: 'generated' },
      { label: 'a gitignored build output', segments: ['ServerScriptService', 'Built'], className: 'ModuleScript', expect: 'generated' },
    ];
    for (const testCase of cases) {
      const owner = await rojo.resolve(link, testCase.segments, testCase.className, true, { fresh: true });
      assert(
        owner.persistence === testCase.expect,
        `${testCase.label} resolves to ${testCase.expect} (got ${owner.persistence}${owner.reason ? `: ${owner.reason}` : ''})`,
      );
    }

    console.log('\n✅ rojo-sourcemap-fixture PASSED');
  } catch (error) {
    failed = true;
    console.error(`\n❌ rojo-sourcemap-fixture FAILED: ${error.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

await main();
