# Existing scripts in a Rojo project

The MCP bridge can read and edit the existing Lua/Luau files of one explicitly
bound Rojo place. Roqer uses the same script operations, approvals, source diffs,
and read-back verification as it does for Studio-owned scripts. Other Studio
tools continue through the Studio plugin.

This is an opt-in bridge configuration. Install Rojo 7 with `sourcemap
--absolute` support, keep your existing `rojo serve` process running, and connect
the Rojo Studio plugin to that project. Roqer does not start, stop, or configure
Rojo for you.

## Select the project and place

First connect the place to the MCP bridge and call `get_connected_instances`.
Use that place's exact `id`; the bridge does not infer it from a place name, a
port, a project name, or matching source text. Restart the bridge with both
variables set. For example, from the Roqer repository in PowerShell:

```powershell
$env:ROBLOX_STUDIO_ROJO_PROJECT = 'C:/path/to/game/default.project.json'
$env:ROBLOX_STUDIO_ROJO_INSTANCE_ID = 'the-id-returned-for-your-place'
# Optional if rojo is not on PATH; this is selected by the host, never a tool call.
$env:ROBLOX_STUDIO_ROJO_EXECUTABLE = 'C:/path/to/rojo.exe'
node packages/robloxstudio-mcp/dist/index.js
```

The configured bridge must own its primary port; a Rojo-configured process
refuses proxy fallback when that port is occupied. Other clients may use their
ordinary proxy processes: the primary routes their script calls through the
same file backend too. A proxy that observed this ownership keeps waiting if
the primary disconnects; it cannot promote itself into an unconfigured
Studio-only primary. Restart the configured bridge to resume that session.

The project path must be absolute. The selected project must describe a
DataModel, and writable sources must stay inside the directory containing the
project file. Only that exact edit-mode Studio instance uses the file backend.
Other instances retain their existing behavior. Use the server and plugin built
from the same source version.

Roqer can adopt a bridge you configured and started before the desktop app, or
its own bridge can inherit these variables when you launch Roqer from that
shell. An already-running bridge keeps its own configuration. No native Codex
tools, additional filesystem tool, renderer filesystem API, or Git access is
enabled by this setting. All Roqer script writes still pass through the runtime
approval policy.

## Read, edit, and verify

`get_script_source` resolves the live Studio instance first, then runs
`rojo sourcemap --include-non-scripts --absolute` without writing a sourcemap
file. Rojo owns the mapping: nested projects, init scripts, and ignore rules
are interpreted by Rojo itself. A mapped script's result identifies
`sourceOrigin: "rojo"`, the absolute `filePath`, its disk `revision`, and
`syncStatus: "synced"` or `"pending"`. Source and line ranges come from disk.
An instance absent from Rojo's graph is Studio-owned.

Use the existing `set_script_source`, `edit_script_lines`, `edit_script_batch`,
`insert_script_lines`, and `delete_script_lines`. **Every mapped-file write
requires `expectedRevision` from the disk read**, including the operations where
it is optional for Studio-owned scripts. Roqer supplies the revision its model
read for optional line editors; widening a partial read for a diff does not
silently refresh that revision. A standalone MCP client must pass it itself.

A write refuses changed file bytes or a changed source mapping. It also refuses
when Studio's live editor source differs from the disk source; resolve an
independent Studio edit or finish Rojo synchronization first. A private plugin
check revalidates Studio's source revision and instance identity and compiles
the proposed source without running or assigning it. Syntax errors still land
and are reported with the write, as for existing Studio script operations;
`syntaxCheck: "unavailable"` means no compile check was possible.

The host replaces the existing file atomically, preserves its UTF-8 BOM and
uniform newline convention (mixed conventions are refused), checks the mapping
and original file again immediately before replacement, and reads the resulting file back. Writes within this
bridge are serialized. The file check is optimistic concurrency: it does not
lock unrelated editors. Cooperating bridge processes take a host-owned write
lease for the actual file and compare it again inside that lease. A call has
an 18-second total budget, including queue time; caller cancellation and HTTP
disconnect prevent a queued or prepared write from later committing. A replace
already dispatched to the filesystem cannot be rolled back by cancellation.
Before replacing changed bytes, it
saves an immutable copy of the original file in
`~/.robloxstudio-mcp/rojo-backups/`; the write and Roqer's verification details
identify its `backupPath`. These recovery copies stay outside the Rojo project
and are not removed automatically. A backup failure prevents the write.

Rojo's existing connection then synchronizes the new file into Studio. A
successful write reports a disk change, not a Studio undo step. Roqer shows the
file path with the existing diff and verifies both the written disk revision
and matching source in Studio. A read-back gives Rojo a short bounded chance
to catch up; an unsynchronized result remains unverified until a later read
proves they match. The primary bridge rechecks the mapped scripts it has read or
written immediately before a solo or multiplayer start, after Roqer's approval.
This also protects a new desktop run and raw proxy starts. Its known-script
ledger is in memory; after restarting the bridge, read the relevant scripts
again before playtesting. Roqer refuses a new playtest start while a Rojo write remains
unverified. Do not collect playtest evidence from an unsynchronized
copy. Review or undo disk changes in your existing editor/Git workflow, or
restore the original bytes from the reported recovery file.

## Current boundaries

- Only existing, regular UTF-8 `.lua`/`.luau` source files up to 2 MiB are
  editable. Paths with symlinks/junctions, hard-linked files, paths outside the
  selected project directory, ambiguous dotted/duplicate instance paths, and
  scripts without one unique source file are refused. Source generated from
  JSON, TOML, or models is not supported by this script backend.
- A missing, malformed, oversized, or failed sourcemap never falls back to a
  Studio write. A previously mapped script removed from the source graph is
  refused too; this backend does not create or delete source files.
- Bulk `find_and_replace_in_scripts` is refused on the bound place. Use the
  revision-aware operations on each script instead.
- Structural Studio operations and arbitrary Luau retain their existing
  semantics. They do not create/delete/rename Rojo files and must not be used to
  manage mapped scripts or their ancestors. This configuration is not a global
  lock on Studio. The primary owns the file binding and applies it to proxy
  script calls; a different primary or arbitrary Studio code still needs the
  corresponding explicit project configuration.
- Project selection in the desktop UI, multi-project bindings, Rojo process
  management, generated TypeScript sources, and Git UI are follow-up work.

## Checks

The core unit suite exercises real filesystem writes, stale revisions, mapping
changes, ambiguous paths, link boundaries, encoding, batches, and cleanup. The
desktop unit suite checks file diffs, conflict retries using the model's
observed revision, and that pending sync is not verified.

With Rojo on PATH, `npm run test:rojo` additionally uses the real CLI with a
temporary project to exercise server scripts, module/init scripts, nested
projects, ignore rules, disk read-back, and stale revisions. It does not launch
Studio, use an existing project, connect to `rojo serve`, or claim live sync
evidence: the Studio peer is simulated. It also runs the actual HTTP client,
`RunSession`, and Studio tool runner through diff, approval and verification,
including a new run and a disk edit during approval. These cross-layer checks
still use a simulated Studio peer and do not execute a real playtest.

The ordinary live tooling gate is `npm run test:studio:runner`, as described in
[tests/README.md](../tests/README.md). Complete Rojo synchronization also needs
an independent temporary project with Rojo and Studio connected: prove that a
disk edit reaches the correct script, preserves a concurrent edit as a conflict,
and produces a fresh playtest. Do not run a live suite against your working
game or assume the simulated peer proves these behaviors.
