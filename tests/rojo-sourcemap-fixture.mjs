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
//
// A Rokit-managed `rojo` with no `rokit.toml` in this script's cwd has
// nothing to run here, since this fixture's temp project is not where the
// Rokit shim looks. Set ROJO_BIN to an absolute path to a rojo executable
// (for example rojo.exe installed globally) to bypass the shim; every rojo
// invocation this script makes honors it.

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

const ROJO_BIN = process.env.ROJO_BIN || 'rojo';
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const ROKIT_SHIM_MESSAGE = /Failed to find tool ['"]rojo['"]/;

/** A RojoRunner (packages/core/src/rojo/sourcemap.ts) that runs ROJO_BIN instead of the bare `rojo` execRojo uses. */
function rojoBinRunner(args, cwd) {
  return execFileAsync(ROJO_BIN, args, {
    cwd, timeout: 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  }).then((result) => result.stdout);
}

/** Checks ROJO_BIN runs at all, and whether a failure is a Rokit shim with no project manifest here. */
async function checkRojo() {
  try {
    await execFileAsync(ROJO_BIN, ['--version'], { timeout: 10_000, windowsHide: true });
    return { ok: true };
  } catch (error) {
    const stderr = String(error?.stderr ?? '').replace(ANSI_PATTERN, '');
    return { ok: false, rokitShim: ROKIT_SHIM_MESSAGE.test(stderr) };
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

/**
 * New scripts saved by build_instances on a linked place (RojoIntegration
 * placeNew/saveNew): every layout Roqer writes is read back by the real
 * `rojo sourcemap` inside saveNew, so a save that succeeds here is one Rojo
 * itself agrees with.
 */
async function checkNewFiles(RojoIntegration) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rojo-new-')));
  try {
    write(root, 'srv/Existing.server.luau', 'print("existing")\n');
    write(root, 'lib/Existing.luau', 'return {}\n');
    write(root, 'out/Keep.luau', 'return {}\n');
    fs.mkdirSync(path.join(root, 'client'));
    write(root, '.gitignore', 'out/\n');
    write(root, 'lib.project.json', JSON.stringify({ name: 'Lib', tree: { $path: 'lib' } }));
    write(root, 'default.project.json', JSON.stringify({
      name: 'RoqerRojoNew',
      globIgnorePaths: ['**/Skipped*'],
      tree: {
        $className: 'DataModel',
        ServerScriptService: { $path: 'srv' },
        StarterPlayer: {
          $className: 'StarterPlayer',
          StarterPlayerScripts: { $className: 'StarterPlayerScripts', $path: 'client' },
        },
        ReplicatedStorage: {
          $className: 'ReplicatedStorage',
          Inline: { $className: 'Folder' },
          Lib: { $path: 'lib.project.json' },
        },
        ServerStorage: { $className: 'ServerStorage', Out: { $path: 'out' } },
      },
    }, null, 2));
    await execFileAsync('git', ['init', '-q'], { cwd: root });

    const rojo = new RojoIntegration(process.env.ROJO_BIN ? { run: rojoBinRunner } : {});
    await rojo.link('fixture:new', path.join(root, 'default.project.json'));
    const link = rojo.linkFor('fixture:new');
    const top = (parentPath, node) => ({ parentPath, parentUnique: true, nameTaken: false, node });
    const script = (name, className, children) => ({ name, className, source: `-- ${name}\n`, ...(className === 'ModuleScript' ? {} : { runContext: 'Legacy' }), ...(children ? { children } : {}) });
    const save = async (label, tops, files) => {
      const placements = await rojo.placeNew(link, tops);
      const kinds = placements.map((placement) => placement.persistence).join(',');
      assert(placements.every((placement) => placement.persistence === 'file'), `${label}: placed as files (got ${kinds}${placements[0]?.reason ? `: ${placements[0].reason}` : ''})`);
      const saved = await rojo.saveNew(link, placements);
      assert(JSON.stringify(saved.map((file) => file.split(path.sep).join('/'))) === JSON.stringify(files), `${label}: Rojo reads back ${files.join(', ')} (got ${saved.join(', ')})`);
    };

    await save('a ModuleScript in a $path folder', [top('game.ServerScriptService', script('Util', 'ModuleScript'))], ['srv/Util.luau']);
    await save('a Folder of a Script with a child module', [top('game.ServerScriptService', {
      name: 'Combat', className: 'Folder', children: [script('Damage', 'Script', [script('Config', 'ModuleScript')])],
    })], ['srv/Combat/Damage/init.server.luau', 'srv/Combat/Damage/Config.luau']);
    await save('a Model of a Script', [top('game.ServerScriptService', { name: 'Npc', className: 'Model', children: [script('Brain', 'Script')] })],
      ['srv/Npc/init.meta.json', 'srv/Npc/Brain.server.luau']);
    await save('a LocalScript in a $className + $path folder', [top('game.StarterPlayer.StarterPlayerScripts', script('Hud', 'LocalScript'))], ['client/Hud.client.luau']);
    await save('a ModuleScript through a nested project file', [top('game.ReplicatedStorage.Lib', script('Extra', 'ModuleScript'))], ['lib/Extra.luau']);

    const inline = await rojo.placeNew(link, [top('game.ReplicatedStorage.Inline', script('Mod', 'ModuleScript'))]);
    assert(inline[0].persistence === 'studio_only', `a node written out in the project file stays Studio-only (got ${inline[0].persistence})`);
    const generated = await rojo.placeNew(link, [top('game.ServerStorage.Out', script('Gen', 'ModuleScript'))]);
    assert(generated[0].persistence === 'generated', `a gitignored folder is build output (got ${generated[0].persistence}: ${generated[0].reason})`);
    const taken = await rojo.placeNew(link, [top('game.ServerScriptService', script('Util', 'ModuleScript'))]);
    assert(taken[0].persistence === 'unsupported', `a name the project already has is refused (got ${taken[0].persistence})`);

    const ignored = await rojo.placeNew(link, [top('game.ServerScriptService', script('SkippedThing', 'ModuleScript'))]);
    let refusal;
    try {
      await rojo.saveNew(link, ignored);
    } catch (error) {
      refusal = error;
    }
    assert(refusal?.code === 'rojo_unsupported' && !fs.existsSync(path.join(root, 'srv', 'SkippedThing.luau')),
      `a file the project's globIgnorePaths hides is taken back out (got ${refusal?.code}: ${refusal?.message})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const check = await checkRojo();
  if (!check.ok) {
    if (!process.env.ROJO_BIN && check.rokitShim) {
      console.log('SKIP: rojo is a Rokit shim with no rokit.toml here; set ROJO_BIN to rojo.exe or install it globally with rokit add --global rojo-rbx/rojo');
    } else {
      console.log('SKIP: rojo not on PATH');
    }
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
    const rojo = new RojoIntegration(process.env.ROJO_BIN ? { run: rojoBinRunner } : {});
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

    await checkNewFiles(RojoIntegration);

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
