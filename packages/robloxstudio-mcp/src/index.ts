import { RobloxStudioMCPServer, getAllTools } from '@roqer/mcp-core';
import { createRequire } from 'module';
import { installBundledPlugin } from './install-plugin.js';

const flagValue = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
};

// `--install-plugin` once fell back to downloading a plugin from the project
// this bridge was forked from. It installs the plugin that ships with it now,
// the same as `--install-bundled-plugin`, and is kept so existing commands work.
const installOnly = process.argv.includes('--install-bundled-plugin') || process.argv.includes('--install-plugin');

/**
 * Markers the desktop app reads off this process's stderr.
 *
 * Output is the only channel a spawned bridge has back to Roqer, so the two
 * outcomes it has to act on — the plugin changed, and the install did not
 * happen — are stated in a fixed form rather than left to prose that someone
 * will reword. See STUDIO_RESTART_MARKER and PLUGIN_PROBLEM_MARKER in
 * apps/desktop/runtime/mcp-server-process.ts; keep the two files in step.
 */
const STUDIO_RESTART_MARKER = '[install-plugin] studio-restart-required';
const PLUGIN_PROBLEM_MARKER = '[install-plugin] plugin-install-failed:';

const describeInstallError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

if (installOnly) {
  await installBundledPlugin({ sourcePath: flagValue('--plugin-path') }).then((result) => {
    if (result.installed) console.error(STUDIO_RESTART_MARKER);
  }).catch((err) => {
    console.error(`${PLUGIN_PROBLEM_MARKER} ${describeInstallError(err)}`);
    console.error(describeInstallError(err));
    process.exitCode = 1;
  });
} else {
  if (process.argv.includes('--auto-install-plugin')) {
    await installBundledPlugin({
      sourcePath: flagValue('--plugin-path'),
      log: (message) => console.error(`[install-plugin] ${message}`),
      warn: (message) => console.error(message),
    }).then((result) => {
      // A Studio session that was already open is still running the plugin it
      // loaded at startup, so replacing the file is not enough on its own:
      // Roqer reads this line and asks the customer to restart Studio.
      if (result.installed) console.error(STUDIO_RESTART_MARKER);
    }).catch((err) => {
      // A skipped install used to be a line in a log nobody reads, which made
      // "Studio never connects" the only symptom of a plugin that was never
      // put in place. Roqer surfaces this one.
      console.error(`${PLUGIN_PROBLEM_MARKER} ${describeInstallError(err)}`);
      console.error(`[install-plugin] Auto-install skipped: ${describeInstallError(err)}`);
    });
  }

  const creatorId = flagValue('--creator-id');
  const creatorGroupId = flagValue('--creator-group-id');

  if (creatorId) process.env.ROBLOX_CREATOR_USER_ID = creatorId;
  if (creatorGroupId) process.env.ROBLOX_CREATOR_GROUP_ID = creatorGroupId;

  const require = createRequire(import.meta.url);
  const { version: VERSION } = require('../package.json');

  const server = new RobloxStudioMCPServer({
    name: 'robloxstudio-mcp',
    version: VERSION,
    tools: getAllTools(),
    pluginVariant: 'main',
  });

  server.run().catch((error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}
