# Rojo projects

Roqer's script edit tools normally write only the copy of a script inside
Studio. If your place's code lives in a Rojo project, link it once and those
edits also land in the file Rojo syncs from, so they show up in `git diff` and
survive your next Rojo build. A place with no linked project behaves exactly
as it does without this page.

Linking changes where an edit to an existing, Rojo-owned script is saved, and
how `build_instances` and `set_properties` change what the project holds: new
scripts and models, removals, renames and moves are saved to the project's
files, and Rojo makes them in Studio.

## What you need

- **Rojo 7.3 or newer on PATH.** Roqer runs `rojo --version` and `rojo
  sourcemap` itself; install Rojo with [Rokit](https://github.com/rojo-rbx/rokit)
  or however you already manage Roblox tooling.
- **`rojo serve` running** for the project you link, so file changes reach
  Studio.
- **The Rojo plugin connected** in Studio to that server. This is the
  community Rojo plugin, not Roqer's own Studio plugin; both run at once.

## Linking from the Roqer app

The desktop app shows a Rojo pill next to the Studio connection pill in the
header; you never have to type a path there.

- **"Link Rojo project"** (dashed, accent-colored) means a Rojo server is
  already answering for the connected place — click it to open the popover,
  which shows the detected project (or Recent) with a **Link** button.
  Detection only checks Rojo's default port (34872) and the serve port of
  each project in **Recent**; a server on any other port shows up only after
  you link that project once, with **Choose a project file…**.
- **"Rojo · not linked"** (muted) means the place isn't linked and no server
  was found; open the pill for **Recent** projects (up to five, each with its
  own **Link** button) or **Choose a project file…**.
- **"Rojo · no place"** (muted) means no place is connected yet.
- **"Rojo · \<project file\>"** (green dot) means it's linked and Rojo is
  serving it.
- **"Rojo not running"** (amber dot) means it's linked but no server answers
  right now.
- **"Rojo · \<short problem\>"** (red dot) means the last link attempt
  failed; the popover has the full message, plus **Retry** and **Choose a
  project file…**.

Opening the pill while linked also shows **Open folder**, **Change
project…**, and **Unlink**.

For a **published** place, the app remembers the link (in a small file in
its own data folder) and relinks automatically the next time that place
connects — after Roqer restarts, after the bridge restarts, or after a
reconnect. An **unpublished** place's link only lasts until Studio closes;
nothing is remembered for it. If a remembered project file no longer exists,
the pill shows the error state with **Choose a project file…** and **Forget
this link**, rather than retrying the same path forever; a failed automatic
relink is also retried on the next bridge restart, reconnect, or **Retry**.

You can also just ask the agent to link the place for you — it opens the same
project picker, never typing a path itself, and reports back once you've
chosen a file or canceled.

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

If the file was saved but releasing its write lease failed, `saved` also
contains `lockReleaseWarning`. The edit did happen; read the result before
retrying rather than treating the warning as an unapplied write. A
`rojo_conflict` refusal carries the same warning when its lease could not be
released; the refusal, its revisions and its text stand. The warning names
the lease folder, and Roqer keeps retrying the release for about a minute.

Roqer never writes Studio directly to force a sync; it only waits briefly and
reports what it saw. On a `studio_only` script, the edit writes Studio exactly
as it always did, and the result adds `persistence: "studio_only"` and a
`persistenceNote` explaining why.

## New instances, removals, renames and moves

On a linked place, `build_instances` and `set_properties` first ask Studio
what the call would do, without changing anything. Whatever of it the project
owns, or would hold, is then saved to the project's files, and Rojo makes the
change in Studio. Roqer never also makes it in Studio: a new instance would
then appear twice once Rojo delivered the files, and a removal or rename made
only in Studio would be undone the next time Rojo syncs.

That covers:

- a new instance tree going into an instance the project gives a folder
  (`build_instances` `create` or `clone`);
- removing something the project's files make (`build_instances` `remove`,
  including removing a build root);
- renaming it (`build_instances` `set` with a `name`, or `set_properties`
  `Name`), and moving it into another project folder (`set_properties`
  `Parent`).

An instance has a folder when the project maps it with `$path` to a
directory, or when it sits in such a directory as a subfolder, including a
script stored as `Name/init.luau` and a folder holding its own
`default.project.json`. Roqer reads that from the project file (and any
nested project file it points to), never from where sibling files happen to
be.

### What a new tree becomes

- a tree with no script in it: one `Name.rbxm`, exactly as Studio
  serializes it (binary, so `git diff` shows that it changed, not what);
- a ModuleScript: `Name.luau`; a Script: `Name.server.luau`; a LocalScript:
  `Name.client.luau`;
- a script with children: a `Name/` folder holding `init.luau` (or
  `init.server.luau`, `init.client.luau`) and its children;
- a Folder that holds scripts: a `Name/` folder;
- any other instance that holds scripts (a Model, a Tool): a `Name/` folder
  with an `init.meta.json` naming its class, so its scripts stay files of
  their own; its children without scripts are `.rbxm` files in it.

A tree is serialized only once it is known to be saved, by a second plan
call that asks for it. The extension of new scripts follows whichever of
`.lua` and `.luau` the project's scripts already use most (packages under
`_Index` aside), `.luau` when tied. `emitLegacyScripts` is read from the
project file that governs the folder, the nested one when there is one,
since Rojo does not carry it into a nested project. With `"emitLegacyScripts":
false`, a Script with RunContext Client is `Name.client.luau`, and one with
RunContext Legacy or Server is `Name.server.luau`, which Rojo builds with
RunContext Server. New scripts are saved with LF line endings and no BOM, the
way Rojo delivers them.

### Removals

The instance's files go: a script's file and its `Name.meta.json`, a model
file, or the whole folder of a folder-backed instance. A folder goes only when
Rojo syncs everything in it (a `.gitkeep` aside); one that also holds other
files is refused, so nothing Rojo does not know about is deleted with it.
Every removed file or folder is moved, in one rename, to a backup folder
outside the project, under your system's temp folder in `roqer-rojo-backups`,
and the result names it in `saved.backup`. (A single rename matters: Rojo
7.7's server crashes on Windows when a folder's files are deleted before the
folder itself. When the backup folder is on another drive than the project,
the files are copied and then deleted instead, which can still trigger that
crash.) Studio's undo cannot bring a removal back; that copy, or Git, can. A
removal of more than 64 MB is refused, and so is a removal of anything that
holds instances only Studio has, since no file, and so no backup, would
keep them.

### Renames and moves

The instance's files are renamed, keeping their suffix: `Main.server.luau`
and `Main.meta.json` become `Boot.server.luau` and `Boot.meta.json`, and a
folder-backed instance's folder is renamed. A move puts them in the new
parent's project folder. Rojo makes the renamed instance afresh, so its
`instanceRef` no longer resolves; a `set_properties` result says so with
`instanceRefReplaced`.

### Checks before and after

Before a removal, rename or move, every script under the instance is compared
with its file. If Studio holds different text for one (an unsaved edit
included), the change is refused with `rojo_conflict` and nothing changes,
since Rojo would make the instance again from the file without it.

Once written, the files are read back through `rojo sourcemap`. If Rojo does
not make exactly the planned result from them (for example, a
`globIgnorePaths` pattern hides a new file), every change is undone and the
call is refused. While `rojo serve` runs, it may already have carried the
change, and then its undo, into Studio, which replaces those instances; such
a refusal says so, sets `studioMayHaveChanged`, and does not claim nothing
changed. Otherwise the result has:

- `saved`: `files` (new files), `removed`, `renamed` (`{from, to}`) and
  `backup`, all relative to the project folder except `backup`; `sync` is
  `synced` once Studio shows every change, `pending` while it does not (a
  `hint` says whether a Rojo server answers), or `diverged` when Studio holds
  something else at those paths; `scripts` gives each new script's path and
  the `revision` a read of it should show once Rojo has delivered it;
- `undoable: false`: Rojo made the change, so Studio's undo cannot take it
  back.

Only Studio answering that an instance is not there counts as a removal
delivered; a failed read leaves `sync` `pending`. While `sync` is
`pending`, Studio does not have the change yet. Wait, or get
Rojo serving and connected; do not make the change again.

### What stays in Studio

A call that touches nothing the project holds is applied in Studio exactly as
before, without running Rojo at all: a new tree going somewhere the project
has no folder (a service the project does not map, an instance written out in
the project file with no `$path`, an instance that exists only in Studio, or
a script saved as a single file), and any change to an instance the project
does not hold. When that leaves something unsaved that you may expect saved
(new scripts, an edit to a property of something the project owns, a change
to an instance inside a model file, or a Studio-only instance moved into a
project folder), the result adds `persistence: "studio_only"` and a
`persistenceNote` saying why. If the project file cannot be read, a new tree
without scripts and a property edit are applied in Studio with such a note,
and anything else is refused.

### Refusals

The whole call is refused, with nothing changed, when:

- it mixes changes saved to files with anything that stays in Studio. Send
  them in separate calls;
- a script, a Folder of scripts, or another container of scripts carries
  more than a name, class and source: tags, attributes, other properties, a
  position, rotation or scale, a cloned container (whose own properties a
  folder cannot carry), a disabled script, a Script whose RunContext needs a
  meta file, a LocalScript when `emitLegacyScripts` is false, or more script
  source than one plan carries (2,000,000 characters in all);
- a model could not be serialized, or the plan's models are larger than it
  carries (8,000,000 base64 characters in all);
- a name could not round-trip through a file name: characters a file name
  cannot hold, a trailing dot or space, a Windows-reserved name, `init`, or
  an ending Rojo reads as a file type, such as `.server` or `.json`;
- the name is already taken, in Studio, in the project, or by any file or
  folder Rojo would read under that name, ignoring case (a stale
  `Name.meta.json` included). Two new siblings whose names differ only in
  case are refused too;
- a rename or move also sets other properties, or would drop instances only
  Studio holds under it (Rojo remakes the instance from its files), or the
  new parent has no project folder, or the new name is already taken in
  Studio or the project;
- a move would take a Script or LocalScript into a part of the project
  governed by a different `emitLegacyScripts` setting, which would change its
  class or RunContext;
- a batch removes an instance the project owns and makes a new one by the
  same name in its place (as a scatter's `replace` does): remove it in one
  call, then build the new one in another;
- a file Rojo reads as another instance shares the instance's name (such as
  `Main.txt` beside `Main.server.luau`), so which files are meant is
  ambiguous; a file Rojo does not read at all is left where it is;
- the instance is written out in the project file itself (change it there),
  or is a nested project itself (a `*.project.json` file, or a folder holding
  `default.project.json`, named by the project's own `name`): rename or
  remove those yourself;
- the folder resolves outside the project folder (for example a `$path` of
  `../shared/src`, or a link out of it), as for edits to existing scripts;
- a path is ambiguous: another instance on it in Studio shares its name with
  a sibling, or Rojo's project makes two instances by one name on it, or
  Studio and the project disagree on the instance's class;
- the project file governing the folder sets `syncRules`, or one on the way
  to it does, so the file name Rojo expects cannot be known;
- a new or renamed file would be Git-ignored, or sits under `_Index`
  (`rojo_generated`); removing or renaming such a file is refused the same
  way;
- an instance holds more than 200 scripts to compare, or the change would
  wait on more than 50 scripts and instances in Studio at once.

If a change has to be undone and a file or folder cannot be put back (for
example someone saved into a new folder meanwhile, or a program holds a file
open), the error names it in `leftovers`, relative to the project folder, and
says to fix it by hand.

In the Roqer app, a `build_instances` call that removes anything (or a
scatter that replaces its previous group) asks before it runs, in every mode
but Full auto, whenever the app holds any Rojo link, since it may delete
project files. A place linked before it was published, or a call with no
place of its own, counts as linked too.

## Conflicts and how to resolve them

Roqer serializes writes to the same real source file across participating
processes that share a home folder (`HOME`/`USERPROFILE`), including paths through symlinks or junctions. After the first
writer saves, a second writer with the same old revision is refused. Writes
to different files can proceed independently. The shared leases live outside
the project in `~/.roqer/rojo-write-locks/v1`, keyed by the actual file path;
they do not depend on the bridge's port or managed-instance registry.
A busy lease returns `rojo_write_failed` immediately, naming the lease
folder, without a queued retry that could outlive a caller's timeout.
Read/retry after the current writer finishes. A live owner refreshes the
lease every 5 seconds. A lease older than 30 seconds is reclaimable only
when its recorded OS process creation identity has exited or its PID now
belongs to a different process, or when the bridge reclaiming it is the one
that left it behind after its request ended. An alive but paused owner
retains exclusivity. A stale lease folder with no owner file at all is what
a failed removal leaves (owner files are written under the same guard that
removal holds), so it is reclaimed too. Damaged, foreign-host, or
unverifiable owner metadata refuses takeover.

OS process identity observation can also be unavailable. Windows uses a
hidden, system PowerShell query with a 2-second limit, which fails every
time where PowerShell is blocked by policy (AppLocker, WDAC) or runs in
Constrained Language Mode. Saving does not depend on it: a bridge that
cannot observe its own process still saves, under an owner record marked
`unverified`, and tries the observation again after a minute. Another writer
takes over a stale `unverified` lease only once that PID is gone; while it
is running it cannot be told from a reuse of the PID, so takeover is
refused. A successful observation of the bridge's own creation identity is
cached for that process.

The final identity/lease checks and rename run synchronously, without an
event-loop yield or queued filesystem rename between them. Publication and
removal of lease metadata are serialized by a separate short `.guard`
directory. An interrupted guard is never automatically reclaimed. If a
damaged lease or guard remains, stop all bridge processes that can write the
project, confirm its recorded owner is stopped (coordinate with the recorded
host for a foreign-host record), then remove only that file's identified
lease/guard directory under `~/.roqer/rojo-write-locks/v1`. Keep the source
file. Do not remove these directories while a writer is alive.

Ordinary owner-publication I/O failures clean up only the just-created,
identity-verified metadata file and empty directory. When releasing a lease
fails (a heartbeat failure that makes the lock library forget this request,
another writer's `.guard` held for a moment, or a delete Windows refuses
briefly), Roqer retries the removal of its unchanged owned namespace for
about 1.5 seconds, then in the background for about a minute, so a live
bridge can retry. If I/O access is still broken
or cleanup ownership cannot be established, the refusal or saved-write
warning says recovery remains necessary.

The file and its parent directories are checked against their identities
from ownership resolution after the lease is taken and before replacement.
Replacing a file with equal text still requires a fresh read. If a parent
directory is replaced, Roqer also refuses to clean temporary files through
that new path; a temporary file in the moved original directory may remain.

External editors do not participate in this lease. Roqer checks their saves
before writing and again before renaming its temporary file, but an external
save after that final check can still race the rename. Older bridge versions
also do not take the lease; all concurrent Roqer writers must use a version
with this protection.

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
- Only `build_instances` and `set_properties` change what the project holds
  (see [New instances, removals, renames and moves](#new-instances-removals-renames-and-moves)).
  `import_rbxm`, `insert_asset`, `generate_model`, `animation`, and
  `execute_luau` still make their instances in Studio only, and a script your
  project doesn't know about is `studio_only` until you add it to the project.
- A change to an instance inside a model file (`.rbxm`, `.rbxmx`,
  `.model.json`), or to a property of anything the project owns, is made in
  Studio only, and Rojo can put the file's version back when it next syncs
  that file.
- A new model is saved as a binary `.rbxm`, which `git diff` cannot show line
  by line, and the scripts inside one are not files you can edit. A model
  holding scripts is saved as a folder instead, so its scripts stay files;
  anything set on the container itself is then refused, since a folder cannot
  carry it.
- Renames and moves are delivered by Rojo, which replaces the instance in
  Studio, so its `instanceRef` stops resolving. A removal or rename Rojo has
  not delivered yet cannot be confirmed by a later read. The
  Roqer app asks before any `build_instances` removal on a linked place.
- The desktop app knows of links it made (the Rojo pill, or the agent's
  `link_rojo_project`). While it holds none, a link made another way, such as
  `manage_instance link_project` called directly, does not make a removal ask
  first in Auto approve; the removal still deletes files. While it holds any,
  removals on every place ask first.
- A change Rojo has to undo after a running `rojo serve` already delivered it
  leaves Studio with fresh instances in place of the old ones.
- A batch cannot remove something the project owns and make a new one by the
  same name in one call, so a scatter's `replace` of a saved group needs the
  old group removed first.
- Links live in the MCP server's memory, so they are lost when that server
  process restarts; relink afterward (or pass `--rojo-project`, below, so a
  bare MCP client relinks itself). The desktop app is the exception: for a
  published place, it remembers the link itself and relinks it automatically
  whenever that place reconnects, including after the bridge restarts.
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
`insert_script_lines`, `delete_script_lines`, `build_instances`, and
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
claude mcp add robloxstudio -- node "C:\path\to\Roqer\packages\robloxstudio-mcp\dist\index.js" --rojo-project "C:\path\to\default.project.json"
```

This only applies once per server process: once it has linked successfully,
or failed and reported why, it is not tried again for the life of that
process — unlink and restart the server to retry. If another connected place
already holds that project, the flag has no effect for this one; link it by
hand once that place is unlinked. The inspector edition ignores the flag; it
has no `manage_instance` writes to link through.

With several places connected at once, this only links whichever place the
first script call's own `instance_id` names — core refuses to guess among
several connected places — so pass `instance_id` on that call, or keep only
one place open, for the lazy link to take effect at all.
