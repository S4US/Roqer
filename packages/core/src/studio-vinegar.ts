import { execFile, execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

/**
 * Roblox Studio on Linux, through Vinegar.
 *
 * Roblox publishes no Linux Studio. Vinegar (https://vinegarhq.org) is a
 * bootstrapper that keeps a Wine prefix, installs Studio into it, and runs
 * `RobloxStudioBeta.exe` there. Everything Linux-specific about finding,
 * addressing, and launching Studio lives in this module; the rest of the server
 * treats Vinegar as one more way Studio can run.
 *
 * What the rest of the server depends on, checked against Vinegar 1.9.4
 * (Flatpak `org.vinegarhq.Vinegar`, 2026-10-15):
 *
 * - `flatpak run org.vinegarhq.Vinegar <args>` forwards `<args>` verbatim to
 *   `RobloxStudioBeta.exe`. Vinegar drops a leading `run`, and treats a lone
 *   `manage` or `config` as its own command; every other argument is Studio's.
 * - Vinegar translates no paths. A path must reach Studio in Wine form, and the
 *   prefix maps `Z:` to `/`, so `/home/me/a.rbxl` is `Z:\home\me\a.rbxl`.
 * - Vinegar points the prefix's `Local AppData` shell folder at
 *   `<data>/appdata`, and Studio keeps its settings, logs and caches there. Its
 *   plugins folder is the one thing it resolves from the Wine user profile
 *   instead, so that lives at
 *   `<prefix>/drive_c/users/<user>/AppData/Local/Roblox/Plugins` — checked by
 *   putting a differently named copy in each candidate folder and reading back
 *   which one Studio loaded (`user_<name>.rbxmx` in its log).
 * - Studio is installed as `RobloxStudioBeta.exe` in a `version-` folder under
 *   `<data>/versions`.
 * - The sandbox shares the network namespace, so the plugin reaches the bridge
 *   on `127.0.0.1` with nothing extra configured. It shares only part of the
 *   file system, so a file Studio must open has to be somewhere the sandbox can
 *   see: `vinegarCanReadPath` answers that, and `flatpakOverrideCommand` is the
 *   command that fixes it when it cannot.
 *
 * Vinegar launches Studio through a single GTK application instance, so a
 * second `flatpak run` hands its arguments to the first and exits at once. The
 * process it leaves behind is therefore not Studio, and the launcher's exit
 * says nothing about Studio's: `studio-instance-manager` identifies the Studio
 * process by observing the process table instead.
 */

export const VINEGAR_FLATPAK_ID = 'org.vinegarhq.Vinegar';
export const VINEGAR_STUDIO_EXECUTABLE = 'RobloxStudioBeta.exe';

/** Overrides Vinegar discovery entirely, for an unpackaged or relocated install. */
export const VINEGAR_DATA_DIR_ENV = 'ROBLOX_STUDIO_VINEGAR_DATA_DIR';
/** Set to `0` or `false` to keep the server from using Vinegar at all. */
export const VINEGAR_ENABLED_ENV = 'ROBLOX_STUDIO_VINEGAR';

const WSL_KERNEL_PATTERN = /microsoft|wsl/i;

export interface VinegarInstall {
  /** Only the Flatpak is recognised; it is the single supported Vinegar packaging. */
  kind: 'flatpak';
  /** The program that starts Studio. */
  command: string;
  /** The arguments that precede Vinegar's own options and Studio's arguments. */
  commandArgs: readonly string[];
  /** The Flatpak application id, so a caller can name it in a message. */
  applicationId: string;
  /** Vinegar's data root: the folder holding `versions`, `prefixes`, and `appdata`. */
  dataDir: string;
  /** The Wine prefix Studio runs in. */
  prefixDir: string;
  /** Where the prefix's `Local AppData` shell folder points: Studio's settings, logs and caches. */
  appDataDir: string;
  /** The Wine user profile Studio runs under, as a host path. */
  prefixUserDir: string;
  /** Where Studio loads plugins from, as a host path. */
  pluginsDir: string;
  /** The same folder as Studio addresses it from inside the prefix. */
  pluginsDirInPrefix: string;
  /** Studio's own `GlobalSettings_13.xml`. */
  studioSettingsPath: string;
  /** Where Vinegar installs Studio versions. */
  versionsDir: string;
  /** The installed Vinegar version, when the Flatpak reported one. */
  version?: string;
}

export interface VinegarEvidence {
  platform: NodeJS.Platform;
  /** True for WSL, where Studio runs on Windows and Vinegar must not be used. */
  isWsl?: boolean;
  /**
   * `/proc/version`, whose WSL signature also rules Vinegar out.
   *
   * `studio-platform` draws the authoritative WSL conclusion, from this and a
   * live interop probe, but it reads this module to decide what Linux can run,
   * so this module cannot read it back. Recognising the kernel here keeps every
   * caller safe on WSL whatever it checks itself.
   */
  kernelVersion?: string;
  home?: string;
  /** `ROBLOX_STUDIO_VINEGAR`, when set. */
  enabled?: string;
  /** `ROBLOX_STUDIO_VINEGAR_DATA_DIR`, when set. */
  dataDirOverride?: string;
  /**
   * The Wine user profile folder name in the prefix, which holds Studio's
   * plugins folder. Wine names it after the host user; a prefix built by
   * another tool may name it something else, so the live probe reads the
   * prefix and only falls back to the host user name.
   */
  prefixUser?: string;
  /** The `flatpak` program, when one is on PATH. */
  flatpakCommand?: string;
  /** Whether `flatpak info` found the Vinegar application. */
  flatpakAppInstalled?: boolean;
  /** The version `flatpak info` reported. */
  flatpakAppVersion?: string;
}

function vinegarPaths(
  dataDir: string,
  prefixUser: string,
): Omit<VinegarInstall, 'kind' | 'command' | 'commandArgs' | 'applicationId' | 'version'> {
  const appDataDir = path.join(dataDir, 'appdata');
  const prefixDir = path.join(dataDir, 'prefixes', 'studio');
  const prefixUserDir = path.join(prefixDir, 'drive_c', 'users', prefixUser);
  return {
    dataDir,
    prefixDir,
    appDataDir,
    prefixUserDir,
    pluginsDir: path.join(prefixUserDir, 'AppData', 'Local', 'Roblox', 'Plugins'),
    pluginsDirInPrefix: `C:\\users\\${prefixUser}\\AppData\\Local\\Roblox\\Plugins`,
    studioSettingsPath: path.join(appDataDir, 'Roblox', 'GlobalSettings_13.xml'),
    versionsDir: path.join(dataDir, 'versions'),
  };
}


/** Vinegar's data root inside the Flatpak's per-application data folder. */
export function flatpakVinegarDataDir(home: string): string {
  return path.join(home, '.var', 'app', VINEGAR_FLATPAK_ID, 'data', 'vinegar');
}

/** Vinegar's data root: an explicit override, else the Flatpak's own folder. */
export function vinegarDataDir(home: string, override?: string): string | undefined {
  const explicit = override?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  return home === '' ? undefined : flatpakVinegarDataDir(home);
}

/**
 * The Vinegar install this host can launch Studio with, or nothing.
 *
 * Studio need not be installed yet: Vinegar downloads it on first run, and the
 * plugin has to be in place before that run so Studio loads it. Only a missing
 * Vinegar means there is no install.
 */
export function detectVinegarInstall(evidence: VinegarEvidence): VinegarInstall | undefined {
  if (evidence.platform !== 'linux' || evidence.isWsl === true) return undefined;
  if (WSL_KERNEL_PATTERN.test(evidence.kernelVersion ?? '')) return undefined;
  if (evidence.enabled !== undefined && /^(0|false|no|off)$/iu.test(evidence.enabled.trim())) {
    return undefined;
  }

  const flatpakCommand = evidence.flatpakCommand;
  if (!flatpakCommand || evidence.flatpakAppInstalled !== true) return undefined;

  const home = evidence.home ?? '';
  const dataDir = vinegarDataDir(home, evidence.dataDirOverride);
  if (dataDir === undefined) return undefined;

  const prefixUser = evidence.prefixUser?.trim();
  if (prefixUser === undefined || prefixUser === '') return undefined;

  return {
    kind: 'flatpak',
    command: flatpakCommand,
    commandArgs: ['run'],
    applicationId: VINEGAR_FLATPAK_ID,
    version: evidence.flatpakAppVersion,
    ...vinegarPaths(dataDir, prefixUser),
  };
}

/**
 * A Linux path as Studio sees it in Vinegar's prefix.
 *
 * The prefix maps `Z:` to the root of the file system, which is how a host path
 * is addressed from inside Wine. Vinegar forwards arguments untouched, so this
 * translation is the server's to do.
 */
export function toVinegarStudioPath(linuxPath: string): string {
  if (!path.posix.isAbsolute(linuxPath)) {
    throw new Error(`Only an absolute path can be addressed inside Vinegar's Wine prefix: ${linuxPath}`);
  }
  if (linuxPath.includes('\0')) {
    throw new Error('A path addressed inside Vinegar must not contain a null character.');
  }
  const normalized = path.posix.normalize(linuxPath).replace(/\/+$/u, '');
  return `Z:${(normalized === '' ? '/' : normalized).replaceAll('/', '\\')}`;
}

/** The newest `RobloxStudioBeta.exe` Vinegar has installed. */
export function resolveVinegarStudioExe(install: VinegarInstall): string {
  if (!existsSync(install.versionsDir)) {
    throw new Error(
      `Vinegar has not installed Roblox Studio yet: ${install.versionsDir} does not exist. ` +
        `Start Studio once with "${install.command} run ${install.applicationId}", or set ROBLOX_STUDIO_EXE.`,
    );
  }
  const candidates = readdirSync(install.versionsDir)
    .filter((name) => name.startsWith('version-'))
    .map((name) => path.join(install.versionsDir, name, VINEGAR_STUDIO_EXECUTABLE))
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (candidates.length === 0) {
    throw new Error(
      `${VINEGAR_STUDIO_EXECUTABLE} not found under ${install.versionsDir}. ` +
        `Start Studio once with "${install.command} run ${install.applicationId}", or set ROBLOX_STUDIO_EXE.`,
    );
  }
  return candidates[0];
}

/**
 * Where generated place files go, so Studio inside the sandbox can open them.
 *
 * Not the system temp folder: the Flatpak has its own `/tmp`, so a file written
 * there is invisible to Studio. Vinegar's Flatpak data folder is the one place
 * the sandbox always reaches, whatever else the user has shared with it, and a
 * folder of our own beside Vinegar's keeps these files out of its way.
 */
export function vinegarPlaceFileDir(install: Pick<VinegarInstall, 'dataDir'>): string {
  return path.join(path.dirname(install.dataDir), 'roqer-places');
}

export interface VinegarSandboxFilesystem {
  /** Host paths the sandbox can reach. */
  allowed: readonly string[];
  /** Host paths explicitly withheld, which win over `allowed`. */
  denied: readonly string[];
}

export interface VinegarUserDirectories {
  home: string;
  documents: string;
  pictures: string;
  download: string;
  music: string;
  videos: string;
  desktop: string;
  publicShare: string;
  templates: string;
  runtime?: string;
  configHome?: string;
  cacheHome?: string;
  dataHome?: string;
}

/** The `[Context]` `filesystems=` entries of `flatpak info --show-permissions`. */
export function parseFlatpakFilesystems(showPermissionsOutput: string): string[] {
  let inContext = false;
  for (const rawLine of showPermissionsOutput.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inContext = line === '[Context]';
      continue;
    }
    if (!inContext) continue;
    const match = /^filesystems\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    return match[1]
      .split(';')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
  }
  return [];
}

/** `~/.config/user-dirs.dirs`, which names the XDG folders a Flatpak token resolves to. */
export function parseUserDirectories(userDirsFile: string, home: string): Partial<VinegarUserDirectories> {
  const names: Record<string, keyof VinegarUserDirectories> = {
    XDG_DOCUMENTS_DIR: 'documents',
    XDG_PICTURES_DIR: 'pictures',
    XDG_DOWNLOAD_DIR: 'download',
    XDG_MUSIC_DIR: 'music',
    XDG_VIDEOS_DIR: 'videos',
    XDG_DESKTOP_DIR: 'desktop',
    XDG_PUBLICSHARE_DIR: 'publicShare',
    XDG_TEMPLATES_DIR: 'templates',
  };
  const resolved: Partial<VinegarUserDirectories> = {};
  for (const rawLine of userDirsFile.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(XDG_[A-Z]+_DIR)\s*=\s*"?(.*?)"?$/u.exec(line);
    if (!match) continue;
    const key = names[match[1]];
    if (!key) continue;
    const value = match[2].replace(/^\$HOME/u, home).replace(/^~(?=\/|$)/u, home);
    if (value !== '') resolved[key] = value;
  }
  return resolved;
}

/**
 * The host paths a Flatpak's filesystem entries reach.
 *
 * `host` is the whole file system, `home` the user's folder, an `xdg-*` token
 * the matching user folder, and anything else a literal path. An entry Flatpak
 * writes with a `:ro` or `:create` suffix reaches the same place; a `!` prefix
 * withholds it, and withholding wins.
 */
export function resolveFlatpakFilesystems(
  entries: readonly string[],
  directories: VinegarUserDirectories,
): VinegarSandboxFilesystem {
  const allowed: string[] = [];
  const denied: string[] = [];
  const xdg: Record<string, string | undefined> = {
    'xdg-documents': directories.documents,
    'xdg-pictures': directories.pictures,
    'xdg-download': directories.download,
    'xdg-music': directories.music,
    'xdg-videos': directories.videos,
    'xdg-desktop': directories.desktop,
    'xdg-public-share': directories.publicShare,
    'xdg-publicshare': directories.publicShare,
    'xdg-templates': directories.templates,
    'xdg-run': directories.runtime,
    'xdg-config': directories.configHome,
    'xdg-cache': directories.cacheHome,
    'xdg-data': directories.dataHome,
  };

  for (const raw of entries) {
    const withheld = raw.startsWith('!');
    const entry = (withheld ? raw.slice(1) : raw).replace(/:(ro|rw|create)$/u, '');
    if (entry === '') continue;

    let resolved: string | undefined;
    if (entry === 'host' || entry === 'host-os' || entry === 'host-etc') {
      resolved = entry === 'host' ? '/' : entry === 'host-os' ? '/usr' : '/etc';
    } else if (entry === 'home') {
      resolved = directories.home;
    } else if (entry.startsWith('~/')) {
      resolved = path.join(directories.home, entry.slice(2));
    } else if (entry.startsWith('/')) {
      resolved = entry;
    } else {
      const slash = entry.indexOf('/');
      const token = slash === -1 ? entry : entry.slice(0, slash);
      const base = xdg[token];
      if (base !== undefined) resolved = slash === -1 ? base : path.join(base, entry.slice(slash + 1));
    }
    if (resolved === undefined) continue;
    (withheld ? denied : allowed).push(path.resolve(resolved));
  }

  return { allowed, denied };
}

function isInside(target: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  if (target === resolvedRoot) return true;
  const relative = path.relative(resolvedRoot, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Whether Studio, inside Vinegar's sandbox, can reach a host path.
 *
 * Vinegar's own data folder is always reachable, because the sandbox is built
 * around it. Everything else has to be shared, and a path that is not produces
 * an empty Studio window rather than an error, so the server checks before it
 * launches and names the command that fixes it.
 */
export function vinegarCanReadPath(
  target: string,
  filesystem: VinegarSandboxFilesystem,
  install?: Pick<VinegarInstall, 'dataDir'>,
): boolean {
  if (!path.posix.isAbsolute(target)) return false;
  const resolved = path.resolve(target);
  if (filesystem.denied.some((root) => isInside(resolved, root))) return false;
  if (install && isInside(resolved, path.dirname(path.resolve(install.dataDir)))) return true;
  return filesystem.allowed.some((root) => isInside(resolved, root));
}

/**
 * A value as a shell would read it back verbatim.
 *
 * The override command is printed for the user to run, so it has to survive a
 * shell: a double-quoted path still expands $HOME and a backtick, which single
 * quotes do not, and a single quote inside is closed, escaped, and reopened.
 */
function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command that shares a folder with Vinegar for good. */
export function flatpakOverrideCommand(install: VinegarInstall, directory: string): string {
  return `${install.command} override --user --filesystem=${shellQuoted(directory)} ${install.applicationId}`;
}

/**
 * Why Studio inside the sandbox could not reach a path, or nothing when it can.
 *
 * A path the sandbox cannot see produces an empty Studio window rather than an
 * error, so a launch that would hit one is refused with the command that fixes
 * it. `share` is the folder to share: the file's own folder for a file, the
 * directory itself for one Studio is asked to work in.
 */
export function vinegarReachRefusal(
  install: VinegarInstall,
  filesystem: VinegarSandboxFilesystem,
  target: string,
  consequence: string,
  share: string = path.dirname(target),
): string | undefined {
  if (vinegarCanReadPath(target, filesystem, install)) return undefined;
  return `Vinegar's Flatpak sandbox cannot read ${target}, so ${consequence}. ` +
    `Share the folder with Vinegar once:\n  ${flatpakOverrideCommand(install, share)}`;
}

export interface VinegarLaunchCommandOptions {
  install: VinegarInstall;
  /** Studio's own arguments, already in Wine path form. */
  studioArgs: readonly string[];
  /** A working directory for Studio, as a host path. */
  workingDirectory?: string;
  environment?: { set?: Record<string, string>; remove?: readonly string[] };
}

/**
 * The exact command that launches Studio under Vinegar.
 *
 * Nothing is shared with the sandbox here. Flatpak honours a `--filesystem`
 * given to `flatpak run` only when that command is the one that starts the
 * application, and Vinegar is usually already running, so a share granted this
 * way would work on some launches and not others. What Studio may open is
 * decided before a launch by `vinegarCanReadPath`, against the shares the user
 * has actually made.
 */
export function buildVinegarLaunchCommand(
  options: VinegarLaunchCommandOptions,
): { command: string; args: string[] } {
  const { install } = options;
  const args = [...install.commandArgs];
  for (const name of options.environment?.remove ?? []) args.push(`--unset-env=${name}`);
  for (const [name, value] of Object.entries(options.environment?.set ?? {})) {
    args.push(`--env=${name}=${value}`);
  }
  if (options.workingDirectory !== undefined) args.push(`--cwd=${options.workingDirectory}`);
  args.push(install.applicationId, ...options.studioArgs);
  return { command: install.command, args };
}

export interface VinegarStudioProcess {
  id: number;
  commandLine: string;
  executable: string;
  /**
   * The process's start time in kernel ticks since boot, from
   * `/proc/<pid>/stat`. Compared only for equality, which is what keeps a
   * recycled pid from passing as the Studio a launch started. Absent when the
   * process was gone before it could be read.
   */
  startedAt?: string;
}

/**
 * A process's start time in `/proc/<pid>/stat`, field 22.
 *
 * The program name in field 2 is parenthesised and may itself contain spaces
 * and parentheses, so the fields are counted from the last `)`.
 */
export function parseProcessStartTicks(statFile: string): string | undefined {
  const afterName = statFile.slice(statFile.lastIndexOf(')') + 1).trim();
  if (afterName === '') return undefined;
  // Field 3 (the state) is the first here, so field 22 is the twentieth.
  const startTicks = afterName.split(/\s+/u)[19];
  return startTicks !== undefined && /^\d+$/u.test(startTicks) ? startTicks : undefined;
}

function readProcessStartTicks(id: number): string | undefined {
  try {
    return parseProcessStartTicks(readFileSync(`/proc/${id}/stat`, 'utf8'));
  } catch {
    // The process exited between the listing and this read.
    return undefined;
  }
}

/**
 * A process's own program, from `/proc/<pid>/cmdline`.
 *
 * The arguments there are separated by null bytes, so the first one is the
 * program exactly, however many spaces its path holds. `pgrep -a` joins them
 * with spaces, where a path holding one cannot be told from two arguments.
 */
function readProcessExecutable(id: number): string | undefined {
  try {
    const argv0 = readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0')[0];
    return argv0 === '' ? undefined : argv0;
  } catch {
    // The process exited between the listing and this read.
    return undefined;
  }
}

/**
 * Studio processes in `pgrep -a` output.
 *
 * Only a process whose own program is `RobloxStudioBeta.exe` counts. Studio's
 * embedded browser names that executable in its own arguments, and matching the
 * whole command line would report every one of those helpers as a Studio.
 *
 * The program is read from `/proc`, where the arguments are separated by null
 * bytes; the first word of `pgrep` output stands in only for a process that
 * ended first, and a path holding a space is read wrongly there.
 */
export function parseVinegarStudioProcesses(
  pgrepOutput: string,
  startedAt: (id: number) => string | undefined = readProcessStartTicks,
  executableOf: (id: number) => string | undefined = readProcessExecutable,
): VinegarStudioProcess[] {
  const processes: VinegarStudioProcess[] = [];
  for (const rawLine of pgrepOutput.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = /^(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const commandLine = match[2];
    const executable = executableOf(id) ?? commandLine.split(/\s+/u)[0] ?? '';
    if (path.posix.basename(executable).toLowerCase() !== VINEGAR_STUDIO_EXECUTABLE.toLowerCase()) {
      continue;
    }
    processes.push({ id, commandLine, executable, startedAt: startedAt(id) });
  }
  return processes;
}

const execFileAsync = promisify(execFile);

function runQuietly(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      killSignal: 'SIGKILL',
    }).trim();
  } catch {
    return undefined;
  }
}

function resolveFlatpakCommand(): string | undefined {
  for (const candidate of ['/usr/bin/flatpak', '/var/lib/flatpak/exports/bin/flatpak']) {
    if (existsSync(candidate)) return candidate;
  }
  return runQuietly('/usr/bin/env', ['sh', '-c', 'command -v flatpak']) || undefined;
}

/**
 * The Wine user profile Studio runs under, read from the prefix.
 *
 * `Public` is Wine's shared profile and never the user's. A prefix Vinegar has
 * not created yet has no profiles at all, and the host user name is what Wine
 * will name the one it creates.
 */
export function resolveVinegarPrefixUser(
  prefixDir: string,
  hostUser: string,
  listUsers: (usersDir: string) => string[] = (usersDir) => {
    try {
      return readdirSync(usersDir);
    } catch {
      return [];
    }
  },
): string {
  const profiles = listUsers(path.join(prefixDir, 'drive_c', 'users'))
    .filter((name) => name !== 'Public');
  if (profiles.includes(hostUser)) return hostUser;
  return profiles.length === 1 ? profiles[0] : hostUser;
}

/**
 * The name of the user this process runs as, or an empty string.
 *
 * `os.userInfo()` throws when the user id has no entry in the user database,
 * as in a container started with `--user 1234`. Every host probes Vinegar,
 * the plugin installer included, so a throw here failed them all; such a
 * process falls back to the login variables, and with neither it has no
 * prefix user, which means no Vinegar install.
 */
export function hostUserName(
  userInfo: () => { username: string } = os.userInfo,
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    return userInfo().username;
  } catch {
    return env.USER?.trim() || env.LOGNAME?.trim() || '';
  }
}

function liveVinegarEvidence(): VinegarEvidence {
  const home = os.homedir();
  const dataDirOverride = process.env[VINEGAR_DATA_DIR_ENV];
  const dataDir = vinegarDataDir(home, dataDirOverride);
  const evidence: VinegarEvidence = {
    platform: process.platform,
    home,
    enabled: process.env[VINEGAR_ENABLED_ENV],
    dataDirOverride,
    prefixUser: dataDir === undefined
      ? undefined
      : resolveVinegarPrefixUser(
          path.join(dataDir, 'prefixes', 'studio'),
          hostUserName(),
        ),
  };
  if (process.platform !== 'linux') return evidence;

  let kernelVersion = '';
  try {
    kernelVersion = readFileSync('/proc/version', 'utf8');
  } catch {
    // No procfs: treat the host as an ordinary Linux one.
  }
  if (WSL_KERNEL_PATTERN.test(kernelVersion)) return { ...evidence, kernelVersion };

  const flatpakCommand = resolveFlatpakCommand();
  if (!flatpakCommand) return { ...evidence, kernelVersion };
  const info = runQuietly(flatpakCommand, ['info', VINEGAR_FLATPAK_ID]);
  if (info === undefined) return { ...evidence, kernelVersion, flatpakCommand };
  const version = /^\s*Version:\s*(.+)$/mu.exec(info)?.[1]?.trim();
  return { ...evidence, kernelVersion, flatpakCommand, flatpakAppInstalled: true, flatpakAppVersion: version };
}

let cachedInstall: { install: VinegarInstall | undefined } | undefined;

/** The Vinegar install on this host, probed once. */
export function getVinegarInstall(): VinegarInstall | undefined {
  cachedInstall ??= { install: detectVinegarInstall(liveVinegarEvidence()) };
  return cachedInstall.install;
}

let cachedUserDirectories: VinegarUserDirectories | undefined;

/** The XDG folders a Flatpak filesystem token resolves to on this host. */
export function getVinegarUserDirectories(): VinegarUserDirectories {
  if (cachedUserDirectories) return cachedUserDirectories;
  const home = os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  let fromFile: Partial<VinegarUserDirectories> = {};
  try {
    fromFile = parseUserDirectories(readFileSync(path.join(configHome, 'user-dirs.dirs'), 'utf8'), home);
  } catch {
    // No user-dirs.dirs: the XDG defaults below are what Flatpak falls back to.
  }
  cachedUserDirectories = {
    home,
    configHome,
    cacheHome: process.env.XDG_CACHE_HOME?.trim() || path.join(home, '.cache'),
    dataHome: process.env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share'),
    runtime: process.env.XDG_RUNTIME_DIR?.trim() || undefined,
    documents: fromFile.documents ?? path.join(home, 'Documents'),
    pictures: fromFile.pictures ?? path.join(home, 'Pictures'),
    download: fromFile.download ?? path.join(home, 'Downloads'),
    music: fromFile.music ?? path.join(home, 'Music'),
    videos: fromFile.videos ?? path.join(home, 'Videos'),
    desktop: fromFile.desktop ?? path.join(home, 'Desktop'),
    publicShare: fromFile.publicShare ?? path.join(home, 'Public'),
    templates: fromFile.templates ?? path.join(home, 'Templates'),
  };
  return cachedUserDirectories;
}

let cachedFilesystem: { probedAt: number; filesystem: VinegarSandboxFilesystem } | undefined;

/**
 * How long a reading of the sandbox's shares stands.
 *
 * One launch asks about several paths, which is what the reading saves; it is
 * short because a refused launch tells the user to share a folder, and the
 * launch they try next has to see that they did.
 */
const SANDBOX_FILESYSTEM_TTL_MS = 5_000;

/** What Vinegar's sandbox can reach on this host, as of a recent probe. */
export function getVinegarSandboxFilesystem(
  install: VinegarInstall,
  readPermissions: (install: VinegarInstall) => string | undefined = (target) =>
    runQuietly(target.command, ['info', '--show-permissions', target.applicationId]),
  directories: VinegarUserDirectories = getVinegarUserDirectories(),
): VinegarSandboxFilesystem {
  const now = Date.now();
  if (cachedFilesystem !== undefined && now - cachedFilesystem.probedAt < SANDBOX_FILESYSTEM_TTL_MS) {
    return cachedFilesystem.filesystem;
  }
  const output = readPermissions(install);
  const filesystem = resolveFlatpakFilesystems(
    output === undefined ? [] : parseFlatpakFilesystems(output),
    directories,
  );
  cachedFilesystem = { probedAt: now, filesystem };
  return filesystem;
}

/**
 * Drops the reading of the sandbox's shares, so the next caller takes a new one.
 *
 * Called where a launch is refused for a path the sandbox cannot reach: the
 * user is told to share that folder, and nothing of the old reading should
 * outlive their doing it.
 */
export function forgetVinegarSandboxFilesystem(): void {
  cachedFilesystem = undefined;
}

/** Studio processes Vinegar is running, by observing the host process table. */
export async function observeVinegarStudioProcesses(): Promise<VinegarStudioProcess[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-a', '-f', VINEGAR_STUDIO_EXECUTABLE], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5000,
    });
    return parseVinegarStudioProcesses(stdout);
  } catch (error) {
    // pgrep exits 1 when nothing matched, which is not an error.
    if (Number((error as { code?: unknown }).code) === 1) return [];
    throw error;
  }
}

/** The synchronous form of `observeVinegarStudioProcesses`. */
export function listVinegarStudioProcesses(): VinegarStudioProcess[] {
  try {
    return parseVinegarStudioProcesses(
      execFileSync('pgrep', ['-a', '-f', VINEGAR_STUDIO_EXECUTABLE], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch (error) {
    if (Number((error as { status?: unknown }).status) === 1) return [];
    throw error;
  }
}

/**
 * A process of a Vinegar session other than Studio: the Vinegar application
 * instance itself, or the Wine server of its prefix.
 */
export interface VinegarSessionProcess {
  id: number;
  role: 'vinegar' | 'wineserver';
}

/**
 * The Vinegar instance and the prefix's Wine server in `pgrep -a` output.
 *
 * Both outlive the Studio they ran for a moment. Checked against Vinegar 1.9.4
 * on 2026-11-08: with Studio killed, the instance (a process whose own program
 * is `vinegar`) exits about 0.4 s later and the Wine server (Vinegar's own
 * `<data>/kombucha*` build of `wineserver`) about 1.4 s later. The `bwrap`
 * wrapper around the instance names `vinegar` only in its arguments and is not
 * counted, nor is Studio, which `parseVinegarStudioProcesses` reads.
 */
export function parseVinegarSessionProcesses(
  pgrepOutput: string,
  install: Pick<VinegarInstall, 'dataDir'>,
  executableOf: (id: number) => string | undefined = readProcessExecutable,
): VinegarSessionProcess[] {
  const dataDir = path.posix.resolve(install.dataDir) + '/';
  const processes: VinegarSessionProcess[] = [];
  for (const rawLine of pgrepOutput.split(/\r?\n/u)) {
    const match = /^(\d+)\s+(.*)$/u.exec(rawLine.trim());
    if (!match) continue;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const executable = executableOf(id) ?? match[2].split(/\s+/u)[0] ?? '';
    const name = path.posix.basename(executable);
    if (name === 'vinegar') {
      processes.push({ id, role: 'vinegar' });
    } else if (name === 'wineserver' && executable.startsWith(dataDir)) {
      processes.push({ id, role: 'wineserver' });
    }
  }
  return processes;
}

/** The Vinegar instance and Wine server running now, by observing the host process table. */
export async function observeVinegarSessionProcesses(
  install: Pick<VinegarInstall, 'dataDir'>,
): Promise<VinegarSessionProcess[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-a', '-f', 'vinegar'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5000,
    });
    return parseVinegarSessionProcesses(stdout, install);
  } catch (error) {
    if (Number((error as { code?: unknown }).code) === 1) return [];
    throw error;
  }
}

/**
 * The longest a launch waits for an ending Vinegar session to finish. The
 * session takes about a second and a half; the margin covers a busy host and a
 * Wine server that lingers for its `--persistent` grace period.
 */
export const VINEGAR_SESSION_END_TIMEOUT_MS = 15_000;

export type VinegarSessionEndOutcome =
  /** No session was running: launch at once. */
  | 'none'
  /** Studio is running, so its Vinegar instance is live and takes the launch. */
  | 'studio-running'
  /** A session was ending and has now ended. */
  | 'ended'
  /** Something of a session was still running at the limit; the launch goes ahead. */
  | 'timed-out'
  /** The process table could not be read; the launch goes ahead as before. */
  | 'unobserved';

export interface VinegarSessionObservation {
  studioRunning: boolean;
  session: readonly VinegarSessionProcess[];
}

/**
 * Wait until no Vinegar session is in the middle of ending.
 *
 * Vinegar runs one application instance, and `flatpak run` hands a second
 * launch to it. Straight after Studio exits, that instance and its Wine server
 * are still shutting down. A launch handed to the instance then is lost, and a
 * launch that starts a new instance while the old Wine server is still
 * stopping gets a Studio that hangs before it writes its first log line. Either
 * way the plugin never connects. A fast relaunch hits this every time it lands
 * in that second and a half.
 *
 * A session with Studio still running is live, not ending, so a launch goes to
 * it at once. With no Studio, any Vinegar instance or Wine server left is
 * taken to be ending. One that is not (Vinegar's own settings window, left
 * open) costs one wait of `timeoutMs`, after which the launch goes ahead.
 */
export async function waitForVinegarSessionEnd(options: {
  observe: () => Promise<VinegarSessionObservation>;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<VinegarSessionEndOutcome> {
  const timeoutMs = options.timeoutMs ?? VINEGAR_SESSION_END_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 100;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (let first = true; ; first = false) {
    let observation: VinegarSessionObservation;
    try {
      observation = await options.observe();
    } catch {
      return 'unobserved';
    }
    if (observation.studioRunning) return 'studio-running';
    if (observation.session.length === 0) return first ? 'none' : 'ended';
    if (now() >= deadline) return 'timed-out';
    await sleep(pollMs);
  }
}
