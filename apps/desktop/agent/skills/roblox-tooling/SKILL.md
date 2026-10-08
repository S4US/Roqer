---
name: roblox-tooling
description: "Use when configuring Roblox tooling such as Rojo, Wally, pesde, Selene, StyLua, Lune, Rokit, luau-lsp, or CI/CD."
last_reviewed: 2026-10-02
sources:
  - https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/Players.yaml
  - https://rojo.space/docs/
  - https://wally.run/
  - https://kampfkarren.github.io/selene/
  - https://raw.githubusercontent.com/JohnnyMorganz/StyLua/master/README.md
  - https://lune-org.github.io/docs/
  - https://raw.githubusercontent.com/LPGhatguy/aftman/main/README.md
  - https://raw.githubusercontent.com/rojo-rbx/rokit/main/README.md
  - https://raw.githubusercontent.com/rojo-rbx/rojo/v7.7.1/src/cli/syncback.rs
  - https://raw.githubusercontent.com/pesde-pkg/pesde/main/docs/src/content/docs/reference/manifest.mdx
  - https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/main/README.md
  - https://raw.githubusercontent.com/lest-luau/lest/main/docs/backends.md
  - https://raw.githubusercontent.com/lest-luau/lest/main/docs/continuous-integration.md
  - https://raw.githubusercontent.com/UpliftGames/wally/main/src/resolution.rs
  - https://create.roblox.com/docs/llms.txt
  - https://create.roblox.com/docs/reference/engine/llms.txt
  - https://create.roblox.com/docs/cloud/llms.txt
  - https://create.roblox.com/docs/llms-full.txt
  - https://create.roblox.com/docs/reference/engine/deprecated.md
  - https://devforum.roblox.com/t/evolving-luau-oss-community-contributions-more/4566806
  - original
---

# roblox tooling

## When to Load

Load for filesystem workflows, tool/package pins, linting, sourcemaps, and CI.

## Quick Reference

- Use Rojo when the source of truth should live in files and sync or build into Studio.
- Use Wally only when the project wants package manifests and a lockfile; keep package scope and server/client placement explicit.
- Pin tools with the project's existing manager; for a new project lead with Rokit (Aftman is archived, but Rokit reads existing `aftman.toml` projects).
- Run Selene and StyLua in check mode in CI. Do not let a formatter rewrite a contributor's branch silently.
- Use Lune for standalone Luau scripts or test helpers when its standard libraries fit the task.
- Generate a Rojo sourcemap for editor tooling when the project needs Roblox-aware navigation.
- CI must check test results and expected counts, not merely exit codes. Separate logic, file/HTTP, and engine suites; see full.md.

**Source-of-truth first.** Identify Studio vs files before editing; never assume they match. `rojo syncback` pulls saved-place edits, not live two-way sync; preview with dry-run/list. Follow existing tooling; do not impose optional tools. TestEZ is archived: keep where used, not as a new default. See full.md §§1b–1c.

**Need the details?** Load `references/full.md` for setup, file layout, and CI examples.
