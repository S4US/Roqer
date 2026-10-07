# The Studio MCP server

Roqer works in Roblox Studio through an MCP server and a Studio plugin. Both are
usable on their own from Codex, Claude Code, Cursor, or any other MCP client.
[Connecting a client](../studio-plugin/INSTALLATION.md) explains how to build,
install, and connect them; this page says what they can do.

## What it can do

### Inspect and edit a place

- Inspect place identity, instances, properties, attributes, project structure,
  scripts, and connected Studio instances.
- Apply atomic property updates and revision-aware script replacements or
  localized edits. Each script write is compiled without being run, and one
  whose source will not compile still lands but reports `syntaxError` with the
  line.
- Read and edit existing Lua/Luau source files in an explicitly bound
  [Rojo project](rojo.md), leaving synchronization to its existing Rojo connection.
- Run custom Luau in edit mode when a structured operation is not sufficient.
- Route every call to an explicit `instance_id` when multiple places are
  connected; see [Multiple connected places](configuration.md#multiple-connected-places).

### Debug and automate playtests

- Run Luau in live server and client VMs with `eval_server_runtime` and
  `eval_client_runtime`.
- Start and stop solo or multi-client sessions, inspect peer state, capture
  logs, and record non-pausing breakpoint hits.
- Simulate network and device conditions, inspect semantic runtime UI, and
  interact by semantic selector or bounded input.

### Animate characters and NPCs

- Check, build, publish, wire and verify R15 or R6 character animations with
  `animation`. `check` needs no Studio: it compiles a compact pose description
  and measures the motion. The pose description gives joint rotations, or where
  a limb points and how far it bends.
- `check` and `build` return a contact sheet image of the motion on the stock
  R15 rig. `build` writes a `KeyframeSequence` only after Studio has played it
  as checked, and it needs the last build's revision to replace one.
- `publish` uploads the animation through Open Cloud as the place's owner.
  `wire` sets it on a default `Animate` slot for every character. `verify`
  plays it on the playtest character. See [Character animation](animation.md).
- For an NPC, `rig` makes a stock R15 or R6 body with a loader inside it that
  plays its idle, walk and run as it moves. `wire` with `model` sets them, and
  `verify` with `model` walks or watches the NPC on the playtest's server. See
  [NPCs](animation.md#npcs).

### Collect evidence and diagnose performance

- Capture Studio screenshots, script and micro-profiler recordings, memory
  breakdowns, and scene-cost analysis.
- Export and import `.rbxm` files through explicit paths.
- Search, inspect, preview, sanitize, and insert Creator Store assets, and
  stage generated models for review; see
  [Creator Store assets](creator-store-assets.md).

### Read Roblox references

- Fetch official engine and Luau documentation with `get_roblox_docs`.
- Read installed Roblox Studio Assistant documents with `get_roblox_skills`.
  These are separate from Roqer's own skill pack in
  [`apps/desktop/agent`](../apps/desktop/agent).

The [tool definitions](../packages/core/src/tools/definitions.ts) are the
complete public reference, and [removed tools and parameters](deprecated-api.md)
lists what replaced older ones.

## Inspector edition

The inspector edition keeps the Studio DataModel read-only. Selection and
camera framing may change editor presentation; explicit exports and profiler
captures may write only to the requested local path.

It is enforced in three places: the inspector server exposes only read tools;
the bridge refuses a plugin of the other edition and will not forward requests
between editions sharing a port; and the inspector plugin itself answers only
the endpoints read tools use. One gap remains: two inspector reads
(`get_simulation_state` and `get_device_simulator_state`) run fixed Luau
snippets, so the inspector plugin still accepts Luau execution. Install only
one plugin variant at a time, and run the two editions on different ports
(`ROBLOX_STUDIO_PORT`) if you use both.

```powershell
npm run build:plugin:inspector
codex mcp add robloxstudio-inspector -- node C:\path\to\Roqer\packages\robloxstudio-mcp-inspector\dist\index.js --auto-install-plugin --plugin-path C:\path\to\Roqer\studio-plugin\MCPInspectorPlugin.rbxmx
```
