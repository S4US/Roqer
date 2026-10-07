import { execFile } from 'child_process';
import * as path from 'path';

export interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

export type RojoErrorCode =
  | 'rojo_not_found'
  | 'rojo_link_invalid'
  | 'rojo_conflict'
  | 'rojo_generated'
  | 'rojo_unsupported'
  | 'rojo_bulk_edit_refused';

export class RojoError extends Error {
  constructor(readonly code: RojoErrorCode, message: string) {
    super(message);
    this.name = 'RojoError';
  }
}

/** Runs rojo with args in cwd and resolves its stdout. */
export type RojoRunner = (args: string[], cwd: string) => Promise<string>;

const MINIMUM_VERSION = [7, 3, 0] as const;

function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
}

export const execRojo: RojoRunner = (args, cwd) => new Promise((resolve, reject) => {
  // No shell, so a project path is never parsed as a command line.
  execFile('rojo', args, { cwd, timeout: 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr: String(stderr) }));
    else resolve(String(stdout));
  });
});

const ROKIT_SHIM_MESSAGE = /Failed to find tool ['"]rojo['"]/;

function rethrow(error: unknown, doing: string): never {
  if (error instanceof RojoError) throw error;
  if ((error as { code?: unknown }).code === 'ENOENT') {
    throw new RojoError('rojo_not_found', 'rojo was not found on PATH; install Rojo 7.3 or newer (for example with rokit) and restart the server.');
  }
  const stderr = oneLine(String((error as { stderr?: unknown }).stderr ?? ''));
  const combined = stderr || oneLine(String((error as Error).message));
  if (ROKIT_SHIM_MESSAGE.test(combined)) {
    throw new RojoError('rojo_not_found', "rojo is installed through Rokit but this project does not list it; run `rokit add rojo-rbx/rojo` in the project folder (or install it globally with `rokit add --global rojo-rbx/rojo`).");
  }
  throw new RojoError('rojo_link_invalid', `rojo ${doing} failed: ${combined.slice(0, 300)}`);
}

export async function rojoVersion(run: RojoRunner, cwd: string): Promise<string> {
  let output: string;
  try {
    output = await run(['--version'], cwd);
  } catch (error) {
    rethrow(error, '--version');
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) throw new RojoError('rojo_link_invalid', `Could not read the Rojo version from: ${oneLine(output).slice(0, 120)}`);
  const parts = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] > MINIMUM_VERSION[index]) break;
    if (parts[index] < MINIMUM_VERSION[index]) {
      throw new RojoError('rojo_link_invalid', `Rojo ${match[0]} is too old; Roqer needs Rojo ${MINIMUM_VERSION.join('.')} or newer.`);
    }
  }
  return match[0];
}

export function validateSourcemap(value: unknown): SourcemapNode {
  const fail = (why: string): never => { throw new RojoError('rojo_link_invalid', `rojo sourcemap returned an unexpected tree: ${why}`); };
  const check = (node: unknown, where: string): SourcemapNode => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail(`${where} is not an object`);
    const record = node as Record<string, unknown>;
    if (typeof record.name !== 'string') fail(`${where} has no name`);
    if (typeof record.className !== 'string') fail(`${where} has no className`);
    if (record.filePaths !== undefined && (!Array.isArray(record.filePaths) || record.filePaths.some((entry) => typeof entry !== 'string'))) {
      fail(`${where}.filePaths is not a list of paths`);
    }
    if (record.children !== undefined && !Array.isArray(record.children)) fail(`${where}.children is not a list`);
    const children = (record.children as unknown[] | undefined)?.map((child, index) => check(child, `${where}.children[${index}]`));
    return {
      name: record.name as string,
      className: record.className as string,
      ...(record.filePaths ? { filePaths: record.filePaths as string[] } : {}),
      ...(children ? { children } : {}),
    };
  };
  return check(value, 'root');
}

/**
 * Rojo's own map from instances to files. Paths in it are relative to the
 * project folder; `--absolute` is avoided because Rojo printed Windows
 * verbatim paths there until rojo-rbx/rojo#1290.
 */
export async function loadSourcemap(projectFile: string, run: RojoRunner): Promise<SourcemapNode> {
  let output: string;
  try {
    output = await run(['sourcemap', path.basename(projectFile)], path.dirname(projectFile));
  } catch (error) {
    rethrow(error, 'sourcemap');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new RojoError('rojo_link_invalid', `rojo sourcemap did not print JSON: ${oneLine(output).slice(0, 200)}`);
  }
  return validateSourcemap(parsed);
}
