import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  getPluginsFolder,
  installPluginAsset,
} from '@roqer/mcp-core';

const ASSET_NAME = 'MCPInspectorPlugin.rbxmx';
const OTHER_VARIANT = 'MCPPlugin.rbxmx';

interface InstallOptions {
  sourcePath?: string;
  replaceVariant?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function bundledAssetPath(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(currentDir, '..', 'studio-plugin', ASSET_NAME),
    join(currentDir, '..', '..', '..', 'studio-plugin', ASSET_NAME),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolvePluginAssetPath(sourcePath: string | undefined): string | null {
  if (sourcePath === undefined) return bundledAssetPath();
  return existsSync(sourcePath) ? sourcePath : null;
}

function packageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(currentDir, '..', 'package.json'), 'utf8')) as { version?: string };
  if (!pkg.version) {
    throw new Error('Package version not found');
  }
  return pkg.version;
}

export async function installBundledPlugin(options: InstallOptions = {}): Promise<void> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const replaceVariant = options.replaceVariant ?? true;
  const sourcePath = resolvePluginAssetPath(options.sourcePath);
  if (!sourcePath) {
    throw new Error(
      `Bundled ${ASSET_NAME} not found. Run npm run build:plugin:inspector in this worktree first.`,
    );
  }

  const result = await installPluginAsset({
    pluginsFolder: getPluginsFolder(),
    assetName: ASSET_NAME,
    otherAssetName: OTHER_VARIANT,
    source: readFileSync(sourcePath),
    expectedVersion: packageVersion(),
    expectedVariant: 'inspector',
    replaceVariant,
    log,
    warn,
  });
  if (result.installed) {
    log(`Installed ${ASSET_NAME} to ${result.destination}`);
  }
}
