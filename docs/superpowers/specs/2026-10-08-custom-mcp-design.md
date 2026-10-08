# Custom MCP connections

The user approved custom MCP connections first and requested implementation and a pull request. Manual compaction and web search remain separate roadmap work.

## Behavior

Settings gains an MCP section for adding, editing, removing, enabling and checking up to 16 local stdio or Streamable HTTP connections. Stdio accepts an executable and an argument array; HTTP accepts an HTTPS endpoint (HTTP only on loopback). Optional environment variables and HTTP headers are write-only secrets. They are encrypted with the existing OS SecretProtector, never returned to the renderer or provider, and never included in exported chats. A check initializes the connection and discovers tools without calling one.

One bounded `mcp` tool offers list, describe and call actions to ChatGPT, Claude and Custom. The gateway discovers enabled servers and their schemas on demand, keeps names separated by connection ID, and resolves calls only to tools actually discovered for that connection. External descriptions and annotations are untrusted. External calls require explicit approval in every mode including Full auto, and Read only blocks them. Discovery does not execute tools.

## Ownership and lifecycle

Shared contracts validate IPC payloads. A dedicated atomic, versioned store owns configurations and encrypted secrets. A main-process runtime manager owns SDK clients, standard transports, bounded catalogs/results, cancellation and cleanup. Providers use the same gateway runner. Calls use a namespaced internal identity and pass through PlannerContext.call, preserving activity, approval and rejection deduplication.

External arguments must not receive or lose Studio's instance_id, and external failures must not trigger Studio bridge recovery. Enabled configuration is snapshotted per run; every call checks that its configuration remains current, so changing, disabling or deleting a connection blocks further calls. Each run closes its clients in finally. Gateway availability participates in cached provider session keys.

## Verification

Tests cover validation, secret persistence and redacted views, disabled connections, real SDK stdio and HTTP discovery/calls, duplicate names, tool errors, cancellation, bounded results, external instance_id preservation, no Studio recovery, all three provider paths and IPC exposure. Run desktop typecheck, lint, complete tests, build and Electron smoke. The change does not alter Studio behavior; a live Studio test is outside this connection feature.

OAuth, legacy SSE transport, resources, prompts, sampling and elicitation are outside this first tool-connection release. An unsupported authentication requirement is reported as a connection error.
