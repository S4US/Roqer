# Configuration

This file covers the MCP bridge and the Roqer desktop app.

## Custom MCP connections in Roqer

Open **Settings → MCP** to add a connection. Roqer supports stdio servers
started on this computer and Streamable HTTP servers reached at an MCP URL.
Remote URLs require HTTPS; HTTP is accepted only on loopback. Legacy SSE
endpoints and OAuth sign-in are not supported in this first version.

For stdio, enter the executable separately from its arguments. For example,
use `npx` as the command and `["-y", "@modelcontextprotocol/server-filesystem", "C:\\MyProject"]`
as the argument JSON. Starting or checking the connection runs that executable
with your computer's permissions. Choose only servers you trust. Optional
environment variables are a JSON object of strings.

For HTTP, enter the complete MCP URL, such as `https://example.com/mcp`.
Optional headers are a JSON object of strings, for example
`{"Authorization":"Bearer YOUR_TOKEN"}`. Redirects are refused so credentials
cannot silently move to a different endpoint.

Environment variables and headers are encrypted with the operating system's
secret storage. Settings shows only their saved names. Leave a secret field
blank to keep it, enter a JSON object to replace it, or use **Clear**. Changing
the URL, executable or arguments requires re-entering or explicitly clearing
saved secrets. If encrypted storage is unavailable, connections without
secrets still work.

**Check** initializes the server and reads its tool catalog without calling a
tool. Enabled connections are available through the `mcp` tool to ChatGPT,
Claude and Custom models. The model lists servers, describes a tool's schema,
then requests a call. External calls appear in run activity and require an
explicit approval, including in Full auto. Read only refuses them; a server's
read-only annotation does not grant permission.

Each run owns its connections and closes them when it ends. Editing, disabling
or removing a connection stops later dispatch from that run; start a new run
to use the new settings. Cancellation stops waiting and prevents later calls,
but cannot undo effects an external server has already applied. Calls are not
automatically replayed. Catalogs, response bytes and model-visible results are
bounded; resources, prompts, sampling and elicitation are not exposed.

## Local HTTP bridge

The bridge binds to `127.0.0.1` by default and rejects cross-origin browser
requests unless their origin is explicitly allowed. The normal stdio MCP
transport is unaffected by HTTP authentication.

HTTP endpoints that can invoke tools (`/mcp`, `/mcp/<tool>`, `/proxy`,
`/instances`, and `/unregister-instance-id`) require a shared-secret token. The
server creates one at `~/.robloxstudio-mcp/auth-token` on first run and uses
mode `0600` on platforms that support POSIX permissions. HTTP MCP clients can
send the token as either:

```text
X-MCP-Auth: <token>
Authorization: Bearer <token>
```

Plugin-facing endpoints (`/ready`, `/events`, `/response`, and `/disconnect`)
remain tokenless because Roblox Studio plugins cannot read the local token.
The plugin receives queued bridge messages over a persistent `/events` stream
and posts results to `/response`. These endpoints cannot directly invoke tools.
Passive health and status endpoints are also tokenless.

Setting `ROBLOX_STUDIO_HOST` to a non-loopback address exposes the bridge to
other machines. Only do this on a trusted network, retain token authentication,
and treat the token as a secret.

## Multiple connected places

Connect every open Studio place to the same MCP server URL. The server tracks
each connection; call `get_connected_instances` to receive compact
`{ id, name, roles }` rows, then pass a row's `id` as `instance_id` to route a
tool call to that game. Per-place port tabs such as `58742` are not the
supported routing model.

## Version compatibility

The Studio plugin and MCP server must have the same version. `/ready` rejects a
mismatched plugin rather than keeping an unsupported protocol pair connected.

Restart the MCP server with `--auto-install-plugin`, then fully close and reopen
Studio to load the matching bundled plugin.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROBLOX_STUDIO_HOST` | `127.0.0.1` | HTTP bridge bind address. |
| `ROBLOX_STUDIO_PORT` | `58741` | HTTP bridge port. |
| `ROBLOX_STUDIO_AUTH_TOKEN` | Auto-generated token file | Explicit shared secret that overrides the token file. |
| `ROBLOX_STUDIO_NO_AUTH` | Unset | Set to `1` or `true` to disable HTTP tool authentication. This is not recommended. |
| `ROBLOX_STUDIO_ALLOWED_ORIGINS` | None | Comma-separated browser origins allowed to call the HTTP API cross-origin. |
| `ROBLOX_OPEN_CLOUD_API_KEY` | None | Roblox Open Cloud key used by features such as audio preview, place version access, and `upload_asset`. Required permissions depend on the tool. Roqer users set it in Settings → Roblox → Open Cloud instead; see below. |
| `ROBLOX_CREATOR_USER_ID` / `ROBLOX_CREATOR_GROUP_ID` | None | The user or group `upload_asset` publishes as when the call names neither. A group wins when both are set. |
| `MCP_PLUGINS_DIR` | Platform Studio Plugins folder | Override the destination used by plugin installation. |
| `ROBLOX_STUDIO_EXE` | Auto-discovered | Path to `RobloxStudioBeta.exe` for `manage_instance` when discovery under the Roblox `Versions` folder fails, or on a platform without discovery. It is the only way to choose the executable: tool callers cannot. |
| `ROBLOX_STUDIO_REQUIRE_PRIMARY` | Unset | Set to `1` to refuse proxy mode when the primary port is taken, instead of starting a follower that promotes itself when the port frees. |
| `ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS` | `5000` | How often a follower checks whether it can take the primary port. |

Creator Store audio preview requires `asset:read` permission. See
[Creator Store assets](creator-store-assets.md) for its download and validation
behavior.

Creating an asset requires `asset:write`; checking the returned operation and
its moderation result requires `asset:read`. When an upload is still processing
after the initial bounded wait, `upload_asset` returns its `operation_id` and
action `status` checks that same operation later without uploading a duplicate.
A Decal's result also carries `imageId`, the ID an `ImageLabel` displays (the
`decalId` does not). It is looked up through the Studio place named by
`instance_id`; when several places are open and none is named, or Roblox has
not finished processing the image, it is null, and a later `status` check that
finds the Decal finished looks it up again.

## Roqer desktop

Roqer needs no account and no service. A run uses the provider chosen in the
composer: the user's own ChatGPT subscription through the Codex app, their
Claude subscription through Claude Code, or a model endpoint they configure in
Settings. One run can be active across the app at a time, against one Studio
place.

The ring in the composer's corner shows how full the model's context window
was at its latest response in the chat, as the provider reported it: Claude
Code and Codex report both the tokens in use and the window's size, and a
configured endpoint reports the tokens while the window is the one set for the
model in Settings. Roqer never estimates either number. A chat with nothing
reported, or a model with no known window, says so instead of showing a share.
The ring turns amber at 70% and red at 90%, and clicking it shows the figures
and who reported them. Readings are not saved: after a restart, the meter
fills in again with the chat's next response.

A finished run shows under its result how many tokens it used, as the
provider reported them, and the figure is saved with the chat. It lists input
read from the prompt cache, input written to it, new input and output, then
the number of requests and a price when the provider gives them.

- **Claude Code** reports every figure, including its subagents' tokens,
  though its request count covers only its main agent. Its price is its own
  estimate at API list prices: on a subscription it is a yardstick for
  comparing runs, not what you pay.
- **Codex:** Roqer counts the thread's input, cache reads and output. There is
  no request count or price, and cache writes are not shown apart.
- **A configured endpoint** is counted the same way as Codex, with the number
  of responses as its requests.

A run stopped before its provider reported anything shows no figure, never a
zero.

ChatGPT runs use a Codex home of Roqer's own, inside Roqer's data folder, so
Roqer asks you to sign in to ChatGPT once even if the Codex CLI is already
signed in, and your own Codex MCP servers and plugins are not loaded there.
Codex's own tools, such as its shell, web search and image viewer, are turned
off, so the model acts through Roqer's tools and approvals. Codex's file editor
cannot be turned off, but Codex runs read-only, so any edit it tries is refused.

A model endpoint you configure runs on Roqer's own agent loop. The next
message in the same chat continues the conversation it left, tool results
included, as the ChatGPT and Claude providers do. The conversation is not kept
after a run that failed or was stopped, after half an hour idle, when the run's
connection, model, or settings differ, or once connections are edited.

When the endpoint fails in a way that can pass (a rate limit, an overload, a server
error, or a connection dropped partway through a turn), Roqer sends the same
turn again up to four times. It waits as long as the endpoint asks, up to a
minute, or backs off from one second, and each retry is shown in the run's
activity. A failure that would only repeat, such as a refused key or an unknown
model, ends the run at once. When the endpoint says the conversation no longer
fits the model, Roqer folds older work into a summary, trims older tool output
and screenshots, and sends the turn once more. If the model's context window is
set in Settings, Roqer folds the conversation before it fills three quarters
of that window. A turn has no length limit: Roqer stops waiting
only when the endpoint sends nothing for ten minutes, or the model makes no
progress, reasoning included, for five. With reasoning on, Claude 4.6 and later
models think adaptively at the run's effort. Older Claude models and other
Anthropic-compatible endpoints get a thinking budget. If the endpoint refuses
the form Roqer tried first, Roqer switches to the other. On OpenAI-compatible
endpoints, a model's reasoning goes back with the turn that produced it:
DeepSeek's `reasoning_content`, OpenRouter's `reasoning_details`, and Gemini's
thought signatures, which those endpoints require for a model to keep calling
tools. A server that rejects one of those fields stops receiving it.

An endpoint can also be set to OpenAI's Responses API, which the OpenAI preset
uses and which some OpenAI models require. Nothing is stored on the endpoint:
every request carries the whole conversation with `store: false`. With
reasoning on, Roqer asks for the model's reasoning in encrypted form and sends
it back with the turn that produced it, so the model keeps its thinking across
tool calls. It also asks for reasoning summaries, which only show that the model
is still working and never reach the reply. If the endpoint refuses summaries,
encrypted reasoning, or reasoning sent back, Roqer stops sending that part for
the rest of the run.

Roqer starts its bundled bridge and installs the matching Studio plugin on
every launch. To run your own bridge instead, start it before Roqer; Roqer
adopts it rather than replacing it:

```bash
node packages/robloxstudio-mcp/dist/index.js --auto-install-plugin --plugin-path studio-plugin/MCPPlugin.rbxmx
```

A packaged build reads nothing below from the user's environment except where
the table says so.

| Variable | Applies to | Purpose |
| --- | --- | --- |
| `ROQER_DISCORD_CLIENT_ID` | Build | The Discord application id embedded for Rich Presence. Defaults to Roqer's registered application; set it to test presence against another. |
| `WORKBENCH_CODEX_EXECUTABLE` | Launch | Absolute path to `codex.exe` for a portable Codex install the normal discovery cannot find. |
| `WORKBENCH_CLAUDE_EXECUTABLE` | Launch | Absolute path to the `claude` executable for a portable Claude Code install. |
| `WORKBENCH_MCP_SERVER_ENTRY` | Development launch | Overrides the bridge entry point Roqer spawns, instead of the bundled or repository-relative one. |
| `WORKBENCH_USER_DATA` | Development and tests | Overrides Electron's user-data directory, which is how the smoke test runs against an isolated profile. |
| `WORKBENCH_DEV_SERVER_URL` | Development launch | The Vite dev server the main process loads instead of the built renderer. |

The `WORKBENCH_` prefix is from the app's earlier name, Studio Workbench; the
variables keep it so existing setups go on working.

### Roblox Open Cloud in Roqer

Roqer keeps an Open Cloud key and the user or group uploads publish as in
Settings → Roblox → Open Cloud. The key is encrypted with the operating system's
credential store in `open-cloud.json` in Roqer's data folder and never reaches
the renderer or the model. Roqer passes the saved values to the bridge it starts
as `ROBLOX_OPEN_CLOUD_API_KEY` and `ROBLOX_CREATOR_USER_ID` or
`ROBLOX_CREATOR_GROUP_ID` in that process's environment, overriding whatever
Roqer itself inherited; with nothing saved, inherited values pass through.
Saving restarts the bridge so it reads the new values, after the current run if
one is using it. A bridge another program started keeps its own environment,
and Settings says so. Check key asks Roblox's key-introspection endpoint whether
the key is enabled, unexpired, and allowed to write assets for the chosen
creator; it creates nothing.

### Blender in Roqer

Settings → Blender turns on the opt-in local Blender worker.
[3D modeling with Blender](blender.md) covers setting it up, what a job runs
and checks, and where Roqer keeps its files.

### Updates

The updater is configured in `apps/desktop/electron-builder.yml` rather than by
environment: a packaged build checks the GitHub Releases of
[S4US/Roqer](https://github.com/S4US/Roqer), which it can read only while that
repository is public, and `-c.publish.owner=… -c.publish.repo=…` at package
time points a build at a fork instead.
