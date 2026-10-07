/** Owned subprocess for the temporary-project write lease check. No Studio or network connection. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RojoScriptProject } from '../../packages/core/dist/rojo-project.js';

const [projectFile, backupDirectory, expectedRevision, hold, source] = process.argv.slice(2);
const instancePath = 'game.ServerScriptService.Main';
const before = await readFile(path.join(path.dirname(projectFile), 'src/server/Main.server.luau'), 'utf8');
const project = new RojoScriptProject({ projectFile, instanceId: 'fixture', backupDirectory, executable: process.env.ROBLOX_STUDIO_ROJO_EXECUTABLE || 'rojo' });
const peer = async (endpoint) => {
  if (endpoint === '/api/get-script-source') return { instancePath, instanceRef: instancePath, className: 'Script', revision: 'studio', source: before };
  if (endpoint !== '/api/check-script-source') throw new Error(`Unexpected endpoint ${endpoint}`);
  if (hold === 'hold') {
    process.send({ type: 'checking' });
    await new Promise((resolve) => process.once('message', resolve));
  }
  return { instancePath, instanceRef: instancePath };
};
const result = await project.handle('/api/set-script-source', { instancePath, source, expectedRevision }, 'edit', peer);
process.send({ type: 'result', result }, () => process.exit(0));
