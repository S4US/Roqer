# Roqer Studio Bridge Installation

This project is installed from the repository checkout. Do not install the
published `@chrrxs/robloxstudio-mcp` package or its Creator Store plugin; those
belong to a different project and may not match this server.

## Build and install

Node.js 20 or newer is required. From the repository root:

```bash
npm install
npm run build:all
node packages/robloxstudio-mcp/dist/index.js --install-bundled-plugin --plugin-path studio-plugin/MCPPlugin.rbxmx
```

The installer copies `MCPPlugin.rbxmx` to the platform Studio Plugins folder:

- Windows: `%LOCALAPPDATA%\Roblox\Plugins\`
- macOS: `~/Documents/Roblox/Plugins/`

Set `MCP_PLUGINS_DIR` before running the installer to use a custom folder. Keep
only one MCP variant in that folder; installing the full plugin removes
`MCPInspectorPlugin.rbxmx` automatically.

Fully close and reopen Roblox Studio after installing or rebuilding the plugin.

## Connect an MCP client

The MCP client starts the Node server over stdio. Replace the example path with
the absolute path to your checkout.

### Codex CLI

```powershell
codex mcp add robloxstudio -- node C:\path\to\Roqer\packages\robloxstudio-mcp\dist\index.js --auto-install-plugin --plugin-path C:\path\to\Roqer\studio-plugin\MCPPlugin.rbxmx
```

### Claude Code

```powershell
claude mcp add robloxstudio -- node C:\path\to\Roqer\packages\robloxstudio-mcp\dist\index.js --auto-install-plugin --plugin-path C:\path\to\Roqer\studio-plugin\MCPPlugin.rbxmx
```

### JSON-configured clients

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\Roqer\\packages\\robloxstudio-mcp\\dist\\index.js",
        "--auto-install-plugin",
        "--plugin-path",
        "C:\\path\\to\\Roqer\\studio-plugin\\MCPPlugin.rbxmx"
      ]
    }
  }
}
```

Use an absolute Node executable path if the client cannot resolve `node`;
`where.exe node` on Windows or `command -v node` on macOS prints it.

The plugin and server must come from the same build. `--auto-install-plugin`
checks and installs the matching worktree artifact whenever the MCP client
starts the server.

[The Studio MCP server](../docs/mcp-server.md) lists what the tools can do and
describes the read-only
[inspector edition](../docs/mcp-server.md#inspector-edition), which installs
the same way from `packages/robloxstudio-mcp-inspector` and
`MCPInspectorPlugin.rbxmx`.

## Activate and verify

1. Open Roblox Studio after installing the plugin.
2. Open a place.
3. In the Plugins toolbar, click **Roqer** to open the panel if it is not
   already showing.
4. Confirm the panel reads **Connected** after the MCP client starts. It shows
   **Not connected** until then, **Connecting** while it looks for the bridge,
   and **Unavailable** after repeated failures.
5. Ask the client to call `get_connected_instances`.

The panel also carries the bridge address, editable only while disconnected.
The Roqer desktop app installs this plugin itself on every launch, so these
steps are only for running the bridge with another MCP client.

## Optional: allow third-party Creator Store assets

To preview or insert public Creator Store assets that you do not own, enable
**Allow Loading Third Party Assets** under **Game Settings > Security**. Roblox
disables this setting by default.

## Troubleshooting

### Plugin missing from the toolbar

- Verify `MCPPlugin.rbxmx` is in the correct Plugins folder.
- Remove a leftover `MCPInspectorPlugin.rbxmx`.
- Check that Studio is looking in that folder: `Studio.PluginsDir` in
  `%LOCALAPPDATA%\Roblox\GlobalSettings_13.xml` should name it. The live test
  suites point it elsewhere (see `tests/README.md`); the bridge repairs that on
  its next plugin install.
- Fully restart Studio.
- Check Studio's Output window for errors.

### Plugin remains disconnected

- Confirm the MCP client is running the local `dist/index.js`, not an npm package.
- Rebuild with `npm run build:all` and restart the MCP client.
- Let `--auto-install-plugin` reinstall the matching artifact, then restart Studio.
- Check that localhost port `58741` is not occupied or blocked.
- If the bridge was updated while Studio was open, Studio is still running the
  old plugin, and the bridge refuses a plugin of another version (HTTP 426 on
  `/ready`, logged once in Studio's Output as `/ready rejected`). The panel says
  **Restart Studio — Roqer updated the plugin while Studio was open**; plugins
  older than that say **Unavailable — Check that Roqer is open** for the same
  cause. Either way the fix is to restart Studio.
- After repeated failures the panel names the reason it saw — nothing answered
  at the address, the connection went quiet, the bridge restarted — and prints
  the last raw error under it. Quote that line when reporting a problem. A
  connection that keeps going quiet without closing is usually an antivirus
  web shield holding the stream; exclude Roqer and its bridge from it.

## Security and configuration

The bridge binds to `127.0.0.1:58741` by default. The full plugin can modify the
open place when a write tool is called. See the
[configuration guide](../docs/configuration.md) for authentication, custom
ports, custom plugin directories, and network settings.
