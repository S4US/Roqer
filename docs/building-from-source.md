# Building from source

Node.js 20 or newer is required.

```bash
npm install
npm run build:all
```

`npm run build:all` builds the Node packages and both Studio plugin variants.
The first plugin build installs the Studio plugin's own build tools (roblox-ts), which live in a separate npm project under `studio-plugin/`. To install them by hand, run `npm --prefix studio-plugin ci`.

The first plugin build downloads Roblox's [LibMP](https://github.com/Roblox/libmp),
which the micro-profiler uses, into `studio-plugin/include/LibMP.lua` and checks
it against the SHA-256 pinned in `scripts/fetch-libmp.mjs`; it is not committed
because its repository carries no licence. To build offline, set `LIBMP_PATH`
to a copy of the release's `LibMP.luau`. If Roblox has published a newer LibMP,
the build stops and says so; update the pin after checking it.
To install the full plugin from this worktree without starting the server:

```bash
node packages/robloxstudio-mcp/dist/index.js --install-bundled-plugin --plugin-path studio-plugin/MCPPlugin.rbxmx
```

The MCP client should start the built server at
`packages/robloxstudio-mcp/dist/index.js`. See
[Connect an MCP client](../studio-plugin/INSTALLATION.md#connect-an-mcp-client)
for client configuration examples.

On WSL the `.rbxmx` is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`, and the local build script removes the other plugin variant from that folder. Set `MCP_PLUGINS_DIR` to override. **Fully close and reopen Studio** after a plugin rebuild, and verify only the one variant you intend to test remains in the Plugins folder.

Do not leave both `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` in the Studio Plugins folder; Studio loads both and they can register duplicate runtime peers.

## Desktop app and installer

`npm run build:desktop` builds the renderer and the esbuild main-process bundle,
and `npm run start:desktop` builds the app and starts it. For renderer
development with hot reload, use `npm run dev:desktop`. A plain browser runs
the renderer in a clearly labelled demo mode with no real agent.

`npm run package:desktop` goes further: it builds the plugin artifact, the MCP
server, and the renderer, stages the bridge Roqer ships, and produces the
Windows NSIS installer under `apps/desktop/release`.

Package from a clean `npm ci`. Staging resolves the bridge's runtime
dependencies from the root install and verifies every dependency it inlines —
nested ones included — against the committed `package-lock.json`, so an ad-hoc
or stale `node_modules` is refused rather than shipped.

The installer is not code-signed, so Windows SmartScreen warns on its first
run. macOS and Linux targets are configured in `apps/desktop/electron-builder.yml`
but have not been built. A packaged build checks this repository's GitHub
Releases for updates; see [Updates](configuration.md#updates).

## Feature completion gate

A feature is not complete until the short live Studio gate passes:

```bash
npm run test:e2e
```

This checks representative edit-mode, playtest, server, and client behavior.
Before launching Studio, the gate recompiles and assembles
`studio-plugin/MCPPlugin.rbxmx` from the current worktree, then installs that
exact file into its isolated plugin directory. The artifact-only build does
not alter your normal Studio plugin folder, and the test installer never
downloads an external release.
Run the targeted E2E for any specialized subsystem the feature changes. The
auto-install, full functional, lifecycle, and parallel-isolation suites are
reserved for relevant changes and the release gate:

```bash
npm run test:e2e:full
```

See [`tests/README.md`](../tests/README.md) for the selection guide and
individual commands.
