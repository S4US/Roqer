# Rojo projects

Roqer's script edit tools normally write only the copy of a script inside
Studio. If your place's code lives in a Rojo project, link it once and those
edits also land in the file Rojo syncs from, so they show up in `git diff` and
survive your next Rojo build. A place with no linked project behaves exactly
as it does without this page.

Linking does not create new script files, move or rename anything, or persist
models. It changes where an edit to an *existing*, Rojo-owned script is saved.

## What you need

- **Rojo 7.3 or newer on PATH.** Roqer runs `rojo --version` and `rojo
  sourcemap` itself; install Rojo with [Rokit](https://github.com/rojo-rbx/rokit)
  or however you already manage Roblox tooling.
- **`rojo serve` running** for the project you link, so file changes reach
  Studio.
- **The Rojo plugin connected** in Studio to that server. This is the
  community Rojo plugin, not Roqer's own Studio plugin; both run at once.

## Linking

Ask the agent to link your project, or call `manage_instance` yourself:

```json
{ "action": "link_project", "project": "C:\\Games\\Foo\\default.project.json" }
```

`project` is the path to the place's `*.project.json` — the one you'd pass to
`rojo serve`, not a nested project file. A successful link answers:

- `instance_id` — the connected place this project is now linked to;
- `project`, `root` — the project file's name and its folder;
- `rojoVersion` — the Rojo version Roqer found on PATH;
- `scripts` — how many scripts the project maps as `file`, `studio_only`,
  `generated`, or `unsupported` (see below);
- `problems` — up to five reasons a script came back `unsupported`;
- `rojoServer` — whether a Rojo server answers on the project's serve port
  (its `servePort`, or 34872 if it does not set one) and, if so, whether its
  project name matches. This is a diagnostic only, never proof that a given
  edit has synced.

Linking the same project to two different places is refused, since an edit
would then have two places to come from. `manage_instance` with `{ "action":
"unlink_project" }` removes a place's link. Links live only for as long as the
MCP server keeps running; they do not survive a restart, so relink after one.

## Which scripts are saved to files

Roqer walks the real `rojo sourcemap` for the project, the same tree Rojo
itself syncs from, to decide where a script's edits go:

- A script with exactly one `.lua` or `.luau` source file — including one
  named by an `init.luau`/`init.server.luau`/`init.client.luau` inside its
  folder, or by a `$path` rename where the instance's name does not match the
  file's — is **file-backed**. Edits save to that file.
- A script Rojo's project does not mention at all — one you made by hand in
  Studio — is **studio_only**. Edits keep writing Studio directly, as they
  always have.
- A file under a Wally `_Index` folder, or one your project's Git repository
  ignores (roblox-ts's `out/` and similar build output) is **generated**.
  Roqer won't save over build output; edit the source that produces it
  instead.
- Anything ambiguous is **unsupported**: two sibling instances sharing a name
  in the project or in Studio, a script with more than one source file or
  none of its own (for example one defined inside a model file), a file that
  resolves outside the project folder (including through a symlink), or a
  Studio class that does not match what the project builds there.

A nested project file (one `*.project.json` referenced from another) is
walked the same way as any other part of the tree, so scripts inside it are
classified exactly like scripts in the top-level project.

## What a result says

On a linked place, `get_script_source` adds:

- `file` — the script's source file, relative to the project folder;
- `persistence` — `file`, `studio_only`, `generated`, or `unsupported`;
- `fileMatchesStudio` — for a file-backed script, whether the file on disk
  currently matches what Studio holds.

`set_script_source`, `edit_script_lines`, `edit_script_batch`,
`insert_script_lines`, and `delete_script_lines` take no new parameters. On a
file-backed script, a successful edit adds `saved: { file, sync }`, where
`sync` is one of:

- `synced` — Studio has already picked up the change;
- `pending` — the file is saved, but Studio has not received it yet (Rojo
  serve may be stopped, or the plugin may not be connected); a `hint` says
  which;
- `diverged` — the file is saved, but Studio moved to some other content in
  the meantime; a `hint` says to read both sides before editing again.

Roqer never writes Studio directly to force a sync; it only waits briefly and
reports what it saw. On a `studio_only` script, the edit writes Studio exactly
as it always did, and the result adds `persistence: "studio_only"` and a
`note` explaining why.

## Conflicts and how to resolve them

An edit to a file-backed script can fail with nothing changed on either side:

- `rojo_conflict` — the file on disk and the script in Studio disagree (one
  of them, maybe both, changed since the agent last read it — including an
  unsaved edit still open in Studio's own editor). The result carries `file`,
  `fileRevision` and `studioRevision`, and, when both sides are short enough
  to compare, `differing` (the first line that differs, up to 80 lines from
  each side, and whether it was truncated). Read both sides, decide which one
  to keep, and retry.
- `rojo_write_failed` — the file could not be written at all, for example
  because it was deleted or is locked by another program. Nothing changed in
  Studio either.

An edit is also refused outright, with nothing changed, when the target
itself is the problem:

- `rojo_generated` — the target is build output your project doesn't treat as
  source.
- `rojo_unsupported` — the target is ambiguous or otherwise cannot be mapped;
  the error explains why.
- `rojo_bulk_edit_refused` — `find_and_replace_in_scripts` would have touched
  a file-backed, generated, or unsupported script. It lists up to ten of the
  affected files (and a count of any more) so you can switch to
  `edit_script_lines` or `edit_script_batch` per script instead, each one
  saved and checked on its own.

Two more codes can come back from either `link_project` or a later edit (an
edit re-reads the project's sourcemap every time, so a problem that appears
after you linked still shows up):

- `rojo_link_invalid` — the project path isn't an existing `*.project.json`,
  the project doesn't build a place, it's already linked to a different
  instance, the Rojo on PATH is older than 7.3, or `rojo sourcemap` failed.
- `rojo_not_found` — `rojo` isn't on PATH at all.

## Limitations

- `execute_luau` and other runtime eval can still change a script's source in
  Studio directly. The agent is told not to use them to get around a `rojo_*`
  refusal, but nothing stops arbitrary Luau from doing it anyway.
- New scripts, deletions, renames, and models are not persisted. A script
  your project doesn't know about is `studio_only`, and stays that way until
  you add it to the project yourself.
- Links are lost when the MCP server restarts; relink afterward.
- A small window remains between Roqer's last check of a file and the rename
  that saves it, so a save that races an edit made in that instant can still
  lose.
- One Rojo project can be linked to one place at a time.

## Using it from another MCP client

Everything above is the same `manage_instance`, `get_script_source`,
`set_script_source`, `edit_script_lines`, `edit_script_batch`,
`insert_script_lines`, `delete_script_lines`, and
`find_and_replace_in_scripts` calls Roqer's own agent uses, so linking and
editing work the same way from Claude Code, Codex, Cursor, or any other MCP
client connected to [the Studio MCP server](mcp-server.md). The read-only
inspector edition does not expose `manage_instance`, so a place connected
through it cannot be linked.
