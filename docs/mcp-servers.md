# Your own MCP servers

Roqer can give the agent tools from other [MCP](https://modelcontextprotocol.io)
servers: a program on your computer, such as one started with `npx`, or a
server at a URL. Add them under **Settings → MCP servers**.

Roqer is the MCP client. Codex, Claude Code and the Antigravity CLI never
connect to these servers, and neither do your own `~/.claude` or `~/.codex`
MCP settings. The agent reaches every server through one Roqer tool,
`external_mcp`, so each call goes through the same approvals, cancellation and
activity log as a Studio call, whichever provider runs the chat.

## Add a server

### Quick setup

Open **Settings → MCP servers → Quick setup**:

- **Meshy AI:** enter your Meshy API key and choose **Save & test**. Roqer
  preconfigures the official `@meshy-ai/meshy-mcp-server` with
  `MESHY_API_KEY`. Node.js/npm must be installed; `npx` downloads the server
  on first use. See [Meshy's setup documentation](https://docs.meshy.ai/en/api/ai).
- **ElevenLabs:** choose **Save & sign in**, finish the browser sign-in, then
  **Test**. Roqer preconfigures the hosted server's canonical US endpoint and
  OAuth; no API key or local installation is needed. It provides speech
  generation and voice-agent management. The old local API-key server is
  deprecated. See [ElevenLabs' hosted-server documentation](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp).

Both use your own service account and credits. Presets are not saved or
connected until you choose to add them. Keys use the same encrypted storage
as manually added servers, and tool approvals work the same way. **Connection
settings** exposes the prefilled settings, including the URL for a different
ElevenLabs residency region. A preset already added under its default name
is managed in **Your servers** instead of being added again.

### Manual setup

1. Open **Settings → MCP servers** and choose **Add server**.
2. Give it a short name, such as `github`. This is what the agent calls it.
3. Choose how it runs:
   - **Program:** the command and its arguments, one per line, for example
     `npx` with `-y` and `@modelcontextprotocol/server-github`. The command is
     a full path or a name on your PATH. Roqer shows you the exact command and
     asks before it saves a new program or a changed one.
   - **URL:** a streamable HTTP endpoint. Use HTTPS; plain HTTP is allowed only
     for this computer and your local network. The older HTTP+SSE transport
     is not supported. For a server you sign in to on its website, see
     [Sign in with OAuth](#sign-in-with-oauth).
4. Add any keys the server needs: environment variables for a program,
   headers (such as `Authorization`) for a URL. Values are encrypted with your
   system's credential store and never shown again. A program does not see
   Roqer's own keys or your environment's credentials, only the variables you
   add here.
5. Choose **Save & test**. Roqer starts or reaches the server, lists its
   tools, and stops it again.

## Sign in with OAuth

Some remote servers have you sign in on their website instead of giving you a
key. For those, turn on **Sign in with OAuth** under the URL and choose **Sign
in**. Roqer opens the provider's page in your browser; when you approve there,
the browser returns to Roqer and the server is signed in. Roqer renews the
sign-in by itself while the provider allows it, and **Sign out** ends it here
and asks the provider to forget it.

Roqer follows the MCP sign-in standard:

- It finds where to sign in from the server itself. If the server says its
  address is different from the URL you entered, Roqer stops and tells you the
  address to use. ElevenLabs is one: its server at
  `https://api.elevenlabs.io/v1/mcp` names itself
  `https://api.us.elevenlabs.io/v1/mcp`, so enter that.
- It identifies itself with its published client metadata,
  `https://s4us.github.io/Roqer/oauth/client-metadata.json`, where a provider
  reads that, or registers itself where a provider allows that. A provider
  that does neither needs a client ID registered with it; enter that in
  **Client ID**.
- The sign-in uses PKCE, and its tokens are tied to that one server: they are
  sent to nothing else, and changing the server's URL or client ID ends the
  sign-in.
- Tokens are encrypted with your system's credential store and never reach
  the Settings page or the model.

The browser returns to `http://127.0.0.1:47823/callback`, or another port if
that one is taken. Only one sign-in can wait at a time; **Cancel** stops it.

A run never opens a sign-in page by itself. If a sign-in expires and cannot
be renewed, the agent's calls to that server fail with a message to sign in
again in Settings.

## What each tool may do

A server describes its own tools, and Roqer cannot check what it says. So you
set what each tool may do, the same three levels Roqer uses for Studio:

| Risk | Read only | Ask first | Auto approve | Full auto |
| --- | --- | --- | --- | --- |
| **Read** | runs | runs | runs | runs |
| **Edit** | refused | asks | runs | runs |
| **Irreversible** | refused | asks | asks | runs |

A tool you have not set follows the server's **Tools you have not set**
choice:

- **Treat as irreversible** (the default): Full auto runs it, every other mode
  asks first. A tool the server adds later is treated the same way.
- **Ask every time:** it asks before it runs in every mode, Full auto
  included, until you set it.

A server may mark a tool read-only or destructive. Settings shows that next to
the tool, but Roqer never acts on it by itself; only your choice counts. For a
server with many tools, **Set to Read** sets every tool the server calls
read-only, and that you have not set, to Read in one step. It takes the
server's word for it, so check the list before you save. A change you
save applies to the next call, even in a run that is already going.

## During a run

The agent is offered `external_mcp` only while at least one server is turned
on. It lists your servers and their tools first, reads a tool's description
and arguments, then calls it. A server with more tools than one answer holds
is listed by name, and the agent searches it by keyword for what it needs.

Some servers return a link to a file they made rather than the file: an
ElevenLabs sound is a link to an MP3. The agent can save such a file into
Roqer's data folder (`mcp-downloads`, one folder per run, removed after a
week) and upload it to Roblox from there. It can only download a link that a
server's result gave in the same run, over HTTPS, up to 50 MB. A download
counts as an Edit: Read only refuses it and Ask first asks. A run starts a server the first time it needs
it, keeps it for the rest of the run, and stops it when the run ends, however
it ends. Turning a server off in Settings stops new calls to it at once.

Everything a server sends back is marked to the model as third-party data,
not instructions. Results are bounded: long text is cut, and audio and binary
content are left out and named instead. A call waits at most two minutes.

## Keep in mind

- A program server runs with your permissions. A URL server receives
  whatever the agent sends it. Only add servers you trust.
- A server's text can try to steer the agent. In Full auto, nothing stops a
  call that text leads to, including Studio tools that change or delete
  things. Use **Ask every time**, or a mode other than Full auto, with a server
  you are unsure of.
- On Windows, a program started through a `.cmd` or `.bat` file (as `npx` is)
  cannot have `"` or `%` in its arguments.
