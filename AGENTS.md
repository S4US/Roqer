# Roblox MCP Engineering Guide

## Purpose

This open-source monorepo contains two connected products:

1. the Roblox Studio MCP bridge and Studio plugin, including the full and
   inspector editions; and
2. Roqer, a local desktop agent that consumes the MCP.

Roqer is a harness with no account and no hosted service: runs are driven by
the user's own ChatGPT or Claude subscription through the official Codex or
Claude Code client on their machine, or by a model endpoint the user configures
with their own key (the `custom` provider, driven by Roqer's own agent loop in
the desktop). Nothing Roqer does depends on a server the project runs.

Build them as one system. The MCP owns Roblox and Studio capabilities. Roqer
owns the user-facing agent experience, approvals, persistence, and presentation.
Do not duplicate Studio behavior in the desktop app or desktop policy in the
MCP.

Prioritize, in order:

1. correctness and user safety;
2. truthful, verifiable behavior;
3. clear ownership and maintainable interfaces;
4. backward compatibility where practical;
5. agent usability and token efficiency;
6. implementation convenience.

## Sources of truth

Use the repository as it exists now, not a roadmap copied into this file.

- The user's request defines the current task and priority.
- Tests and running code define current behavior.
- `package.json` files define supported commands.
- `README.md`, `docs/`, and `tests/README.md` describe public behavior and test
  operation.
- Design studies are context, not implementation authority, unless the task
  explicitly adopts them.

Do not add a changing milestone checklist to this file. Update the relevant plan
or documentation when product status changes.

## Repository map

### MCP and server

- `packages/core/` contains shared MCP definitions, routing, transport, Studio
  instance management, and most server-side behavior.
- `packages/core/src/tools/definitions.ts` is the public tool schema catalog.
- `packages/core/src/tools/index.ts` contains the main tool implementation layer.
- `packages/core/src/http-server.ts` exposes the authenticated HTTP bridge used
  by Studio and Roqer.
- `packages/robloxstudio-mcp/` is the full-edition package entry point.
- `packages/robloxstudio-mcp-inspector/` is the inspector-edition entry point.

Keep package entry points thin. Shared behavior belongs in `packages/core` unless
there is a real edition-specific reason to separate it.

### Studio plugin

- `studio-plugin/src/` contains the Roblox-TS plugin source.
- `studio-plugin/src/modules/handlers/` owns Studio-privileged operations.
- `studio-plugin/MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` are generated
  artifacts. Do not edit or commit them.

### Desktop Roqer

- `apps/desktop/electron/` owns Electron startup, preload, native integration,
  persistence wiring, build, and smoke scripts.
- `apps/desktop/runtime/` owns main-process logic that should remain testable
  without importing Electron: MCP access, run execution, planning, and result
  compaction. `agent-loop.ts` is Roqer's own model loop, used by the Custom
  provider; `model-api/` holds its turn contract and the OpenAI-compatible and
  Anthropic transports.
- `apps/desktop/shared/` contains contracts shared by the main process and
  renderer: run events, policy, tool risk, and Studio status.
- `apps/desktop/src/` owns the React UI and renderer-side state.

### Tests and documentation

- `packages/core/src/__tests__/` contains core unit and integration-style tests.
- `apps/desktop/**/*.test.ts` contains desktop unit tests.
- `tests/` contains subprocess and live Studio tests. Read `tests/README.md`
  before running a live or destructive suite.
- `docs/` documents public setup and behavior.

## Working method

1. Inspect the relevant code, tests, and current plan before choosing a design.
2. Define acceptance criteria for behavior, safety, compatibility, and evidence.
3. Make one focused, PR-sized change. Avoid unrelated cleanup.
4. Extend existing ownership boundaries instead of creating parallel systems.
5. Add or update the narrowest useful test alongside the implementation.
6. Run targeted checks first, then the applicable completion gates below.
7. Inspect the actual diff before reporting completion.

Preserve user changes in a dirty worktree. Do not discard or overwrite unrelated
work. Never weaken a test or silently change public behavior just to make a gate
pass.

For genuinely separable work, use bounded subagents with explicit objectives,
file ownership, and acceptance criteria. Keep writes to shared registries and
interfaces under one owner. Treat subagent reports as leads; the integrating
agent must inspect the diff and verify the result.

## Architecture boundaries

### MCP public surface

The MCP wire surface is a public, budgeted API. Do not add a tool merely because
it is convenient internally. First consider whether the capability belongs in:

- an existing tool or operation;
- an MCP resource;
- server-side orchestration;
- a Studio plugin implementation detail; or
- Roqer orchestration over existing tools.

When a public tool changes, keep these layers synchronized:

1. schema and description;
2. MCP/public handler;
3. `RobloxStudioTools` implementation;
4. HTTP routing where applicable;
5. Studio plugin request and response handling;
6. main and inspector edition allowlists;
7. desktop tool-risk classification; and
8. schema, routing, package, and drift tests.

Every Studio-routed tool must route the requested `instance_id` end to end and
must fail clearly when the target is ambiguous. Never guess a writable target.

Keep results compact and structured. Avoid returning large trees, logs, traces,
or image payloads when a bounded summary or explicit file output is sufficient.

### Mutation safety

Mutations must be deterministic, conflict-aware, and recoverable.

- Validate the full logical operation before applying it.
- Do not leave a partially applied result when the operation is presented as
  atomic.
- Use stable instance references when available.
- Use source revisions or equivalent compare-and-set checks for script writes.
- Reject stale writes instead of overwriting newer Studio state.
- Record Studio mutations with `ChangeHistoryService` where supported.
- Return the resolved target and enough evidence to verify the change.
- Read back important mutations rather than treating a successful request as
  proof of the intended outcome.

Arbitrary Luau execution is an escape hatch, not a replacement for safer
structured operations when those operations exist.

### Studio plugin placement

Put logic in the host/core layer when it concerns orchestration, comparison,
auditing, compaction, policy, or processing that does not require Studio
privileges.

Put logic in the plugin when it requires the DataModel, Roblox engine APIs,
runtime peers, semantic GUI geometry, input injection, or ChangeHistory-backed
mutation.

Prefer semantic engine state over reconstructing facts from screenshots.
Screenshots are evidence for visual questions, not the primary source for state
the engine can report directly.

Keep the inspector edition DataModel read-only. Selection and camera framing may
change editor presentation; explicit exports and captures may write only to the
requested local path. Review every shared plugin change for main/inspector
divergence.

Always clean up playtests, runtime bridges, temporary instances, listeners,
files, ports, and installed-plugin changes in success and failure paths.

### Desktop trust boundaries

The renderer is untrusted relative to the Electron main process.

- Do not expose provider credentials, MCP authentication material, raw IPC
  events, unrestricted filesystem access, or arbitrary Node capabilities to the
  renderer.
- Keep the preload API narrow, typed, and validated.
- Validate renderer requests and sender identity in the main process.
- Keep MCP, provider, filesystem, and secret handling in the main process.
- Enforce approval policy in the runtime, not only in the interface.
- Renderer text reaches the model on exactly one channel: the prompt and the
  mid-run note (`shared/steer.ts`), both recorded where the user can see them.
  An answer to `ask_user` is an index into a host-controlled list, never text —
  the "none of these" option is host-appended, and its explanation travels as a
  note. Do not add a second text channel or widen the answer one.
- Unknown tools and malformed events must fail closed.
- Irreversible actions must require explicit user confirmation in every mode but
  `Full auto`, which the user selects precisely to run a session unattended and
  which is therefore the confirmation itself. No other mode may waive it, and a
  tool with no risk classification still stops for the user in `Full auto`.
- Cancellation must stop in-flight work and prevent later tool calls from the
  cancelled run.

Persisted state is a versioned data contract. Use explicit migrations, atomic
writes, validation on load, and recovery that preserves damaged data for
diagnosis. Do not casually add speculative fields to the stored schema.

The interface must distinguish real results from demos or placeholders. Never
fabricate tool activity, diffs, screenshots, playtest evidence, connection
status, or success claims. Demo behavior must be clearly labelled and travel
through the same contracts it is intended to exercise.

The desktop app consumes MCP behavior through the public boundary. It must not
import or reimplement Studio tool handlers to bypass that boundary.

## Verification matrix

Run the narrowest relevant checks while iterating. Before completion, run every
applicable gate for the changed area.

### Core MCP or package changes

```text
npm run typecheck
npm test
npm run lint
npm run build
```

Use focused Jest tests during development. Add `npm run build:all` when package
contents, package entry points, plugin compilation, variants, or release
artifacts could be affected.

### Desktop changes

```text
npm run typecheck:desktop
npm run lint:desktop
npm run test:desktop
npm run build:desktop
```

For Electron, preload, persistence, IPC, startup, or shutdown changes also run:

```text
npm run smoke:electron -w apps/desktop
```

Root `typecheck`, `lint`, `test`, and `build:all` do not replace these desktop
checks.

Packaging changes additionally require `npm run package:desktop` from a clean
`npm ci`. Bridge staging resolves every bundled dependency from the committed
root lockfile and refuses an unlocked one, so a release cannot ship a dependency
set the repository does not record.

### Studio plugin and live behavior

Compile the plugin through the repository scripts; do not edit generated output.
For any feature whose behavior reaches Studio, the ordinary live completion gate
is:

```text
npm run test:e2e
```

Choose additional or replacement live suites from `tests/README.md` according to
the changed area. In particular, routing, properties, tools, runtime, simulation,
or multiplayer changes require the managed Studio runner. Installer, lifecycle,
port isolation, and parallelism changes have dedicated suites. The release gate
is:

```text
npm run test:e2e:full
```

Live suites may launch or close Studio and temporarily replace installed plugins.
Respect their documented environment guards and lease mechanism. If Studio tests
cannot run in the current environment, run every lower-level check that can run
and state exactly what remains unverified.

### Existing failures

Do not assume a failing command is caused by the current change, but do not ignore
it either. Compare against the relevant baseline or isolate the failure, report
the exact failing files/tests, and do not introduce new failures. Never encode a
temporary failure count in this document.

## Final review

Before declaring a change complete, inspect the final diff and ask:

- Can a write partially apply or overwrite stale state?
- Can it target the wrong Studio instance or runtime peer?
- Are schema, handler, routing, inspector, desktop-risk, and package surfaces in
  sync?
- Did a result, log, trace, screenshot, or persisted record become unbounded?
- Did the change cross the Electron renderer/main trust boundary safely?
- Are approvals, cancellation, and irreversible-action rules still enforced in
  the runtime?
- Does the inspector edition remain read-only?
- Are playtests and temporary resources cleaned up on every path?
- Are generated files absent from the diff?
- Do tests exercise real behavior at the lowest useful boundary rather than only
  restating mocks?
- Do documentation and implementation describe the same behavior?

Completion means the requested behavior is implemented, applicable checks pass
or are honestly accounted for, and the remaining limitations are explicit.
