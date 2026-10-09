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

/** A real .rbxm of one instance of `className` named `name`, built by Rojo itself from a model project. */
async function rbxmOf(className, children = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rojo-rbxm-'));
  try {
    write(dir, 'model.project.json', JSON.stringify({ name: 'Model', tree: { $className: className, ...children } }));
    await execFileAsync(ROJO_BIN, ['build', 'model.project.json', '-o', 'out.rbxm'], { cwd: dir, timeout: 20_000, windowsHide: true });
    return fs.readFileSync(path.join(dir, 'out.rbxm')).toString('base64');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Structural changes on a linked place (RojoIntegration planStructure and
 * applyStructure): new scripts and models, removals, renames and moves. Every
 * change is read back by the real `rojo sourcemap` inside applyStructure, so
 * one that succeeds here is one Rojo itself agrees with, and one Rojo reads
 * differently is undone.
 */
async function checkStructure(RojoIntegration) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rojo-new-')));
  const { sourceRevision } = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'dist', 'rojo', 'source-revision.js')).href);
  const backups = [];
  try {
    write(root, 'srv/Existing.server.luau', 'print("existing")\n');
    write(root, 'lib/Existing.luau', 'return {}\n');
    write(root, 'out/Keep.luau', 'return {}\n');
    fs.mkdirSync(path.join(root, 'client'));
    write(root, '.gitignore', 'out/\n');
    write(root, 'lib.project.json', JSON.stringify({ name: 'Lib', tree: { $path: 'lib' } }));
    // A nested project with its own emitLegacyScripts, which Rojo applies to its subtree only.
    write(root, 'modern/Keep.luau', 'return {}\n');
    write(root, 'modern.project.json', JSON.stringify({ name: 'Modern', emitLegacyScripts: false, tree: { $path: 'modern' } }));
    // A folder holding default.project.json is that project to Rojo, not a plain folder.
    write(root, 'pkg/src/Keep.luau', 'return {}\n');
    write(root, 'pkg/default.project.json', JSON.stringify({ name: 'Pkg', tree: { $path: 'src' } }));
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
          Modern: { $path: 'modern.project.json' },
        },
        ServerStorage: { $className: 'ServerStorage', Out: { $path: 'out' }, Pkg: { $path: 'pkg' } },
      },
    }, null, 2));
    await execFileAsync('git', ['init', '-q'], { cwd: root });

    const rojo = new RojoIntegration(process.env.ROJO_BIN ? { run: rojoBinRunner } : {});
    await rojo.link('fixture:new', path.join(root, 'default.project.json'));
    const link = rojo.linkFor('fixture:new');
    const top = (parentPath, node) => ({ parentPath, parentUnique: true, nameTaken: false, node });
    const script = (name, className, children) => ({ name, className, source: `-- ${name}\n`, ...(className === 'ModuleScript' ? {} : { runContext: 'Legacy' }), ...(children ? { children } : {}) });
    const revisionOf = (file) => sourceRevision(fs.readFileSync(path.join(root, file), 'utf8'));
    const live = (fields) => ({ uniquePath: true, descendants: 0, scripts: [], properties: [], ...fields });
    const unixy = (file) => file.split(path.sep).join('/');
    const sorted = (files) => [...files].map((file) => unixy(path.relative(root, file))).sort();
    const save = async (label, tops, lives, expect) => {
      const disposition = await rojo.planStructure(link, tops, lives);
      assert(disposition.kind === 'files' && !disposition.needsSerialize, `${label}: planned as files (got ${disposition.kind}${disposition.error ? `: ${disposition.error}` : ''})`);
      const backup = await rojo.applyStructure(link, disposition.change);
      if (backup) backups.push(backup);
      const got = {
        created: sorted(disposition.change.created),
        removed: sorted(disposition.change.removed),
        renamed: disposition.change.renamed.map((rename) => `${unixy(path.relative(root, rename.from))}>${unixy(path.relative(root, rename.to))}`).sort(),
      };
      const wanted = { created: [...(expect.created ?? [])].sort(), removed: [...(expect.removed ?? [])].sort(), renamed: [...(expect.renamed ?? [])].sort() };
      assert(JSON.stringify(got) === JSON.stringify(wanted), `${label}: Rojo reads it back as planned (${JSON.stringify(got)})`);
      return backup;
    };
    const refused = async (label, tops, lives, kind = 'refuse') => {
      const disposition = await rojo.planStructure(link, tops, lives);
      assert(disposition.kind === kind, `${label} (got ${disposition.kind}${disposition.error ? `: ${disposition.error}` : ''})`);
      return disposition;
    };

    // New scripts.
    await save('a ModuleScript in a $path folder', [top('game.ServerScriptService', script('Util', 'ModuleScript'))], [], { created: ['srv/Util.luau'] });
    await save('a Folder of a Script with a child module', [top('game.ServerScriptService', {
      name: 'Combat', className: 'Folder', children: [script('Damage', 'Script', [script('Config', 'ModuleScript')])],
    })], [], { created: ['srv/Combat/Damage/init.server.luau', 'srv/Combat/Damage/Config.luau'] });
    await save('a Model of a Script', [top('game.ServerScriptService', { name: 'Npc', className: 'Model', children: [script('Brain', 'Script')] })], [],
      { created: ['srv/Npc/Brain.server.luau'] });
    assert(fs.existsSync(path.join(root, 'srv/Npc/init.meta.json')), 'the Model of a Script is a folder whose init.meta.json names its class');
    await save('a LocalScript in a $className + $path folder', [top('game.StarterPlayer.StarterPlayerScripts', script('Hud', 'LocalScript'))], [], { created: ['client/Hud.client.luau'] });
    await save('a ModuleScript through a nested project file', [top('game.ReplicatedStorage.Lib', script('Extra', 'ModuleScript'))], [], { created: ['lib/Extra.luau'] });
    // Rojo makes .client a Script here, which the read-back checks; a LocalScript would come back wrong.
    await save('a client Script under a nested project with emitLegacyScripts false',
      [top('game.ReplicatedStorage.Modern', { ...script('Ui', 'Script'), runContext: 'Client' })], [], { created: ['modern/Ui.client.luau'] });
    await refused('a LocalScript under that nested project is refused', [top('game.ReplicatedStorage.Modern', script('Hud', 'LocalScript'))], []);
    await save('a ModuleScript in a folder that holds its own default.project.json', [top('game.ServerStorage.Pkg', script('Extra', 'ModuleScript'))], [], { created: ['pkg/src/Extra.luau'] });
    await refused('a node written out in the project file stays Studio-only', [top('game.ReplicatedStorage.Inline', script('Mod', 'ModuleScript'))], [], 'studio');
    const generated = await refused('a gitignored folder is build output', [top('game.ServerStorage.Out', script('Gen', 'ModuleScript'))], []);
    assert(generated.code === 'rojo_generated', `...refused as rojo_generated (got ${generated.code})`);
    await refused('a name the project already has is refused', [top('game.ServerScriptService', script('Util', 'ModuleScript'))], []);

    // New models, as real .rbxm files Rojo itself wrote.
    await save('a script-free Model as one .rbxm', [top('game.ServerScriptService', {
      name: 'Tree', className: 'Model', rbxm: await rbxmOf('Model', { Trunk: { $className: 'Part' } }), children: [{ name: 'Trunk', className: 'Part' }],
    })], [], { created: ['srv/Tree.rbxm'] });
    await save('a Tool of a LocalScript and a Part: a folder of a script file and a model file', [top('game.ServerScriptService', {
      name: 'Gun', className: 'Tool', children: [{ name: 'Handle', className: 'Part', rbxm: await rbxmOf('Part') }, script('Fire', 'LocalScript')],
    })], [], { created: ['srv/Gun/Fire.client.luau', 'srv/Gun/Handle.rbxm'] });

    // Removals.
    const backup = await save('removing a script deletes its file', [], [
      live({ op: 'remove', path: 'game.ServerScriptService.Util', className: 'ModuleScript', scripts: [{ path: 'game.ServerScriptService.Util', revision: revisionOf('srv/Util.luau') }] }),
    ], { removed: ['srv/Util.luau'] });
    assert(fs.readFileSync(path.join(backup, 'srv', 'Util.luau'), 'utf8') === '-- Util\n', 'the removed file is kept in the backup folder');
    await save('removing a folder of scripts deletes the folder', [], [
      live({
        op: 'remove', path: 'game.ServerScriptService.Combat', className: 'Folder', descendants: 2, scripts: [
          { path: 'game.ServerScriptService.Combat.Damage', revision: revisionOf('srv/Combat/Damage/init.server.luau') },
          { path: 'game.ServerScriptService.Combat.Damage.Config', revision: revisionOf('srv/Combat/Damage/Config.luau') },
        ],
      }),
    ], { removed: ['srv/Combat'] });
    await save('removing a model file deletes it', [], [live({ op: 'remove', path: 'game.ServerScriptService.Tree', className: 'Model', descendants: 1 })], { removed: ['srv/Tree.rbxm'] });
    const conflict = await refused('a removal Studio holds different source for is a conflict', [], [
      live({ op: 'remove', path: 'game.ServerScriptService.Existing', className: 'Script', scripts: [{ path: 'game.ServerScriptService.Existing', revision: 'sr1:0:0000000000000000' }] }),
    ]);
    assert(conflict.code === 'rojo_conflict', `...refused as rojo_conflict (got ${conflict.code})`);

    // Renames and moves.
    write(root, 'srv/Meta.server.luau', '-- Meta\n');
    write(root, 'srv/Meta.meta.json', JSON.stringify({ properties: { Disabled: true } }));
    await save('renaming a script renames its file and meta file', [], [
      live({ op: 'set', path: 'game.ServerScriptService.Meta', className: 'Script', name: 'Renamed', scripts: [{ path: 'game.ServerScriptService.Meta', revision: revisionOf('srv/Meta.server.luau') }] }),
    ], { renamed: ['srv/Meta.server.luau>srv/Renamed.server.luau', 'srv/Meta.meta.json>srv/Renamed.meta.json'] });
    await save('renaming a folder-backed Model renames its folder', [], [
      live({ op: 'set', path: 'game.ServerScriptService.Npc', className: 'Model', name: 'Bot', descendants: 1, scripts: [{ path: 'game.ServerScriptService.Npc.Brain', revision: revisionOf('srv/Npc/Brain.server.luau') }] }),
    ], { renamed: ['srv/Npc>srv/Bot'] });
    await save('moving a module into a nested project folder moves its file', [], [
      live({ op: 'set', path: 'game.ReplicatedStorage.Lib.Extra', className: 'ModuleScript', parent: 'game.ServerScriptService', parentUnique: true, scripts: [{ path: 'game.ReplicatedStorage.Lib.Extra', revision: revisionOf('lib/Extra.luau') }] }),
    ], { renamed: ['lib/Extra.luau>srv/Extra.luau'] });
    // A LocalScript moved under emitLegacyScripts false would come back a Script: Rojo's read-back catches it and it is moved back.
    const plan = await rojo.planStructure(link, [], [
      live({ op: 'set', path: 'game.StarterPlayer.StarterPlayerScripts.Hud', className: 'LocalScript', parent: 'game.ReplicatedStorage.Modern', parentUnique: true, scripts: [{ path: 'game.StarterPlayer.StarterPlayerScripts.Hud', revision: revisionOf('client/Hud.client.luau') }] }),
    ]);
    let undone;
    try {
      await rojo.applyStructure(link, plan.change);
    } catch (error) {
      undone = error;
    }
    assert(undone?.code === 'rojo_unsupported' && fs.existsSync(path.join(root, 'client', 'Hud.client.luau')) && !fs.existsSync(path.join(root, 'modern', 'Hud.client.luau')),
      `a move Rojo reads as another class is moved back (got ${undone?.code}: ${undone?.message})`);

    const ignored = await rojo.planStructure(link, [top('game.ServerScriptService', script('SkippedThing', 'ModuleScript'))], []);
    let refusal;
    try {
      await rojo.applyStructure(link, ignored.change);
    } catch (error) {
      refusal = error;
    }
    assert(refusal?.code === 'rojo_unsupported' && !fs.existsSync(path.join(root, 'srv', 'SkippedThing.luau')),
      `a file the project's globIgnorePaths hides is taken back out (got ${refusal?.code}: ${refusal?.message})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    for (const backup of backups) fs.rmSync(backup, { recursive: true, force: true });
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

    await checkStructure(RojoIntegration);

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
