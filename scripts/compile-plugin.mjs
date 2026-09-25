#!/usr/bin/env node
/**
 * Compiles the Studio plugin with roblox-ts, first installing the plugin's own
 * dependencies when they are missing.
 *
 * studio-plugin/ is a separate npm project rather than a workspace, because
 * scripts/build-plugin.mjs bundles the @rbxts packages from
 * studio-plugin/node_modules, where a workspace would hoist them away. So a
 * root `npm install` does not install the plugin's compiler, and running it
 * without one fails with "'rbxtsc' is not recognized" (or "rbxtsc: not
 * found"). Instead, the first compile runs `npm ci` in studio-plugin, from its
 * own lockfile.
 *
 * This happens at build time on purpose: installing the repository never
 * touches the Studio plugin, so the root package has no install hook.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'studio-plugin');

// npm writes node_modules/.package-lock.json only once an install completes,
// so an interrupted install is not mistaken for a finished one.
const installed = existsSync(join(pluginDir, 'node_modules', '.package-lock.json'))
  && existsSync(join(pluginDir, 'node_modules', 'roblox-ts', 'package.json'));

function npm(args) {
  // The npm running this script, by its own entry point, rather than whatever
  // `npm` a shell resolves (npm.cmd on Windows).
  const npmCli = process.env.npm_execpath;
  const result = npmCli && basename(npmCli).startsWith('npm')
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' })
    : spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(`Could not run npm: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (!installed) {
  console.log("Installing the Studio plugin's build dependencies from studio-plugin/package-lock.json.");
  const status = npm(['--prefix', pluginDir, 'ci', '--no-audit', '--no-fund']);
  if (status !== 0) {
    console.error('Installing them failed; the output above says why. To retry by hand: npm --prefix studio-plugin ci');
    process.exit(status);
  }
}

process.exit(npm(['--prefix', pluginDir, 'run', 'build']));
