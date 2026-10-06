# tests/

Integration tests that drive the local full MCP server subprocess via stdio,
exercising real Studio behavior through the plugin. Each test
spawns its own subprocess and is responsible for cleaning up any playtest
state it starts.

## Prerequisites

1. **The built server dist** at `packages/robloxstudio-mcp/dist/index.js` —
   run `npm run build` when it is stale.
2. **Plugin build dependencies** under `studio-plugin/node_modules` — the first
   plugin build installs them from `studio-plugin/package-lock.json`, or run
   `npm ci --prefix studio-plugin` yourself. The managed Studio gates rebuild
   `studio-plugin/MCPPlugin.rbxmx` from the current worktree, then install that
   exact file into an isolated directory; they never download a published
   plugin as a fallback. Run `npm run build:plugin` before individual test
   scripts that reuse an already-open Studio instance.
3. **`HttpEnabled = true`** in Studio Experience Settings (Security tab).

## Run

**Feature completion gate:** a feature is not complete until
`npm run test:e2e` passes. This short gate exercises edit-mode tooling plus one
solo playtest covering edit, server, and client execution. Run the targeted
suite for any specialized area the feature changes.

```bash
# Required for every feature
npm run test:e2e

# Required before release; runs every live Studio suite
npm run test:e2e:full

# Full managed functional suite, without installer/lifecycle/isolation E2Es
npm run test:studio:runner

# Reuse a specific already-connected instance for the full functional suite
MCP_INSTANCE_ID=anon:... ROBLOX_STUDIO_PORT=43123 node tests/run-all.mjs

# Run an individual regression while iterating
node tests/execute-luau-error-preservation.mjs
```

The full gate does not launch the feature smoke separately: its complete
functional runner covers those checks in the same Studio session before the
independent auto-install, lifecycle, and parallel-isolation suites.

| Change area | Required live command |
|---|---|
| Ordinary feature | `npm run test:e2e` |
| Rojo linking or file-backed script edits | Feature gate plus `npm run test:rojo` and `npm run test:studio:rojo` (needs `rojo` on PATH and someone to connect the Rojo plugin) |
| Paths, properties, tools, runtime, simulation, or multiplayer | `npm run test:studio:runner` (replaces the smaller feature gate) |
| Installer, package artifacts, variants, or version repair | Feature gate plus `npm run test:e2e:auto-install` |
| Studio launch, takeover, or startup-log lifecycle | Feature gate plus `npm run test:e2e:lifecycle` |
| Port allocation, worker directories, or concurrent Studio isolation | Feature gate plus `npm run test:studio:parallel` |
| Release | `npm run test:e2e:full` (replaces all commands above) |

When `MCP_INSTANCE_ID` is unset, the runner starts the built MCP server as the
required primary on the configured port and gives it a random, run-scoped auth
token. Through authenticated `POST /mcp/manage_instance` calls, it snapshots
managed launches, stages a uniquely named baseplate, launches it with retained
process identity, authorizes and completes the launch, and waits for its edit
connection. Every child test receives the same port, token, and returned
instance ID. The `finally` cleanup closes the exact `launch_id`; an indeterminate
HTTP launch response is reconciled against the pre-launch snapshot and staged
place path. Supplying `MCP_INSTANCE_ID` instead keeps the caller-owned instance
open and skips all launch lifecycle calls.

For a self-contained run of the complete managed functional suite, including
all edit, playtest, runtime, proxy, simulation, and multiplayer tests, use:

```bash
npm run test:studio:runner
```

Independent worktree workers receive distinct leased ports instead of
accidentally proxying through each other's servers. Roblox Studio processes and
the installed plugin folder are global to the OS user, so destructive live
suites also take a cross-platform, heartbeating worktree lease. Multiple
worktrees may start the commands together; one waits while the other owns that
global mutation boundary, preventing plugin backup/restore and close-all races.
The lease keeps durable copies of the installed plugins and lifecycle fixture,
so a successor restores them before proceeding even if the prior test process
was killed.

### What the managed suites leave behind in Studio's settings

A managed suite points Studio at an isolated plugin folder by writing the
relative name `RsmcpIsolatedPlugins` into `Studio.PluginsDir` in
`%LOCALAPPDATA%\Roblox\GlobalSettings_13.xml`, and launches Studio with a
working directory that name resolves inside. It is left in place afterwards. A
Studio you then open normally resolves the same name against its own working
directory — `C:\Windows\system32` from the Start menu — finds no plugins there,
and shows no Roqer button. Roqer repairs the setting to the default folder on
its next launch, and so does the bridge when it installs the plugin without
`MCP_PLUGINS_DIR`; the symptom is only visible if Studio is opened before either
has run. To repair it by hand, close Studio and set that `QDir` back to
`C:/Users/<you>/AppData/Local/Roblox/Plugins`.

The Codex/WSL environment regression is non-destructive and does not launch
Studio. It starts the real source wrapper with `WSL_INTEROP` and
`WSL_DISTRO_NAME` removed, then verifies the broker's live lifecycle capability:

```bash
npm run build
npm run test:codex-wrapper
```

Each test prints `✅ PASSED` or `❌ FAILED` plus the failing assertion. On
failure the test's MCP subprocess stderr tail is dumped for context.

## Creator Store sanitizer unit test

The Creator Store import sanitizer has a separate Node-side behavioral suite
that does not require Studio. It covers 2,048-level nesting, Unicode and
zero-width names, `LuaSourceContainer`, `PackageLink`, preserved visual
instances, and fail-closed second-scan behavior:

```bash
npm run test:asset-security
```

## Managed runner profiles

`npm run test:studio:smoke` invokes `run-all.mjs --managed --smoke`; it runs the
two representative live tests used by the feature gate. `npm run
test:studio:runner` omits `--smoke` and runs all twelve functional tests. Both
ignore inherited instance or Studio worker selection, lease an isolated port,
install the matching main plugin, and own the primary server and Studio
lifecycle.

## Release smoke: regular Studio tools

`tests/studio-tooling-smoke.mjs` is the focused release smoke for the normal
main-plugin edit-mode tool surface. It auto-installs the local main plugin,
launches a temporary place through `manage_instance`, and verifies read, write,
script, tag, attribute, and execute tools. It does not rerun `run-all.mjs`.
Both managed runner profiles execute these assertions inside their existing
Studio session, avoiding a second install and launch. The focused command
remains available for iteration:

```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:studio:tools
```

## Release E2E: auto-install + Studio restart

`tests/auto-install-plugin-e2e.mjs` is a destructive release verification that
requires Studio to be closed first, installs the main and inspector plugins,
launches Studio through `manage_instance`, checks version/variant metadata,
verifies mismatch warnings, closes the explicit launched `instance_id`, and
restores the original plugin files.
Its subprocess runner bypasses the Windows `npm.cmd`/`npx.cmd` shims and invokes
their Node CLI entry points directly. It drains output through process close,
terminates the whole process tree on timeout, and turns pre-exit spawn failures
into immediate, causal errors instead of waiting indefinitely.

```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:e2e:auto-install
```

## Lifecycle regressions: fast relaunch and edit startup logs

`tests/studio-lifecycle-regressions.mjs` launches the same unpublished local
place twice with a persisted anonymous instance ID. It force-closes the first
Studio process, guarantees that the replacement receives an initial duplicate
409, and verifies automatic takeover and edit-tool routing. A temporary repro
plugin also emits errors before the MCP plugin installs its log listener so the
test can verify current-launch history seeding and prior-launch exclusion.

```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:e2e:lifecycle
```

The E2E defaults to freshly built local packed tarballs and prints
`artifactSource: local-pack`, so unpublished changes are what reach Studio.
Set `RSMCP_E2E_ARTIFACT_SOURCE=latest` to test the published release instead.
The self-contained auto-install, lifecycle, and tooling commands each lease an
open port and install a plugin configured for that port, so an unrelated MCP
server on the default port does not block targeted or full verification.
All destructive E2Es still require no Studio windows to be open and the
close-all environment variable remains an explicit opt-in.

Studio lifecycle helpers are available directly:

```bash
node scripts/studio-lifecycle.mjs status
RSMCP_E2E_CLOSE_ALL_STUDIO=1 node scripts/studio-lifecycle.mjs close-all
node scripts/studio-lifecycle.mjs launch
node scripts/studio-lifecycle.mjs wait-connected --variant main --version <expected-version>
```

## Animation spike

`tests/animation-spike.mjs` is step 2 of the [animation plan](../docs/animation-plan.md).
It is a research probe, not a regression test, and belongs to neither runner
profile. It answers five questions on a real Studio:

1. Can the stock R15 dummy be built in memory in edit mode?
2. Do temporary animation IDs play, in edit mode and in a playtest?
3. Does Open Cloud accept a `KeyframeSequence` exported from Studio as an
   Animation asset?
4. Can the just-published animation be read back and played?
5. Does the engine skip a weight-0 `Pose` that only keeps the hierarchy? The
   pose compiler writes the poses between the root and a keyed part that way.
   A weight-1 control shows the measurement can see the joint return to rest;
   without it the answer is "inconclusive".

```bash
npm run test:spike:animation

# Also upload one small test animation to your account (questions 3 and 4)
ROQER_SPIKE_UPLOAD=1 ROBLOX_OPEN_CLOUD_API_KEY=... ROBLOX_CREATOR_USER_ID=... \
  npm run test:spike:animation
```

The upload is off unless `ROQER_SPIKE_UPLOAD=1` is set, because it creates a
real asset. The key needs the Assets API with write access. The asset is named
"Roqer animation spike" and can be archived afterwards in the Creator Dashboard.

The answers are findings, not assertions. A "no" still exits 0; the script
fails only when it cannot ask a question or cannot clean up. It works in a
temporary `Workspace.__RoqerAnimationSpike` folder that it removes on every
path, and stops the playtest it starts. The report, which also records the
dummy's R15 joints (`Motor6D` or `AnimationConstraint`, whichever the rig uses)
and part sizes for the pose compiler, is written to
`tmp/animation-spike/report-<time>.json`.

## Animation calibration

`tests/animation-calibration.mjs` checks step 6's motion checks against a real
Studio. Like the spike, it belongs to neither runner profile.

```bash
npm run test:calibrate:animation
```

1. It starts a short playtest to read the animation IDs from the default R15
   `Animate` script on the character, then stops the playtest.
2. It fetches each animation and plays it on a fresh in-memory dummy in edit
   mode, stepped by hand. It compares every joint's `Transform` with core's
   sampler at the same moment. If Studio refuses to hand over the
   `KeyframeSequence`, the engine's samples stand in for it, and that
   animation gets no sampler comparison.
3. It also registers each fetched sequence as a temporary clip, as a preview
   would play it, and reports how far that playback strays from the
   published asset.
4. It builds probes with the pose compiler and plays them as temporary
   clips: one per easing style and direction, Linear keys over several arcs,
   and a Root offset. Each rotation probe's easing curve is judged against
   both slerp and a normalised lerp.
5. It runs the motion checks on every default animation. `walk` and `run`
   count as locomotion. The `mood` animation is skipped, because it moves the
   face, not the body.

It fails in any of these cases:

- an animation does not load;
- the sampler is off by more than 1° or 0.1 studs on a default animation;
- an easing curve is off by more than 0.05° under both interpolations;
- a compiled Root offset does not play as written;
- any default animation fails a check;
- cleanup fails.

It builds core first, because it imports the checks from
`packages/core/dist`. The report and the fetched sequences go to
`tmp/animation-calibration/`, which is not committed; only derived numbers go in
the plan.

## Creature spike

`tests/creature-spike.mjs` is step 1 of the [creature plan](../docs/creature-plan.md).
Like the animation spike, it is a research probe in neither runner profile. It
asks what Roblox does with a rig that is not a character:

1. Does a sequence keyed by part names drive `Motor6D`s made on a model that is
   not a character, under a `Humanoid` and under an `AnimationController`, in
   edit mode and in a playtest? Does a client see what the server plays, and
   can a client play on the model itself?
2. Under an `AnimationController`, must the top pose be named
   `HumanoidRootPart`, or does the root part's own name work?
3. How deep a chain (24, 64 and 128 joints), and how many joints in one
   keyframe (48, 128 and 256), does a sequence drive?
4. Does a copy of a model, made as a preview would make it, play as checked?
   Is a part that cannot be archived left out of the copy?
5. Does an NPC made with `CreateHumanoidModelFromDescription` carry an
   `Animate` script, and does it play anything outside a player's character?
6. Does `Humanoid:MoveTo` walk a four-legged Humanoid rig steadily at 8 and 16
   studs a second, and does `Running` report its speed?
7. With the upload on: how does an articulated creature uploaded as one GLB
   arrive? The spike writes the GLB itself (`tests/lib/creature-glb.mjs`), each
   piece a node with its origin at its joint, as Blender exports one, and
   inserts it twice: with no position, and with one, since the kit probe's lost
   layout may have been `insert_asset`'s doing. It lists the joints, bones and
   controllers the import came with, and whether the joints join the pieces as
   modelled, at their node origins, and it reads where the values in the
   importer's `InitialPoses` folder put their frames, in case those keep the
   pivots the joints lost. It reads the meshes back through
   `EditableMesh`, and publishes the dog's test animation, so question 1 can
   see a published animation reach the client.
8. With `ROQER_SPIKE_GENERATE=1`: does `generate_model`, given
   `schema_groups`, return a creature's pieces as separate, named parts? It
   also reports how they are jointed, which way the creature faces, and how
   far its pieces reach.

```bash
npm run test:spike:creature

# Also upload a test model and a test animation to your account (question 7)
ROQER_SPIKE_UPLOAD=1 ROBLOX_OPEN_CLOUD_API_KEY=... ROBLOX_CREATOR_USER_ID=... \
  npm run test:spike:creature

# Also try Roblox's model generator (question 8)
ROQER_SPIKE_GENERATE=1 npm run test:spike:creature
```

Type the key at a prompt rather than on the command line, where the shell's
history keeps it. In bash:

```bash
read -rs ROBLOX_OPEN_CLOUD_API_KEY && export ROBLOX_OPEN_CLOUD_API_KEY
```

In PowerShell:

```powershell
$env:ROBLOX_OPEN_CLOUD_API_KEY = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString)).Password
```

The answers are findings, not assertions: a "no" still exits 0. The spike fails
when a question could not be asked, because a probe errored, for example, or
when it cannot clean up. It works in temporary `__RoqerCreatureSpike` folders in
Workspace and ServerStorage, which it removes on every path, and stops the
playtest it starts. It also removes every model `generate_model` made under the
spike's name, even one that landed after its call failed, since Studio keeps
generating after a caller gives up; one still generating when the spike ends
lands afterwards. The uploads are named
"Roqer creature spike: model" and "Roqer creature spike: dog hold" and can be
archived afterwards in the Creator Dashboard. The report and the GLB go to
`tmp/creature-spike/`.

## Skinned spike

`tests/skinned-spike.mjs` opens step 7 of the [creature plan](../docs/creature-plan.md).
Like the creature spike, it is a research probe in neither runner profile. It
asks what Roblox does with a skinned mesh uploaded through Open Cloud:

1. Does a Model upload keep the armature, the bones and the weights, and how
   does it arrive: what parts, what bones under what, with what joints and
   controller?
2. How do a Blender bone's axes, +Y along the bone, arrive in a `Bone`?
3. How must a `KeyframeSequence`'s poses be named and nested to drive bones,
   in edit mode and on a playtest's server? This one is also asked, with no
   upload, of `Bone`s the spike makes under a plain Part.
4. Does `EditableMesh` hand over the bones and each vertex's weights?
5. What happens past the limits: a chain of 300 bones, and a mesh whose every
   vertex is weighted to eight bones? A refused upload is an answer here.

The spike writes the GLBs itself (`tests/lib/skinned-glb.mjs`): a snake, one
mesh skinned to a chain of bones the way Blender exports an armature.

```bash
npm run test:spike:skinned

# Also upload three test models to your account (every question but the made bones)
ROQER_SPIKE_UPLOAD=1 ROBLOX_OPEN_CLOUD_API_KEY=... ROBLOX_CREATOR_USER_ID=... \
  npm run test:spike:skinned
```

Set the key as the creature spike's section says. The answers are findings,
not assertions. The spike works in a temporary `__RoqerSkinnedSpike` folder in
Workspace, which it removes on every path, and stops the playtest it starts.
The uploads are named "Roqer skinned spike: base", "many-bones" and
"many-influences" and can be archived afterwards in the Creator Dashboard.
The report and the GLBs go to `tmp/skinned-spike/`.

## What each test exercises

| File | What it checks |
|---|---|
| `animation-tool.mjs` | `animation` checks a pose description without Studio, then builds it in a temporary ServerStorage folder: the preview plays as checked and leaves nothing in Workspace, the write reads back and is one undo step, a rebuild needs the current revision, a sequence edited after its build or not built by the tool is never replaced, and a failing motion check changes nothing. The guidance's wave, posed with `aim` and `bend`, builds and plays as checked, and its contact sheet looks at the front. It then checks the combat features against Studio: a swing split into in-betweens, keyframe markers built as `KeyframeMarker`s, the rig tables' grip attachments and an R6 dummy's `Motor6D`s, a weapon, sheath and off-hand animation on their stand-in motors, an R6 animation on an R6 dummy, a planted lunge (`aimAt`) and a two-handed swing (`grip`), each playing as checked. It wires Roblox's wave animation to the idle slot (a missing or changed current ID, or an edited loader, is refused), then verifies in a playtest that the built animation plays on the character as checked and that the idle slot holds and plays the wired ID. Publishing is refused without an Open Cloud key; with `ROQER_ANIMATION_UPLOAD=1` and a key it uploads one real test animation, reads it back, and verifies the published copy. Last, `rig` makes a stock R15 NPC in Workspace as one undo step, its loader holding the idle, walk and run its `Animate` script carried (a path that already names something is refused, and replacing a state needs its current ID), and in the same playtest `verify` walks it with `MoveTo` and sees the loader play the walk, paced to its speed, and then the idle; then the NPC's own `Patrol` script walks it back and forth, and `verify`, given only the model, watches that patrol and passes it. A model's own rig comes last: a Parts dog rigged by hand with `Motor6D`s and no declarations, with welded wedge ears, a ball nose and, when Studio can make one from its classic head mesh, a MeshPart collar. `check` reads its rig from Studio and reports the checks it has nothing to judge by as not checked; `build` plays its animation on a copy of the dog, which plays as checked and leaves the dog where it was; a weld to a part outside the dog is refused, naming it, before any copy is made; and in the playtest `verify` plays the animation on the dog on the server as checked. Then `rig` joins a second dog's loose pieces at their pivots as a quadruped in one undo step and reads it back (a rebuild needs the rig's current revision, a rig edited since and a pivot outside its pieces are refused), `aim` and `aimAt` move the rigged legs with every check passing on a copy and in the playtest, adopting the first dog declares its legs and changes none of its joints, and a dog rigged as an upload arrives is re-rigged only with `replace: "importer"`. It is in the managed runner, not the `test:e2e` smoke gate: run it alone with `npm run test:studio:animation` |
| `codex-wsl-environment.mjs` | The supported Codex wrapper validates Windows interop and advertises the retained process-identity launcher from a sanitized WSL environment without launching Studio |
| `eval-bridge-error-preservation.mjs` | `eval_server_runtime` / `eval_client_runtime` surface actual user errors instead of Roblox's generic `"Requested module experienced an error while loading"` wrapper for explicit errors, nil derefs, parser errors, and nested `require()` module-load failures |
| `eval-context-routing.mjs` | `execute_luau target=server/client-N` runs in plugin context on the selected peer, while `eval_server_runtime` / `eval_client_runtime` run through the server Script and client LocalScript eval bridges |
| `runtime-bridge-lifecycle.mjs` | Runtime eval bridges are created inside play DataModels, stay out of edit mode, work for managed and manually-started playtests, and direct multiplayer logs get peer attribution |
| `execute-luau-error-preservation.mjs` | `execute_luau` surfaces user error messages, parser errors, and nested `require()` module-load failures without leaking plugin-internal paths or Roblox's generic module-load wrapper |
| `proxy-mode-peer-fanout.mjs` | `get_runtime_logs target=all`, `get_connected_instances`, and `get_memory_breakdown target=all` return non-empty capture/peer data when invoked from a proxy-mode subprocess (the multi-session path) |
| `execute-luau-output-capture.mjs` | `execute_luau target=server` captures user `print()` and `warn()` calls in the response `output` array, matching the `target=edit` baseline; live structured `LogService` context is returned as `get_runtime_logs` entry `data` |
| `multiplayer-add-player-end-regression.mjs` | Starts one multiplayer client, adds a second client, and verifies `EndTest` disconnects both runtime peers |
| `multiplayer-test-lifecycle.mjs` | `multiplayer_test_start`, add-player, client-leave, state, and end-test flow against real StudioTestService multiplayer peers |

## Lifecycle and cleanup

- Most tests call `solo_playtest action=start` once at the top and `solo_playtest action=stop` in a
  `finally` block. The multiplayer lifecycle test uses `multiplayer_test_*`
  lifecycle tools and performs best-effort end-test cleanup in its `finally` block.
- Tests do not modify the place's persistent state — they only print, eval,
  and read from the runtime log buffer.
- `run-all.mjs` closes only the exact managed `launch_id` it created; a
  supplied `MCP_INSTANCE_ID` remains caller-owned and is not closed.

## Layout

- `lib/mcp-client.mjs` — shared utility for spawning + driving subprocesses
  via stdio JSON-RPC, plus minimal assertion helpers.
- `lib/mcp-http-client.mjs` — explicit-token authenticated direct calls to
  `/mcp/<tool>`, including structured HTTP/tool error handling.
- `lib/managed-studio-session.mjs` — owned-primary launch, process-identity
  handoff, lost-response reconciliation, reuse, and strict cleanup.
- `lib/studio-test-lease.mjs` — heartbeating, stale-owner-aware serialization
  and crash-recoverable plugin backups for parallel WSL/Windows worktrees.
- `<feature>.mjs` — one test file per concern, each runnable directly with
  `node`.
- `run-all.mjs` — manages a baseplate and runs the live suite sequentially.
