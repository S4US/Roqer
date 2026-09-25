# Token-efficiency contract

Version 3.0 treats the MCP wire surface as a budgeted public API.

## Catalog budget

The regression test in `packages/core/src/__tests__/mcp-runtime.test.ts` caps
the serialized full catalog at 47,300 characters for its 51 tools and the
inspector catalog at 20,000 for its 25, tool descriptions at 120 characters, and
argument descriptions at 64 characters. It also requires structured output
schemas for every tool except the Markdown-returning `get_roblox_docs` tool.
Change the budget only as an explicit API decision, and change the number here
when you do.

Those limits apply to the catalog as served. The server cuts each argument
description to 33 characters at a word boundary (`concise` in
`packages/core/src/mcp-runtime.ts`), so about two in three of them reach an MCP
client ending in an ellipsis; the full text is in
`packages/core/src/tools/definitions.ts`. Roqer's desktop generates its own
schemas from that file, and gives a model an operation's full schema when it
asks for one or sends arguments that do not fit.

## Advertisement contract

- A tool description is one sentence that explains when or why to call it.
- Every input property describes its meaning and any constraint not already
  encoded by `enum`, `required`, bounds, or another JSON Schema keyword.
- Tool annotations contain only `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, and `openWorldHint` behavior metadata.
- Server instructions hold shared constraints and cross-tool sequences. They are
  generated from the tools exposed by each server edition, so they never name an
  unavailable tool.
- Detailed workflows and safety notes are available on demand at
  `robloxstudio://tool-guides`. Official engine references remain available through
  the `robloxdocs://` resource templates.

The server advertises shared instructions once. Clients read the detailed tool
guide only when needed, and the guide is not part of the tool catalog.

## Response contract

- Modern 2026-07-28 clients receive JSON once, in `structuredContent`.
- Legacy 2025 clients receive one JSON text projection for compatibility.
- Human-readable Markdown and image/audio content remain content blocks.
- Known bundle, plugin-session, debug, and diagnostic metadata fields are
  removed at the protocol boundary.
- `get_connected_instances` returns each place once as `{ id, name, roles }`
  instead of repeating full plugin diagnostics for every edit/server/client peer.
- Tool errors expose a short stable code, an actionable message, and only the
  recovery data a caller needs. Full diagnostics go to stderr.

The shared boundary in `packages/core/src/mcp-runtime.ts` owns catalog projection,
annotations, input/output schemas, result normalization, and public error shaping
for both HTTP and stdio transports.

## Roqer's copy for the model

Roqer runs on the user's own ChatGPT or Claude subscription, so every token it
sends counts against that user's provider limits. The desktop runtime applies
these rules on top of the MCP response contract:

- **One budget per result.** `apps/desktop/runtime/studio-tools.ts` bounds each
  Studio result the model reads at 24,000 characters. Arrays are kept whole
  until that budget runs out; the ten-entry cut in `result-summary.ts` applies
  only to the activity cards the user sees.
- **Cut by structure, not by character.** A result over the budget has its
  largest array shortened — from the start for `get_runtime_logs`, so the
  newest entries survive — and a `truncated` field ahead of the data says how
  many entries were left out and how to narrow the request. Every other field,
  such as a log read's `nextSince` cursor, is kept. Only a payload with no array
  to shorten is cut as text.
- **Source as text.** A result carrying `source` is sent as its JSON envelope
  followed by the source verbatim, not escaped inside the JSON.
- **The conversation is kept, not replayed.** Within a chat, the Claude Code
  process or Codex thread stays open between messages
  (`runtime/provider-sessions.ts`), so a follow-up sends only the new prompt and
  the provider reuses its own tool results, prompt cache, and compaction. A
  replayed transcript (`conversation-prompt.ts`, bounded to 64,000 characters)
  is the fallback when no current session exists.
- **Schemas on demand.** The tool description spells out the frequent
  operations; any other operation's schema is answered locally with
  `{help: true}` and never reaches Studio.
- **The bridge contract is in the instructions.** `apps/desktop/agent/developer.md`
  carries what every Studio task needs, so a run does not spend a model turn
  loading `roblox-studio-mcp` before it starts; that skill holds only the deeper
  reference on assets, imports, simulation, profiling, and Studio lifecycle.
- **Skills once per conversation.** `load_skill` returns a document in full once
  and a short pointer on repeats. The cache belongs to the kept Claude Code
  process or Codex thread, so a follow-up message is not sent guidance its
  conversation already holds, and a UI follow-up is told the UI skill is loaded
  instead of being asked to load it. The cache is cleared when the provider
  compacts the conversation, so a pointer never refers to guidance the model can
  no longer see.
