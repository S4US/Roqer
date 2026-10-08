# Custom MCP Connections Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan. Independent store and renderer work may use bounded subagents under AGENTS.md.

**Goal:** Let all Roqer providers use user-configured MCP tools with the existing approvals and activity.

**Architecture:** A shared `mcp` gateway dispatches discovered tools through RunSession into run-scoped SDK clients. A separate secret store and typed IPC back the settings page.

**Tech Stack:** TypeScript, React, Electron, existing MCP v2 SDK packages and Node test runner.

**Spec:** ../specs/2026-10-08-custom-mcp-design.md

## Global Constraints

- At most 16 connections. HTTPS remotely; HTTP only on loopback. Stdio command and arguments are separate.
- Environment and header values stay encrypted at rest and write-only in renderer APIs.
- External calls ask even in Full auto and are denied in Read only; server annotations never grant permissions.
- No external Studio instance injection, argument stripping, bridge recovery, or automatic tool replay.
- No OAuth, legacy SSE, resources, prompts, sampling or elicitation in this change.

## Review Focus

- Edits or disable during an approval wait must revoke the pending dispatch.
- Failed or cancelled discovery must close subprocesses and HTTP sessions.
- Windows executable launch must hide windows and preserve argument boundaries.
- A secret must not enter errors, activity, configuration views, or provider session keys.
- Servers with oversized or paginated catalogs must stop within explicit limits.

### Task 1: Validated configuration and encrypted persistence

**Files:** shared/custom-mcp.ts; runtime/custom-mcp-store.ts and their tests.
**Interfaces:** CustomMcpConnection, CustomMcpConnectionView, CustomMcpSave, CustomMcpSettingsResult, CustomMcpCheckResult. Store list/save/remove/resolve/snapshot; resolved values have connection, environment and headers.

- [x] Write and run failing tests for URL/command validation, secret redaction, atomic persistence, corrupt recovery and replacing destination without forwarding old secrets.
- [x] Implement contracts and store using SecretProtector.
- [x] Run focused tests.

### Task 2: SDK manager and gateway

**Files:** runtime/custom-mcp-manager.ts; runtime/custom-mcp-tool.ts; runtime/run-engine.ts; focused tests.
**Interfaces:** Manager list/describe/callTool/close; withCustomMcp routes external identities before the Studio/local caller. Gateway accepts action list/describe/call, server ID, tool and arguments.

- [x] Write and run failing tests with real stdio/HTTP fixture servers, cancellation, changed configuration and bounds.
- [x] Implement SDK clients and bounded parsing; never replay tools.
- [x] Add failing run-engine regressions for unchanged external instance_id and failure isolation; restrict Studio routing/recovery for external identities.
- [x] Run focused tests.

### Task 3: Provider and desktop integration

**Files:** three planners and tests; electron/main.ts; electron/preload.ts; src/platform.ts; renderer desktop contract.

- [x] Write and run failing tests showing mcp offered/dispatched only while enabled for all three providers and availability reflected in session keys.
- [x] Register the shared definition/runner, main-process store/IPC and run-scoped manager; cleanup on every run exit.
- [x] Validate trusted IPC senders, request and response contracts.
- [x] Run focused tests.

### Task 4: Settings and documentation

**Files:** src/custom-mcp-settings.tsx; settings-page.tsx; existing settings styles; docs/configuration.md; README.md.

- [x] Add a settings list/editor with local executable/argument JSON and remote URL, write-only env/header JSON, saved-secret labels, enable, check and remove controls.
- [x] Preserve existing settings layout and expose truthful pending/error states.
- [x] Document configuration, permissions, supported authentication and per-run lifetime.

### Task 5: Completion and pull request

- [x] Inspect diff and obtain a fresh security/correctness review.
- [x] Run typecheck:desktop, lint:desktop, test:desktop, build:desktop and smoke:electron.
- [x] Fix material findings with regression tests; document genuine environment limitations.
- [ ] Commit, push to a user-owned fork, create the requested PR and attach it to this chat.
