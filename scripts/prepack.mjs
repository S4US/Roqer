#!/usr/bin/env node

/**
 * Stages the package-specific built Studio plugin, and the licence files every
 * published copy has to carry, before npm pack/publish.
 * Run from a publishable package directory via its "prepack" script.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'fs';
import { join } from 'path';

const PLUGIN_ASSET_BY_PACKAGE = {
  '@roqer/mcp': 'MCPPlugin.rbxmx',
  '@roqer/mcp-inspector': 'MCPInspectorPlugin.rbxmx',
};

/**
 * Copied from the repository root into the package. npm always packs a LICENSE
 * found there; the other two are listed in the package's "files". NOTICE.md
 * holds the additional permission for LibMP, which the built plugin bundles,
 * and THIRD_PARTY_NOTICES.md the MIT notices of the code Roqer builds on.
 */
const LICENSE_FILES = ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'];

const packageDir = process.cwd();
const rootDir = join(packageDir, '..', '..');
const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const assetName = PLUGIN_ASSET_BY_PACKAGE[packageJson.name];

if (!assetName) {
  console.error(`No Studio plugin artifact is configured for package ${packageJson.name ?? '<unknown>'}`);
  process.exit(1);
}

const source = join(rootDir, 'studio-plugin', assetName);
const dest = join(packageDir, 'studio-plugin');

if (!existsSync(source)) {
  console.error(`Built Studio plugin not found at ${source}. Run npm run build:plugins first.`);
  process.exit(1);
}

const missingLicenseFiles = LICENSE_FILES.filter((name) => !existsSync(join(rootDir, name)));
if (missingLicenseFiles.length > 0) {
  console.error(
    `${missingLicenseFiles.join(', ')} not found in ${rootDir}. `
    + 'A package is never published without its licence files.',
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
copyFileSync(source, join(dest, assetName));
console.log(`Staged studio-plugin/${assetName} for ${packageJson.name}`);

for (const name of LICENSE_FILES) {
  copyFileSync(join(rootDir, name), join(packageDir, name));
}
console.log(`Staged ${LICENSE_FILES.join(', ')} for ${packageJson.name}`);
