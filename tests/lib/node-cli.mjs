import { statSync } from 'node:fs';
import path from 'node:path';

// Share the Windows npm/npx shim bypass with the packaging and live runners.
export function resolveWindowsNodeCli(command, platform, childEnv, execPath = process.execPath) {
  if (platform !== 'win32') return undefined;
  const executable = path.win32.basename(command).toLowerCase().replace(/\.cmd$/, '');
  if (executable !== 'npm' && executable !== 'npx') return undefined;

  const cliName = `${executable}-cli.js`;
  const executableDir = path.dirname(execPath);
  const candidates = [
    childEnv.npm_execpath && path.join(path.dirname(childEnv.npm_execpath), cliName),
    path.join(executableDir, 'node_modules', 'npm', 'bin', cliName),
    path.resolve(executableDir, '..', 'lib', 'node_modules', 'npm', 'bin', cliName),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { return statSync(candidate).isFile(); }
    catch { return false; }
  });
}
