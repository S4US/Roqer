/** Host-only configuration used by Rojo and Git children, never model arguments. */
export const SOURCE_ENVIRONMENT_LIMIT = 64 * 1024;
export const SOURCE_ENVIRONMENT_VALUE_LIMIT = 16 * 1024;
const MAX_GIT_CONFIG_PAIRS = 32;
const NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
]);
const indexed = /^GIT_CONFIG_(KEY|VALUE)_(\d+)$/;
const supportedGitKey = (key: string): boolean => /^(?:core\.(?:excludesfile|ignorecase|worktree|bare)|safe\.directory|include\.path|includeif\..+\.path|extensions\.worktreeconfig)$/i.test(key);

export class SourceEnvironmentError extends Error {
  readonly errorCode = 'rojo_environment_unsupported';
  constructor() {
    super('The Rojo/Git environment cannot be delegated safely. Use supported configuration paths and retry; no source operation ran.');
  }
}

function canonicalEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    result[key] = value;
  }
  return result;
}

/** Git's single-quoted environment representation, not a shell invocation. */
function gitParameters(text: string): Array<[string, string]> {
  const tokens: string[] = [];
  let token = '', quoted = false, started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'") { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(char)) {
      if (started) tokens.push(token);
      token = ''; started = false; continue;
    }
    if (!quoted && char === '\\') {
      const next = text[++index];
      if (next !== "'" && next !== '!') throw new SourceEnvironmentError();
      token += next; started = true; continue;
    }
    if (!quoted && char !== '=') throw new SourceEnvironmentError();
    token += char; started = true;
  }
  if (quoted) throw new SourceEnvironmentError();
  if (started) tokens.push(token);
  if (tokens.length > MAX_GIT_CONFIG_PAIRS) throw new SourceEnvironmentError();
  return tokens.map((value) => {
    const equal = value.indexOf('=');
    if (equal === -1 && /^(?:core\.(?:bare|ignorecase)|extensions\.worktreeconfig)$/i.test(value)) return [value, 'true'];
    if (equal < 1) throw new SourceEnvironmentError();
    return [value.slice(0, equal), value.slice(equal + 1)];
  });
}

function quoteGit(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function checkedSize(environment: Record<string, string>): void {
  let bytes = 0;
  for (const [name, value] of Object.entries(environment)) {
    if (value.includes('\0') || Buffer.byteLength(value) > SOURCE_ENVIRONMENT_VALUE_LIMIT) throw new SourceEnvironmentError();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 2;
  }
  if (bytes > SOURCE_ENVIRONMENT_LIMIT) throw new SourceEnvironmentError();
}

export function captureSourceEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const original = canonicalEnvironment(input);
  const result: Record<string, string> = Object.create(null);
  for (const name of NAMES) {
    if (name !== 'GIT_CONFIG_COUNT' && name !== 'GIT_CONFIG_PARAMETERS' && original[name] !== undefined) result[name] = original[name];
  }
  if (original.GIT_CONFIG_COUNT !== undefined) {
    const rawCount = original.GIT_CONFIG_COUNT;
    if (!/^(?:|0|[1-9]\d*)$/.test(rawCount)) throw new SourceEnvironmentError();
    const count = Number(rawCount);
    if (count > MAX_GIT_CONFIG_PAIRS) throw new SourceEnvironmentError();
    let included = 0;
    for (let index = 0; index < count; index++) {
      const key = original[`GIT_CONFIG_KEY_${index}`], value = original[`GIT_CONFIG_VALUE_${index}`];
      if (key === undefined || value === undefined) throw new SourceEnvironmentError();
      if (!supportedGitKey(key)) continue;
      result[`GIT_CONFIG_KEY_${included}`] = key;
      result[`GIT_CONFIG_VALUE_${included++}`] = value;
    }
    result.GIT_CONFIG_COUNT = String(included);
  }
  if (original.GIT_CONFIG_PARAMETERS !== undefined) {
    if (Buffer.byteLength(original.GIT_CONFIG_PARAMETERS) > SOURCE_ENVIRONMENT_VALUE_LIMIT || original.GIT_CONFIG_PARAMETERS.includes('\0')) throw new SourceEnvironmentError();
    const pairs = gitParameters(original.GIT_CONFIG_PARAMETERS).filter(([key]) => supportedGitKey(key));
    if (pairs.length > 0) result.GIT_CONFIG_PARAMETERS = pairs.map(([key, value]) => quoteGit(`${key}=${value}`)).join(' ');
  }
  checkedSize(result);
  return result;
}

export function validateSourceEnvironment(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SourceEnvironmentError();
  const environment: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(input)) {
    if ((!NAMES.has(name) && !indexed.test(name)) || typeof value !== 'string') throw new SourceEnvironmentError();
    environment[name] = value;
  }
  checkedSize(environment);
  const safe = captureSourceEnvironment(environment);
  // A receiver does not silently discard unsafe fields from a private packet.
  if (Object.keys(safe).length !== Object.keys(environment).length ||
      Object.entries(environment).some(([key, value]) => safe[key] !== value)) throw new SourceEnvironmentError();
  return safe;
}
