---
name: roblox-architecture
description: "Use when assigning Roblox feature ownership, code location, dependencies, startup, or client-server boundaries without imposing a framework."
last_reviewed: 2026-10-02
sources:
  - https://create.roblox.com/docs/projects/data-model
  - https://create.roblox.com/docs/projects/client-server
  - https://create.roblox.com/docs/scripting/locations
  - https://create.roblox.com/docs/scripting/security/access-control
  - https://create.roblox.com/docs/reference/engine/classes/CollectionService
  - https://raw.githubusercontent.com/Ukendio/jecs/v0.11.0/README.md
  - original
---

# Roblox Architecture

## When to Load

Load for ownership, client-server boundaries, startup, or module splits. Do not add a framework without evidence.

## Quick Reference

### Start from one owner

For each behavior, name:

- authoritative state and who may mutate it;
- public operations and callers;
- Roblox instances, connections, and tasks it owns;
- persistence or network boundary;
- startup and teardown conditions.

Group by feature when that keeps one change together. Split server, client, and shared code only where the runtime boundary requires it. Shared code has no secrets or authoritative mutable state.

### Use the smallest dependency shape

Direct module calls are the default. Use a signal only when one publisher has genuinely independent observers. Do not add an event bus, dependency container, manager class, or `Init`/`Start` ceremony to hide an ordinary dependency.

Keep module top-level work cheap and non-yielding. A small bootstrap owns startup that needs ordering; call it sequentially and fail visibly. Concurrency must be explicit and safe, not automatic `task.spawn` everywhere.

Bound `WaitForChild` when a dependency arrives through replication; an unbounded wait turns a missing instance into a silent hang.

### Enforce runtime authority

The client presents and predicts; the server validates and decides. Remotes are APIs with types, bounds, ownership, abuse controls, and failure behavior. Route details to `roblox-networking` and `roblox-security`.

### Split only for evidence

Split when there is a separate lifecycle or authority boundary, a distinct persistence contract, an independently testable pure core, or unrelated reasons to change.

### Data-oriented alternative: only on evidence

An ECS earns its cost only when many similar entities update every frame by order-independent logic, or cross-cutting queries replace tangled per-entity scripts; hooks enforce invariants, ordered systems decide. Version-specific pitfalls: full.md "ECS on Roblox".

### Review

One canonical owner per mutation, no hidden startup yield or replicated trust decision, explicit cleanup, smallest traceable structure. Tags are discovery, attributes configuration, one owner for attach/remove cleanup.

> Detailed layouts, dependency rules, and startup examples: [references/full.md](references/full.md)
