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
  `generated`, or `unsupported` (see below). `studio_only` is always 0 here:
  the sourcemap only lists scripts the project owns, so it cannot count a
  script you made by hand in Studio; those show up as `studio_only` when a
  later call reads or edits them, not in this count;
- `problems` — up to five reasons a script came back `unsupported`;
- `rojoServer` — whether a Rojo server answers on the project's serve port
  (its `servePort`, or 34872 if it does not set one) and, if so, whether its
  project name matches. This is a diagnostic only, never proof that a given
  edit has synced. With Rojo 7.7+, the server's reply is not JSON, so
  `matches` may be absent even though a server does answer.

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
- `persistence` — `file`, `studio_only`, `generated`, `unsupported`, or
  `unknown` when Rojo's sourcemap could not be read (for example `rojo`
  disappeared from PATH after linking); a `rojoError` field then says why;
- `persistenceNote` — why, when `persistence` is not `file` (for example why
  a script is `studio_only` or `generated`); separate from the plugin's own
  `note`, if the result also has one;
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
`persistenceNote` explaining why.

## Conflicts and how to resolve them

An edit to a file-backed script can fail with nothing changed on either side:

- `rojo_conflict` — the file on disk and the script in Studio disagree (one
  of them, maybe both, changed since the agent last read it — including an
  unsaved edit still open in Studio's own editor). The result carries `file`,
  `fileRevision` and `studioRevision`, and, when both sides are short enough
  to compare, `differing` (the first line that differs, up to 40 lines from
  each side, and whether it was truncated). To keep the file, reconnect the
  Rojo plugin so Studio takes the file, then retry. To keep Studio's version,
  copy its text into the file, then retry. Rojo cannot copy Studio's text back
  to the file.
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
- Links are lost when the MCP server restarts; relink afterward. Saving links
  across restarts is a planned follow-up.
- Links belong to one MCP server process; the desktop app and another MCP
  client connected to the same place do not share them, so link in whichever
  one you're editing from.
- A small window remains between Roqer's last check of a file and the rename
  that saves it, so a save that races an edit made in that instant can still
  lose.
- One Rojo project can be linked to one place at a time.
- Without Git, or outside a Git repository, build output such as roblox-ts's
  `out/` is treated as source unless it's under a Wally `_Index` folder; only
  a Git-ignored path is recognized as generated.
- If the project keys a service under a name other than its class name (for
  example `"SSS": {"$className": "ServerScriptService"}`), its sourcemap node
  is named `SSS`, but a built-in service's name in Studio is always its class
  name; the two cannot match, so scripts under it are reported `studio_only`.
- Rojo delivers LF to Studio, with no BOM, whatever line endings or BOM the
  file on disk has. Roqer compares the file and Studio ignoring line endings
  and a BOM, and writes a saved file back in its own style: CRLF stays CRLF,
  LF stays LF, and a BOM stays, across the whole file, not just the lines the
  edit changed.
- A file with mixed line endings is written back entirely in whichever style
  (CRLF or LF) already has the most line breaks in it; a line in the other
  style, even one the edit never touched, comes back changed.

## Troubleshooting

- **`rojo --version` fails with "Failed to find tool 'rojo' in any project
  manifest file"**: a Rokit-managed `rojo` with no `rokit.toml` in the
  project folder has nothing to run. Roqer reports this as `rojo_not_found`;
  run `rokit add rojo-rbx/rojo` in the project folder, or install it globally
  with `rokit add --global rojo-rbx/rojo`.
- **The Rojo Studio plugin can't parse the sourcemap**: its version has to
  match the `rojo` CLI you serve with. Update whichever one is behind. The
  Creator Store plugin currently needs Rojo 7.7: against a 7.6.1 server it
  fails with "attempt to index number with 'protocolVersion'", and a 7.6.1
  plugin against a 7.7 server shows "Can't parse JSON".
- **`manage_instance` rejects `link_project` as an unknown action**: the
  running bridge predates this feature. Close other Roqer or Codex bridges
  and restart Roqer; this is not a Studio plugin problem.

## Using it from another MCP client

Everything above is the same `manage_instance`, `get_script_source`,
`set_script_source`, `edit_script_lines`, `edit_script_batch`,
`insert_script_lines`, `delete_script_lines`, and
`find_and_replace_in_scripts` calls Roqer's own agent uses, so linking and
editing work the same way from Claude Code, Codex, Cursor, or any other MCP
client connected to [the Studio MCP server](mcp-server.md). The read-only
inspector edition does not expose `manage_instance`, so a place connected
through it cannot be linked.

## Linking automatically from an MCP client

A client that has no way to call `manage_instance` itself — or whose agent
you'd rather not teach to type a path — can start the server with
`--rojo-project <path>` (or the `ROQER_ROJO_PROJECT` environment variable) to
name a project up front. Core then links the connected place to it lazily,
the first time a script read or write would otherwise need a link, so you
never have to send `link_project` by hand:

```sh
claude mcp add robloxstudio-mcp -- npx -y robloxstudio-mcp --rojo-project "C:\Games\Foo\default.project.json"
```

This only applies once per server process: once it has linked successfully,
or failed and reported why, it is not tried again for the life of that
process — unlink and restart the server to retry. If another connected place
already holds that project, the flag has no effect for this one; link it by
hand once that place is unlinked. The inspector edition ignores the flag; it
has no `manage_instance` writes to link through.
