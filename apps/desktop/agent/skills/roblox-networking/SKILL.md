---
name: roblox-networking
description: "Use when validating RemoteEvent or RemoteFunction arguments, adding rate limits, designing server-authoritative systems, or preventing exploits."
last_reviewed: 2026-10-02
sources:
  - https://create.roblox.com/docs/scripting/events/remote
  - https://create.roblox.com/docs/scripting/security/security-tactics
  - https://create.roblox.com/docs/scripting/security/client-server-boundary
  - https://create.roblox.com/docs/projects/server-authority
  - https://create.roblox.com/docs/reference/engine/classes/UnreliableRemoteEvent
  - https://create.roblox.com/docs/reference/engine/classes/Workspace#GetServerTimeNow
  - https://1axen.github.io/blink/
  - original
---

# roblox networking

## When to Load

Load when adding a remote, handling untrusted input, adding cooldowns, or assigning authority.

## Quick Reference

- Every client argument is attacker-controlled; validate type, size, ownership, state, distance, cooldown on the server.
- Look up prices, damage, rewards, permissions from server-owned definitions.
- Choose the authority model first: Server Authority uses client prediction + server rollback, and is not `SetNetworkOwner`.
- Under Server Authority, simulation input uses `InputAction`/`BindToSimulation()`, not a `RemoteEvent`.
- Events for most gameplay requests; keep `RemoteFunction` calls short and bounded.
- `RemoteEvent` for reliable state; not ordered vs property/attribute replication — use one explicit channel or version state. `UnreliableRemoteEvent` only for replaceable data (VFX, snapshots).
- Unreliable is not automatically faster: unordered, droppable, 1000-byte payload cap.
- Measure payload size and fire rate under load; estimators are not an official wire-format spec.
- Budget rate × bytes × recipients; snapshot on join, diffs after. Measure encoded payloads.
- Hit timestamps are untrusted context, never proof. Bound freshness and validate server history; see full.md §3a.
- Typed schemas do not replace security checks. Pin generators and verify generated output in CI.
- Check NaN/infinity first (`x ~= x`, `math.abs(x) == math.huge`): `NaN` defeats `<`/`>`. `utf8.len` catches malformed UTF-8 that fails a DataStore save.
- Serialization: functions arrive `nil`, metatables stripped, mixed keys mangled, `nil` truncates tables, tables are copies — validate field by field, share state via server-owned snapshots/ids.
- Server Authority needs `AuthorityMode = Server` + its bundle (NextGenerationReplication, PlayerScriptsUseInputActionSystem, deferred signals, UseFixedSimulation, StreamingEnabled); misprediction/rollback are normal (full.md).
- Rate limits protect the server; validation still rejects invalid requests.
- Record suspicion with thresholds; never punish one malformed packet.
- Edit-mode play: wrap the network layer so `RunContext:IsEdit()` gets a loopback mock (full.md).

**Need details?** `references/full.md` has validation, throttling, and mock patterns.
