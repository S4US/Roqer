# Contributing to Roqer

Thanks for helping. Roqer is a desktop agent for Roblox Studio plus the Studio
MCP bridge and plugin it runs through; changes here can edit people's games, so
the bar is correctness and honesty first. [AGENTS.md](AGENTS.md) is the full
engineering guide, written for people and coding agents alike; this page is
the short version.

## Set up

Node.js 20 or newer. From the repository root:

```bash
npm ci
npm run build:all
npm run start:desktop
```

The Studio plugin is a separate npm project in `studio-plugin/`, so the first
plugin build installs its own dependencies from its lockfile. It also downloads
Roblox's LibMP and checks its hash; set `LIBMP_PATH` to a local copy to build
offline (see [docs/building-from-source.md](docs/building-from-source.md)).
Live Studio work needs Windows or macOS with Roblox Studio installed; everything
else runs on Linux too, which is what CI uses.

## How it fits together

```text
Roqer UI (renderer)
        |
Electron main process: providers, instructions, skills, approvals, persistence
        |                                    \
authenticated local HTTP MCP bridge           Codex / Claude Code / your endpoint:
        |                                       your own model
Roblox Studio plugin: edit, server, and client peers
```

Roqer never gives a model the bridge's credential. A model requests one
policy-gated `roblox_studio` operation at a time, and can load a matching
skill; the Electron main process validates and executes both. Studio behaviour
lives in the bridge and plugin; providers, approval policy, chat state, and
presentation live in Roqer.

## Where things live

- `packages/core/` — the MCP tool catalog, routing, HTTP bridge, and Studio
  process management. `src/tools/definitions.ts` is the public tool schema.
- `studio-plugin/src/` — the Roblox-TS plugin: everything that needs Studio
  privileges.
- `apps/desktop/` — the Electron app: `electron/` (main process and preload),
  `runtime/` (testable main-process logic: providers, the run engine,
  approvals), `shared/` (contracts between main and renderer), `src/` (React
  UI), `agent/` (the agent's instructions and skills).
- `tests/` — subprocess and live Studio suites; read `tests/README.md` before
  running a live one.

Design notes worth reading before larger changes:

- [Token-efficiency contract](docs/token-efficiency.md)
- [World building and modeling plan](docs/world-building-plan.md)
- [Agent evaluation harness](apps/desktop/eval/README.md)

## Before you open a pull request

Run the checks for what you touched. CI runs all of the non-Studio ones on
every pull request.

MCP, plugin, or package changes:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run build:plugins
```

Desktop changes:

```bash
npm run typecheck:desktop
npm run lint:desktop
npm run test:desktop
npm run build:desktop
npm run smoke:electron -w apps/desktop   # Electron, preload, IPC, or persistence changes
```

Anything whose behaviour reaches Studio also needs the live gate,
`npm run test:e2e`, on a machine with Studio. If you could not run it, say so
in the pull request rather than leaving it implied.

## What reviewers look for

- **Safety.** Writes are validated before they apply, refuse stale state (script
  edits carry the revision they were read at), and are undoable in Studio.
  Every Studio-routed call names its `instance_id`; never guess a target.
- **The inspector edition stays read-only**, in the server, the bridge, and the
  plugin. `inspector-endpoints.test.ts` checks the plugin's list.
- **Approvals live in the runtime**, not the interface. Irreversible actions
  ask in every mode but Full auto, and unknown tools fail closed.
- **The renderer is untrusted.** No credentials, raw IPC, or filesystem access
  cross into it; the preload API stays narrow and validated.
- **One change per pull request**, with a test at the lowest useful boundary
  and docs that say what the code does.
- **A public tool change keeps every layer in step**: schema, handler, tool
  implementation, plugin endpoint, inspector list, desktop risk table, and the
  generated desktop schemas (`npm run generate:tool-schemas -w apps/desktop`).

Commit messages say what changed and why, in plain sentences. Do not commit the
generated `studio-plugin/*.rbxmx` files.

## Reporting problems

Bugs and ideas go in [GitHub issues](https://github.com/S4US/Roqer/issues).
Security problems go through a private report instead; see
[SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the
project's [MIT licence](LICENSE).
