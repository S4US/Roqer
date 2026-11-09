# Linux, through Vinegar

Roblox publishes no Linux build of Studio. [Vinegar](https://vinegarhq.org)
does: it keeps a Wine prefix, installs the Windows Studio into it, and runs it.
Roqer and the MCP server treat that as one more way Studio can run, so on Linux
the whole of Roqer works the way it does on Windows — the agent reads and edits
your place, playtests it, takes screenshots, and syncs Rojo files — with the
differences this page lists.

## What you need

- **Vinegar 1.9 or newer**, the Flathub build:

  ```bash
  flatpak install flathub org.vinegarhq.Vinegar
  ```

- **Studio installed in it.** Start Vinegar once, sign in, and let it download
  Studio:

  ```bash
  flatpak run org.vinegarhq.Vinegar
  ```

- **[Node.js](https://nodejs.org) 20 or newer**, and a model: ChatGPT with the
  Codex CLI, Claude with Claude Code, Gemini with the Antigravity CLI, or any
  OpenAI- or Anthropic-compatible endpoint. Roqer's **Install** button in
  Settings is Windows-only; on Linux install the CLI you use yourself, the way
  its own instructions describe.

Then build and start Roqer as the [README](../README.md) describes. It installs
its Studio plugin into the Wine prefix Vinegar runs Studio in:

```text
~/.var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio/drive_c/users/<you>/AppData/Local/Roblox/Plugins
```

Restart Studio once afterwards so it loads the plugin.

That folder is worth knowing, because it is not where Vinegar keeps the rest of
Studio's data. Vinegar points the prefix's `Local AppData` at its own `appdata`
folder, and Studio writes its settings, logs and caches there — but it resolves
its plugins folder from the Wine user profile instead, so a plugin in `appdata`
is never loaded and Studio's Plugins tab stays empty. Roqer installs into the
profile folder, which is the one Studio reads.

## Sharing your files with Studio

This is the one part of Linux setup with no equivalent on Windows, and the one
thing most likely to need your attention.

Vinegar runs inside a Flatpak sandbox. Its own folders are always reachable, and
Flathub's build also shares your **Documents** and **Pictures** folders — but
nothing else, including `/tmp`. A file outside what the sandbox can see does not
produce an error inside Studio; Studio simply opens an empty window. So the
server checks first, and refuses a launch it knows Studio could not fulfil,
naming the command that fixes it.

Share a folder with Vinegar once, and every later launch can reach it:

```bash
flatpak override --user --filesystem="$HOME/places" org.vinegarhq.Vinegar
```

A persistent override is the only reliable way. Flatpak also takes
`--filesystem` on `flatpak run`, but honours it only for the command that
actually starts the application, and Vinegar is usually already running, so
Roqer never shares a folder that way: a launch that worked once and failed the
next time would be worse than one that always says what to fix.

This matters for:

- **Place files you ask Roqer to open** (`manage_instance` with
  `local_place_file`, or opening a place from the app). A place under
  `~/Documents` needs nothing.
- **Rojo projects.** `rojo serve` runs on the host and the Rojo plugin reaches
  it over the network, which the sandbox shares, so syncing itself works
  wherever your project lives. Share the project folder as well if you also
  want Studio to open a place file from it.
- **Files you ask Studio to write**, such as an export or a profiler capture, if
  you want them somewhere other than Documents or Pictures.
- **A working directory you ask Studio to start in**
  (`manage_instance`'s `studio_working_directory`), which is refused the same
  way when the sandbox cannot reach it.

Generated baseplates need nothing: Roqer writes them into
`~/.var/app/org.vinegarhq.Vinegar/data/roqer-places`, inside Vinegar's own
Flatpak data folder, and sweeps them like it does on every other platform.

To see what Vinegar can currently reach:

```bash
flatpak info --show-permissions org.vinegarhq.Vinegar
```

## How a launch works

`manage_instance` launches Studio with `flatpak run org.vinegarhq.Vinegar`,
which forwards its arguments to `RobloxStudioBeta.exe` untouched. Vinegar
translates no paths, so Roqer sends each one in the form the prefix understands:
the prefix maps `Z:` to `/`, so `/home/you/a.rbxl` reaches Studio as
`Z:\home\you\a.rbxl`.

Two consequences are worth knowing:

- **A launch is not identified by the process it starts.** Vinegar owns a single
  application instance: when one is already running, a second `flatpak run`
  hands it the arguments and exits at once, so the command Roqer started is the
  launcher and not Studio. Roqer finds the Studio process by watching the
  process table for a new `RobloxStudioBeta.exe` whose command line names the
  place it just asked for, and records its start time from `/proc`, so a reused
  pid is never mistaken for it later. It waits up to 25 seconds, which covers
  Vinegar's update check and Wine setup; a first run that downloads Studio takes
  longer, and the launch then keeps no process id. `close` says so plainly
  instead of stopping something it does not own — close that Studio window
  yourself.
- **A relaunch waits for the last session to end.** For about a second and a
  half after Studio exits, its Vinegar instance and the prefix's Wine server are
  still shutting down. A launch in that window was lost (handed to the instance
  that was exiting) or started a Studio that hung before its first log line, and
  the plugin never connected. So when no Studio is running but that instance or
  Wine server still is, a launch waits for them to exit, for at most 15 seconds,
  and then goes ahead. With Vinegar's own settings window open and no Studio, a
  launch therefore waits the full 15 seconds.
- **Process identity cannot be retained.** `require_process_identity`, which on
  Windows holds a suspended Studio and proves its exact creation identity,
  reports `process_identity_unavailable` on Linux, as it does on macOS.
  `/health` reports `capabilities.studioLifecycle.studioRuntime` as
  `wine-vinegar` so a client can tell.

`close` sends `SIGTERM` to the Studio process, as it does on macOS.

## Differences from Windows

| | Windows | Linux through Vinegar |
| --- | --- | --- |
| Studio launch and close | yes | yes |
| Retained process identity | yes | no |
| Place, script, property, and playtest tools | yes | yes |
| Screenshots and profiler captures | yes | yes, written where the sandbox can reach |
| Rojo projects | yes | yes; share the project folder to open place files from it |
| Blender integration | yes | yes, with Blender on PATH, in `/usr/bin`, `/usr/local/bin` or `/snap/bin`, or chosen in Settings; not the Flatpak build |
| Texture previews before upload | yes | yes, staged into Vinegar's Studio install |
| Installing Codex or Claude Code from Settings | yes | no; install the CLI yourself |
| Studio updates | Roblox's updater | Vinegar's, on each launch |

Checked on Fedora 44 with Vinegar 1.9.4 and Studio 0.743: plugin install,
`manage_instance` launch and close, instance routing, `build_instances` and
`get_instance_properties` round-tripping a part, and a solo playtest reaching
edit, server and client peers with `eval_server_runtime` answering from the
running server.

Roqer has no account and no service of its own, so nothing else about a run
differs: the conversation goes to your own model provider and chats stay on your
computer.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_STUDIO_VINEGAR` | Unset | Set to `0` to keep the server from using Vinegar at all, leaving Studio unavailable unless `ROBLOX_STUDIO_EXE` names one. |
| `ROBLOX_STUDIO_VINEGAR_DATA_DIR` | `~/.var/app/org.vinegarhq.Vinegar/data/vinegar` | Vinegar's data folder, for a relocated or unpackaged install. Everything else — the prefix, the plugins folder, Studio's settings, the installed versions — is found inside it. |
| `MCP_PLUGINS_DIR` | The prefix's `AppData/Local/Roblox/Plugins` | Where the plugin is installed. |
| `ROBLOX_STUDIO_EXE` | Newest `version-*` under Vinegar's `versions` | Studio's executable. |

[Configuration](configuration.md) lists the rest.

## Troubleshooting

**Roqer says the plugin is not connected.** Restart Studio: it loads plugins at
startup, so a plugin installed while it was open is not running yet. Check the
plugin arrived:

```bash
ls ~/.var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio/drive_c/users/*/AppData/Local/Roblox/Plugins
```

**A launch fails with "Vinegar's Flatpak sandbox cannot read …".** Run the
`flatpak override` command the message gives, or move the place file under
`~/Documents`.

**A launch reports that Studio has no Linux build and no Vinegar install was
found.** `flatpak info org.vinegarhq.Vinegar` has to succeed from the same shell
the server runs in. A Vinegar installed per-user needs no extra setup; one
installed somewhere unusual needs `ROBLOX_STUDIO_VINEGAR_DATA_DIR`.

**Studio opens an empty window instead of your place.** That is the sandbox not
reaching the file. Share its folder as above.

**Vinegar's own log** is under
`~/.var/app/org.vinegarhq.Vinegar/cache/vinegar/logs`, one file per launch, and
reports which Studio version it ran and how it set the prefix up. Vinegar's
[troubleshooting page](https://vinegarhq.org/Vinegar/Troubleshooting.html)
covers graphics drivers, audio, and Wine itself.
