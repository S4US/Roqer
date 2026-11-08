import path from 'path';

import {
  buildVinegarLaunchCommand,
  detectVinegarInstall,
  flatpakOverrideCommand,
  flatpakVinegarDataDir,
  forgetVinegarSandboxFilesystem,
  getVinegarSandboxFilesystem,
  hostUserName,
  parseFlatpakFilesystems,
  parseProcessStartTicks,
  parseUserDirectories,
  parseVinegarSessionProcesses,
  parseVinegarStudioProcesses,
  resolveFlatpakFilesystems,
  resolveVinegarPrefixUser,
  toVinegarStudioPath,
  vinegarCanReadPath,
  vinegarPlaceFileDir,
  vinegarReachRefusal,
  waitForVinegarSessionEnd,
  type VinegarInstall,
  type VinegarSessionObservation,
  type VinegarUserDirectories,
} from '../studio-vinegar.js';

const HOME = '/home/dev';
const FLATPAK = '/usr/bin/flatpak';

function linuxEvidence(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'linux' as NodeJS.Platform,
    home: HOME,
    flatpakCommand: FLATPAK,
    flatpakAppInstalled: true,
    flatpakAppVersion: '1.9.4',
    prefixUser: 'dev',
    ...overrides,
  };
}

const INSTALL = detectVinegarInstall(linuxEvidence()) as VinegarInstall;

const DIRECTORIES: VinegarUserDirectories = {
  home: HOME,
  documents: `${HOME}/Documents`,
  pictures: `${HOME}/Pictures`,
  download: `${HOME}/Downloads`,
  music: `${HOME}/Music`,
  videos: `${HOME}/Videos`,
  desktop: `${HOME}/Desktop`,
  publicShare: `${HOME}/Public`,
  templates: `${HOME}/Templates`,
  runtime: '/run/user/1000',
  configHome: `${HOME}/.config`,
  cacheHome: `${HOME}/.cache`,
  dataHome: `${HOME}/.local/share`,
};

// What `flatpak info --show-permissions org.vinegarhq.Vinegar` printed for
// Vinegar 1.9.4 from Flathub.
const SHOW_PERMISSIONS = [
  '[Context]',
  'shared=ipc;network;',
  'sockets=pulseaudio;wayland;x11;',
  'devices=all;',
  'features=devel;',
  'filesystems=xdg-run/app/com.discordapp.Discord:create;xdg-documents;xdg-pictures;',
  '',
  '[Environment]',
  'GST_PLUGIN_SYSTEM_PATH=/app/lib/gstreamer-1.0',
  'filesystems=not-a-filesystem-entry',
].join('\n');

describe('Vinegar discovery', () => {
  test('a Linux host with the Vinegar Flatpak can launch Studio through it', () => {
    const data = flatpakVinegarDataDir(HOME);
    const prefix = path.join(data, 'prefixes', 'studio');
    const prefixUserDir = path.join(prefix, 'drive_c', 'users', 'dev');
    expect(detectVinegarInstall(linuxEvidence())).toEqual({
      kind: 'flatpak',
      command: FLATPAK,
      commandArgs: ['run'],
      applicationId: 'org.vinegarhq.Vinegar',
      version: '1.9.4',
      dataDir: data,
      prefixDir: prefix,
      // Vinegar points the prefix's Local AppData at its own folder, and
      // Studio keeps its settings and logs there.
      appDataDir: path.join(data, 'appdata'),
      studioSettingsPath: path.join(data, 'appdata', 'Roblox', 'GlobalSettings_13.xml'),
      // Its plugins folder is the one thing Studio resolves from the Wine user
      // profile instead, which is where it actually loads a plugin from.
      prefixUserDir,
      pluginsDir: path.join(prefixUserDir, 'AppData', 'Local', 'Roblox', 'Plugins'),
      pluginsDirInPrefix: 'C:\\users\\dev\\AppData\\Local\\Roblox\\Plugins',
      versionsDir: path.join(data, 'versions'),
    });
  });

  test('without a Wine user profile there is no plugins folder, so no install', () => {
    expect(detectVinegarInstall(linuxEvidence({ prefixUser: undefined }))).toBeUndefined();
    expect(detectVinegarInstall(linuxEvidence({ prefixUser: '  ' }))).toBeUndefined();
  });

  test("the Wine user profile is read from the prefix, and named after the host user when it cannot be", () => {
    const prefix = '/data/prefixes/studio';
    const users = path.join(prefix, 'drive_c', 'users');
    expect(resolveVinegarPrefixUser(prefix, 'dev', (dir) => {
      expect(dir).toBe(users);
      return ['Public', 'dev'];
    })).toBe('dev');
    // A prefix another tool built may name its one profile anything.
    expect(resolveVinegarPrefixUser(prefix, 'dev', () => ['Public', 'steamuser'])).toBe('steamuser');
    // Nothing to read, or nothing to choose between: Wine will name the
    // profile it creates after the host user.
    expect(resolveVinegarPrefixUser(prefix, 'dev', () => [])).toBe('dev');
    expect(resolveVinegarPrefixUser(prefix, 'dev', () => ['alice', 'bob'])).toBe('dev');
  });

  test('a user id with no account still probes, falling back to the login name and then to no prefix user', () => {
    const noAccount = () => {
      throw Object.assign(new Error('uv_os_get_passwd returned ENOENT'), { code: 'ERR_SYSTEM_ERROR' });
    };
    expect(hostUserName(() => ({ username: 'dev' }), { USER: 'other' })).toBe('dev');
    expect(hostUserName(noAccount, { USER: 'dev', LOGNAME: 'other' })).toBe('dev');
    expect(hostUserName(noAccount, { LOGNAME: 'dev' })).toBe('dev');
    expect(hostUserName(noAccount, {})).toBe('');
    // With no name and a prefix that does not settle it, there is no install
    // rather than a plugins folder under a made-up profile.
    expect(detectVinegarInstall(linuxEvidence({
      prefixUser: resolveVinegarPrefixUser('/data/prefixes/studio', hostUserName(noAccount, {}), () => []),
    }))).toBeUndefined();
  });

  test('a host that cannot run Vinegar has no install', () => {
    expect(detectVinegarInstall(linuxEvidence({ platform: 'win32' }))).toBeUndefined();
    expect(detectVinegarInstall(linuxEvidence({ platform: 'darwin' }))).toBeUndefined();
    // WSL runs the Windows Studio through interop; Vinegar must not take over,
    // whether the caller says so or only the kernel does.
    expect(detectVinegarInstall(linuxEvidence({ isWsl: true }))).toBeUndefined();
    expect(detectVinegarInstall(linuxEvidence({
      kernelVersion: 'Linux version 6.6.87.2-microsoft-standard-WSL2',
    }))).toBeUndefined();
    expect(detectVinegarInstall(linuxEvidence({
      kernelVersion: 'Linux version 6.8.0-generic',
    }))).toBeDefined();
    expect(detectVinegarInstall(linuxEvidence({ flatpakCommand: undefined }))).toBeUndefined();
    expect(detectVinegarInstall(linuxEvidence({ flatpakAppInstalled: false }))).toBeUndefined();
    expect(detectVinegarInstall(linuxEvidence({ home: '' }))).toBeUndefined();
  });

  test('Vinegar can be switched off, and its data folder relocated', () => {
    for (const enabled of ['0', 'false', 'FALSE', 'no', ' off ']) {
      expect(detectVinegarInstall(linuxEvidence({ enabled }))).toBeUndefined();
    }
    expect(detectVinegarInstall(linuxEvidence({ enabled: '1' }))).toBeDefined();

    const relocated = detectVinegarInstall(linuxEvidence({ dataDirOverride: ' /opt/vinegar ' }));
    expect(relocated?.dataDir).toBe('/opt/vinegar');
    expect(relocated?.pluginsDir).toBe(
      path.join('/opt/vinegar', 'prefixes', 'studio', 'drive_c', 'users', 'dev', 'AppData', 'Local', 'Roblox', 'Plugins'),
    );
  });

  test('generated place files go beside Vinegar in its own Flatpak data folder', () => {
    expect(vinegarPlaceFileDir(INSTALL)).toBe(
      path.join(HOME, '.var', 'app', 'org.vinegarhq.Vinegar', 'data', 'roqer-places'),
    );
  });

  test('the remediation command shares one folder for good', () => {
    expect(flatpakOverrideCommand(INSTALL, '/home/dev/My Places')).toBe(
      "/usr/bin/flatpak override --user --filesystem='/home/dev/My Places' org.vinegarhq.Vinegar",
    );
  });

  test('the remediation command survives the shell it is pasted into', () => {
    // Single quotes, so a folder named after a variable is shared and not
    // expanded; a quote in the name closes them, escapes itself, and reopens.
    expect(flatpakOverrideCommand(INSTALL, '/home/dev/$HOME `whoami`'))
      .toContain("--filesystem='/home/dev/$HOME `whoami`' ");
    expect(flatpakOverrideCommand(INSTALL, "/home/dev/it's mine"))
      .toContain("--filesystem='/home/dev/it'\\''s mine' ");
  });
});

describe('Vinegar path translation', () => {
  test("a host path becomes the Wine prefix's Z: view of it", () => {
    expect(toVinegarStudioPath('/home/dev/Documents/a.rbxl')).toBe('Z:\\home\\dev\\Documents\\a.rbxl');
    expect(toVinegarStudioPath('/home/dev/Documents/')).toBe('Z:\\home\\dev\\Documents');
    expect(toVinegarStudioPath('/home/dev/./a/../b.rbxl')).toBe('Z:\\home\\dev\\b.rbxl');
    expect(toVinegarStudioPath('/')).toBe('Z:\\');
  });

  test('a path Studio could not resolve is refused', () => {
    expect(() => toVinegarStudioPath('relative/a.rbxl')).toThrow(/absolute path/);
    expect(() => toVinegarStudioPath('/home/dev/a\0.rbxl')).toThrow(/null character/);
  });
});

describe('Vinegar sandbox reach', () => {
  test('the Flatpak filesystem entries are read from the Context section only', () => {
    expect(parseFlatpakFilesystems(SHOW_PERMISSIONS)).toEqual([
      'xdg-run/app/com.discordapp.Discord:create',
      'xdg-documents',
      'xdg-pictures',
    ]);
    expect(parseFlatpakFilesystems('[Environment]\nfilesystems=home;')).toEqual([]);
    expect(parseFlatpakFilesystems('')).toEqual([]);
  });

  test('user-dirs.dirs names the folders an xdg token resolves to', () => {
    expect(parseUserDirectories(
      [
        '# generated',
        'XDG_DOCUMENTS_DIR="$HOME/Dokumentit"',
        'XDG_PICTURES_DIR=~/Kuvat',
        'XDG_DOWNLOAD_DIR=""',
        'XDG_SOMETHING_DIR="$HOME/Else"',
        'not a setting',
      ].join('\n'),
      HOME,
    )).toEqual({ documents: `${HOME}/Dokumentit`, pictures: `${HOME}/Kuvat` });
  });

  test('entries resolve to host folders, and a withheld one is kept apart', () => {
    expect(resolveFlatpakFilesystems(
      ['home', 'xdg-documents', 'xdg-pictures:ro', 'xdg-run/app/x:create', '~/Projects', '/srv/places', '!~/Private', 'xdg-nonsense'],
      DIRECTORIES,
    )).toEqual({
      allowed: [
        HOME,
        `${HOME}/Documents`,
        `${HOME}/Pictures`,
        '/run/user/1000/app/x',
        `${HOME}/Projects`,
        '/srv/places',
      ],
      denied: [`${HOME}/Private`],
    });

    expect(resolveFlatpakFilesystems(['host'], DIRECTORIES).allowed).toEqual(['/']);
  });

  test("Studio can open a shared file, and never one outside what Vinegar can see", () => {
    const filesystem = resolveFlatpakFilesystems(parseFlatpakFilesystems(SHOW_PERMISSIONS), DIRECTORIES);

    expect(vinegarCanReadPath(`${HOME}/Documents/a.rbxl`, filesystem, INSTALL)).toBe(true);
    expect(vinegarCanReadPath(`${HOME}/Documents`, filesystem, INSTALL)).toBe(true);
    expect(vinegarCanReadPath('/tmp/a.rbxl', filesystem, INSTALL)).toBe(false);
    expect(vinegarCanReadPath(`${HOME}/Projects/a.rbxl`, filesystem, INSTALL)).toBe(false);
    // A folder whose name merely begins with a shared one is not shared.
    expect(vinegarCanReadPath(`${HOME}/Documents-old/a.rbxl`, filesystem, INSTALL)).toBe(false);
    expect(vinegarCanReadPath('a.rbxl', filesystem, INSTALL)).toBe(false);
  });

  test("Vinegar's own Flatpak data folder is always reachable", () => {
    const empty = { allowed: [], denied: [] };
    expect(vinegarCanReadPath(vinegarPlaceFileDir(INSTALL), empty, INSTALL)).toBe(true);
    expect(vinegarCanReadPath(INSTALL.pluginsDir, empty, INSTALL)).toBe(true);
    expect(vinegarCanReadPath(`${HOME}/Documents/a.rbxl`, empty, INSTALL)).toBe(false);
  });

  test('a withheld folder wins over a shared one that contains it', () => {
    const filesystem = resolveFlatpakFilesystems(['home', '!~/Documents/Secret'], DIRECTORIES);
    expect(vinegarCanReadPath(`${HOME}/Documents/a.rbxl`, filesystem)).toBe(true);
    expect(vinegarCanReadPath(`${HOME}/Documents/Secret/a.rbxl`, filesystem)).toBe(false);
  });
});

describe('Vinegar sandbox readings', () => {
  beforeEach(() => forgetVinegarSandboxFilesystem());
  afterEach(() => forgetVinegarSandboxFilesystem());

  test('one reading answers a whole launch, and a refused launch does not keep it', () => {
    let reads = 0;
    const probe = () => {
      reads += 1;
      return SHOW_PERMISSIONS;
    };

    expect(getVinegarSandboxFilesystem(INSTALL, probe, DIRECTORIES).allowed).toContain(`${HOME}/Documents`);
    getVinegarSandboxFilesystem(INSTALL, probe, DIRECTORIES);
    expect(reads).toBe(1);

    // A launch is refused, the user shares the folder the message named, and
    // the launch they try next has to see that they did.
    forgetVinegarSandboxFilesystem();
    const shared = [...SHOW_PERMISSIONS.split('\n')];
    shared[5] = 'filesystems=xdg-documents;/home/dev/places;';
    expect(getVinegarSandboxFilesystem(INSTALL, () => shared.join('\n'), DIRECTORIES).allowed)
      .toContain('/home/dev/places');
    expect(reads).toBe(1);
  });

  test('a host where the shares cannot be read reaches nothing but Vinegar itself', () => {
    const filesystem = getVinegarSandboxFilesystem(INSTALL, () => undefined, DIRECTORIES);
    expect(filesystem).toEqual({ allowed: [], denied: [] });
    expect(vinegarCanReadPath(`${HOME}/Documents/a.rbxl`, filesystem, INSTALL)).toBe(false);
    expect(vinegarCanReadPath(vinegarPlaceFileDir(INSTALL), filesystem, INSTALL)).toBe(true);
  });
});

describe('Vinegar reach refusals', () => {
  const FILESYSTEM = resolveFlatpakFilesystems(parseFlatpakFilesystems(SHOW_PERMISSIONS), DIRECTORIES);

  test('a file Studio can open is not refused', () => {
    expect(vinegarReachRefusal(
      INSTALL, FILESYSTEM, `${HOME}/Documents/a.rbxl`, 'Studio would open an empty window instead of that file',
    )).toBeUndefined();
  });

  test('a refused file names its own folder as the one to share', () => {
    const refusal = vinegarReachRefusal(
      INSTALL, FILESYSTEM, '/home/dev/places/a.rbxl', 'Studio would open an empty window instead of that file',
    );
    expect(refusal).toContain('cannot read /home/dev/places/a.rbxl');
    expect(refusal).toContain("--filesystem='/home/dev/places' org.vinegarhq.Vinegar");
  });

  test('a working directory names itself, not the folder above it', () => {
    const refusal = vinegarReachRefusal(
      INSTALL, FILESYSTEM, '/home/dev/work', 'Studio could not be started in it', '/home/dev/work',
    );
    expect(refusal).toContain('cannot read /home/dev/work');
    expect(refusal).toContain("--filesystem='/home/dev/work' org.vinegarhq.Vinegar");
  });
});

describe('Vinegar launch command', () => {
  test('Vinegar options precede the application, and Studio arguments follow it', () => {
    expect(buildVinegarLaunchCommand({
      install: INSTALL,
      studioArgs: ['--task', 'EditFile', '--localPlaceFile', 'Z:\\home\\dev\\a.rbxl'],
    })).toEqual({
      command: FLATPAK,
      args: ['run', 'org.vinegarhq.Vinegar', '--task', 'EditFile', '--localPlaceFile', 'Z:\\home\\dev\\a.rbxl'],
    });
  });

  test('an environment patch and a working directory reach Flatpak as its own options', () => {
    const launch = buildVinegarLaunchCommand({
      install: INSTALL,
      studioArgs: ['--task', 'EditFile'],
      workingDirectory: '/home/dev/work',
      environment: { set: { RBX_TEST: 'on' }, remove: ['DISPLAY'] },
    });
    expect(launch).toEqual({
      command: FLATPAK,
      args: [
        'run',
        '--unset-env=DISPLAY',
        '--env=RBX_TEST=on',
        '--cwd=/home/dev/work',
        'org.vinegarhq.Vinegar',
        '--task',
        'EditFile',
      ],
    });
    // Flatpak honours a run-time share only for the command that starts the
    // application, so a launch never grants one; what Studio may open is
    // decided beforehand against the shares the user has actually made.
    expect(launch.args.some((arg) => arg.startsWith('--filesystem'))).toBe(false);
  });
});

describe('Vinegar Studio processes', () => {
  // `pgrep -a -f RobloxStudioBeta.exe` as observed while Vinegar ran Studio:
  // the embedded browser names Studio's executable in its own arguments, so
  // matching the command line alone reports every helper as a Studio.
  const PGREP = [
    '134662 /home/dev/.var/app/org.vinegarhq.Vinegar/data/vinegar/versions/version-4f08/RobloxStudioBeta.exe --task EditFile --localPlaceFile Z:\\home\\dev\\Documents\\a.rbxl',
    '134839 C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\144.0\\msedgewebview2.exe --webview-exe-name=RobloxStudioBeta.exe --embedded-browser-webview=1',
    '134880 C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\144.0\\msedgewebview2.exe --type=gpu-process --webview-exe-name=RobloxStudioBeta.exe',
    '',
    'not-a-process-line',
  ].join('\n');

  /** What /proc reports as each of those processes' own program. */
  const PROGRAMS: Record<number, string> = {
    134662: '/home/dev/.var/app/org.vinegarhq.Vinegar/data/vinegar/versions/version-4f08/RobloxStudioBeta.exe',
    134839: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\144.0\\msedgewebview2.exe',
    134880: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\144.0\\msedgewebview2.exe',
  };

  test('a program whose path holds a space is still read as Studio', () => {
    // `pgrep -a` joins the arguments with spaces, so its output cannot say
    // where the program's path ends; /proc does.
    const line = '134662 /home/dev/My Vinegar/versions/version-4f08/RobloxStudioBeta.exe --task EditFile';
    const exe = '/home/dev/My Vinegar/versions/version-4f08/RobloxStudioBeta.exe';
    expect(parseVinegarStudioProcesses(line, () => '914327', () => exe)).toEqual([
      { id: 134662, startedAt: '914327', executable: exe, commandLine: line.slice('134662 '.length) },
    ]);
    // Without /proc the first word stands in, and a path holding a space is
    // not recognised rather than taken for another program's.
    expect(parseVinegarStudioProcesses(line, () => '914327', () => undefined)).toEqual([]);
  });

  test('only a process whose own program is Studio counts', () => {
    expect(parseVinegarStudioProcesses(PGREP, () => '914327', (id) => PROGRAMS[id])).toEqual([
      {
        id: 134662,
        startedAt: '914327',
        executable: '/home/dev/.var/app/org.vinegarhq.Vinegar/data/vinegar/versions/version-4f08/RobloxStudioBeta.exe',
        commandLine: '/home/dev/.var/app/org.vinegarhq.Vinegar/data/vinegar/versions/version-4f08/RobloxStudioBeta.exe --task EditFile --localPlaceFile Z:\\home\\dev\\Documents\\a.rbxl',
      },
    ]);
  });

  test('no Studio running reads as no process', () => {
    expect(parseVinegarStudioProcesses('', () => undefined)).toEqual([]);
    expect(parseVinegarStudioProcesses('0 /bad/pid/RobloxStudioBeta.exe', () => undefined)).toEqual([]);
  });

  test('a process that exited before it could be read keeps no start time', () => {
    expect(parseVinegarStudioProcesses(PGREP, () => undefined, (id) => PROGRAMS[id])[0].startedAt).toBeUndefined();
  });

  test('the start time is read past a program name holding spaces and parentheses', () => {
    // /proc/<pid>/stat: pid, (comm), then state onward. Field 22 is the start
    // time, which is the twentieth value after the closing parenthesis.
    const fields = ['S', '1', '1', '0', '-1', '4194304', '100', '0', '0', '0', '5', '2', '0', '0', '20', '0', '30', '0', '0', '914327'];
    expect(parseProcessStartTicks(`134662 (Roblox Studio (beta)) ${fields.join(' ')} 1234 5678`)).toBe('914327');
    expect(parseProcessStartTicks('134662 (bad)')).toBeUndefined();
    expect(parseProcessStartTicks('')).toBeUndefined();
  });
});

describe('an ending Vinegar session', () => {
  // `pgrep -a -f vinegar` as observed while Vinegar ran Studio: the bwrap
  // wrapper and Studio name vinegar in their arguments or paths, and only the
  // instance and the prefix's Wine server are the session that outlives Studio.
  const DATA = INSTALL.dataDir;
  const PGREP = [
    '557233 /usr/bin/bwrap --args 79 -- vinegar',
    '557248 vinegar',
    `557298 ${DATA}/kombucha/bin/wineserver --persistent=6`,
    `557350 ${DATA}/versions/version-67c8/RobloxStudioBeta.exe`,
    '600001 /usr/bin/wineserver --persistent',
    '',
  ].join('\n');
  const PROGRAMS: Record<number, string> = {
    557233: '/usr/bin/bwrap',
    557248: 'vinegar',
    557298: `${DATA}/kombucha/bin/wineserver`,
    557350: `${DATA}/versions/version-67c8/RobloxStudioBeta.exe`,
    600001: '/usr/bin/wineserver',
  };

  test("the session is Vinegar's own instance and its prefix's Wine server, nothing else", () => {
    expect(parseVinegarSessionProcesses(PGREP, INSTALL, (id) => PROGRAMS[id])).toEqual([
      { id: 557248, role: 'vinegar' },
      { id: 557298, role: 'wineserver' },
    ]);
    // A process gone before /proc was read is judged by its pgrep line.
    expect(parseVinegarSessionProcesses('557248 vinegar', INSTALL, () => undefined)).toEqual([{ id: 557248, role: 'vinegar' }]);
    expect(parseVinegarSessionProcesses('', INSTALL)).toEqual([]);
  });

  /** A clock and sleep that advance together, and a script of what each look sees. */
  function scripted(observations: Array<VinegarSessionObservation | Error>) {
    let clock = 0;
    const seen: number[] = [];
    return {
      seen,
      options: {
        observe: async () => {
          seen.push(clock);
          const next = observations.length > 1 ? observations.shift()! : observations[0];
          if (next instanceof Error) throw next;
          return next;
        },
        now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
        pollMs: 100,
        timeoutMs: 1_000,
      },
    };
  }
  const ENDING = { studioRunning: false, session: [{ id: 1, role: 'wineserver' as const }] };
  const IDLE = { studioRunning: false, session: [] };

  test('with nothing running, a launch goes at once', async () => {
    const run = scripted([IDLE]);
    await expect(waitForVinegarSessionEnd(run.options)).resolves.toBe('none');
    expect(run.seen).toEqual([0]);
  });

  test('a session still running Studio is live and takes the launch at once', async () => {
    const run = scripted([{ studioRunning: true, session: [{ id: 2, role: 'vinegar' }] }]);
    await expect(waitForVinegarSessionEnd(run.options)).resolves.toBe('studio-running');
    expect(run.seen).toEqual([0]);
  });

  test('a session whose Studio just exited is waited out before the launch', async () => {
    const run = scripted([ENDING, ENDING, ENDING, IDLE]);
    await expect(waitForVinegarSessionEnd(run.options)).resolves.toBe('ended');
    expect(run.seen).toEqual([0, 100, 200, 300]);
  });

  test('a session that does not end is waited for only up to the limit', async () => {
    const run = scripted([ENDING]);
    await expect(waitForVinegarSessionEnd(run.options)).resolves.toBe('timed-out');
    expect(run.seen.at(-1)).toBe(1_000);
  });

  test('a process table that cannot be read does not hold the launch', async () => {
    const run = scripted([new Error('pgrep missing')]);
    await expect(waitForVinegarSessionEnd(run.options)).resolves.toBe('unobserved');
  });
});
