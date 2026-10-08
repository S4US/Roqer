# Roblox Architecture: Full Reference

Architecture is the ownership and dependency model that makes changes safe. Folders and class names are evidence of that model only when they clarify a real boundary.

## 1. Define the feature before the hierarchy

For a behavior, answer:

1. Which state is authoritative?
2. Which code may mutate it?
3. Which operations are public, and who calls them?
4. Which instances, connections, tasks, and cached values does it own?
5. Does it cross a client/server, persistence, purchase, or external-service boundary?
6. When does it start, and how does it stop?

If those answers fit in one small module or script, keep them there. A service/controller pair is not automatically more architectural than two scripts. Add boundaries because ownership differs, not because a template has folders to fill.

## 2. Runtime location is a trust and execution decision

| Location | Typical role | Important consequence |
| --- | --- | --- |
| `ServerScriptService` | server rules and orchestration | not replicated to clients |
| `ServerStorage` | server-only templates and assets | unavailable to clients |
| `ReplicatedStorage` | shared definitions, modules, and remotes | readable by clients |
| `StarterPlayerScripts` | per-player client behavior | cloned and run for each player |
| `StarterGui` | UI templates | cloned into each player's GUI |
| `Workspace` | live world instances | replicated according to engine behavior |

Replicated code is not a secret store. Do not put credentials, private reward logic, hidden detection thresholds, or authoritative mutable state in replicated locations and assume clients cannot inspect it.

A shared module may hold types, immutable identifiers, pure calculations, or presentation-safe configuration. The server still owns decisions that grant value, change persistent state, charge a purchase, or affect other players.

## 3. Prefer feature cohesion over ceremonial layers

A small feature can keep related code together while respecting runtime boundaries:

```text
ReplicatedStorage/Features/Inventory/
├── Types.luau
└── Remotes/
ServerScriptService/Features/Inventory/
├── Inventory.luau
└── Inventory.server.luau
StarterPlayer/StarterPlayerScripts/Features/Inventory/
├── InventoryView.luau
└── Inventory.client.luau
```

This is an example, not a required tree. A flat layout is better when the project is small. A top-level server/shared/client layout is better when that is already consistent. Do not reorganize a working repository solely to match this specimen.

The important properties are:

- one obvious server owner for authoritative mutation;
- client code owns input and presentation, not grants;
- shared code is safe to replicate;
- one feature change does not require hunting through unrelated generic manager folders.

## 4. Module contracts

A useful module contract states its owned state, public operations, caller side, failure modes, and lifecycle.

```luau
local Inventory = {}
local quantities: {[Player]: {[string]: number}} = {}

function Inventory.getCount(player: Player, itemId: string): number
    local playerItems = quantities[player]
    return if playerItems then playerItems[itemId] or 0 else 0
end

function Inventory.remove(player: Player, itemId: string, amount: number): boolean
    if amount < 1 then
        return false
    end
    local playerItems = quantities[player]
    local current = if playerItems then playerItems[itemId] else nil
    if current == nil or current < amount then
        return false
    end
    playerItems[itemId] = current - amount
    return true
end

function Inventory.release(player: Player)
    quantities[player] = nil
end

return Inventory
```

This does not need a class, dependency container, base service, or lifecycle interface. Add one only when repeated concrete behavior pays for it.

Keep top-level module code cheap and non-yielding. Hidden work during `require` makes ordering, failure, and cycles hard to diagnose. Circular requires indicate ownership or dependency direction is unclear; do not solve them with delayed globals.

## 5. Dependency direction

Use a direct module call when one owner needs a stable operation from another. The dependency remains visible and searchable.

Use a signal when:

- the publisher should not know independent observers;
- zero, one, or several observers are legitimate;
- delayed notification is acceptable;
- the signal has an owner and cleanup contract.

Do not introduce a global event bus merely to erase dependency arrows. It replaces compile-time/searchable relationships with string names, runtime ordering, and hidden consumers.

Avoid bidirectional feature dependencies. Move a narrow pure contract downward, let one side own orchestration, or emit an event from the authoritative owner. Shared folders should not become dumping grounds for anything imported twice.

## 6. Startup only when startup exists

Many modules need no initialization. Requiring them and calling their operations is enough.

When startup order matters, one small bootstrap should make it explicit:

```luau
local DataOwner = require(script.Parent.DataOwner)
local Match = require(script.Parent.Match)

local ok, problem = DataOwner.start()
if not ok then
    error(`Data startup failed: {problem}`)
end

Match.start(DataOwner)
```

Sequential calls preserve order and surface failure. Do not wrap every `Start` in `task.spawn`; that discards ordering and creates unowned background failures. Run independent startup concurrently only when independence is proven and failures are still collected.

Avoid universal two-phase `Init`/`Start` contracts. They add ceremony and can leave modules half-initialized. If phases are necessary, state exactly what each phase guarantees, validate dependency availability, and prevent public operations before readiness.

Top-level scripts can wire small features directly. A framework is not required to make startup explicit.

If a client dependency arrives through replication, use a bounded
`WaitForChild` and handle timeout explicitly. An unbounded wait converts a
missing instance or placement mistake into a silent startup hang.

## 7. Client/server APIs

A client request is untrusted input, not a command. The server validates the request against current server-owned state before side effects.

For each client-to-server remote, define:

- payload types and size limits;
- finite number and range checks;
- current-state preconditions;
- player ownership or permission;
- replay and duplicate semantics;
- abusive-frequency controls based on operation cost;
- success, denial, timeout, and reconciliation behavior.

Client prediction may improve responsiveness, but it must reconcile with the authoritative result. Never accept client-supplied damage, price, ownership, reward, inventory, or privileged destination as truth.

Load `roblox-networking` and `roblox-security` for executable patterns. Load `roblox-monetization` for purchase ownership and `roblox-data` for persistence ownership.

## 8. One canonical side-effect owner

Some operations tolerate only one owner:

- profile load, save, migration, and session release;
- purchase receipt processing and durable grants;
- authoritative currency or inventory mutation;
- cross-server message deduplication;
- external webhook side effects.

Feature modules may request these operations. They should not each implement their own save loop, receipt callback, retry policy, or shutdown handler. Duplicate owners create overwrite races and ambiguous recovery.

Player removal is a signal, not a universal persistence architecture. The canonical data owner defines leave, crash, teleport, and shutdown behavior. Other features release only the memory and resources they own.

### Player Lifecycle Wiring

Wire the ordered player lifecycle once in a single server entrypoint: `PlayerAdded` (load profile) → `CharacterAdded` → `CharacterAppearanceLoaded` (respawn/accessories) → `Humanoid.Died` → `PlayerRemoving` (release profile), and call the join handler on each pre-existing `Players:GetPlayers()` player so none is missed. Gate per-player data sends on a client-ready handshake: the client registers all remote listeners first, then fires a `ClientLoaded`-style signal; the server withholds player-owned payloads until it arrives (and handles the profile-not-yet-loaded race by waiting on that signal). [Community lead: "How to script a game server from scratch" by NullThornException, https://devforum.roblox.com/t/how-to-script-a-game-server-from-scratch-from-a-senior-engineer-tutorial/4741682; label as practitioner design.]

## 9. Split and merge criteria

Split a module when at least one is true:

- authority changes, such as client presentation versus server decision;
- state has a separate lifecycle or persistence contract;
- a pure calculation can be tested without Roblox wiring;
- dependencies and reasons to change are genuinely unrelated;
- resource ownership becomes clearer after the split.

Merge or delete a boundary when:

- it only forwards calls without policy or translation;
- its name is generic but its state belongs to one feature;
- an interface has one implementation and no independent contract;
- two modules mutate the same state;
- boilerplate exceeds the behavior it protects.

Do not build speculative plugin systems or factories for one implementation.

## 10. Architecture review

Check the real call and data flow, not just folder names. For a player-facing change, trace input → UI/world feedback → remote or simulation → authoritative state → persistence → cleanup. Co-occurring classes or files do not prove a runtime connection. Separate search-only suspicions from observed runtime behavior and verified tests.

- Every authoritative state mutation has one canonical owner.
- Shared code and instances are safe for clients to read.
- Runtime location matches execution and trust requirements.
- Public module APIs are narrow and failure behavior is explicit.
- No circular require, hidden top-level yield, or accidental concurrent startup.
- Direct dependencies remain visible; signals have a real decoupling reason.
- Connections, tasks, instances, and player-keyed caches have cleanup owners.
- Persistence and purchase callbacks are not duplicated across features.
- Tests can isolate pure behavior where doing so is useful.
- No service/controller/manager/framework layer exists only for symmetry.
- The structure is the smallest one that a new contributor can trace end to end.

## 11. Tag-Driven Composition

Use `CollectionService` tags to select instances that receive a behavior, and attributes to hold per-instance configuration. Keep the behavior owner explicit; tags are discovery, not authority.

```luau
local CollectionService = game:GetService("CollectionService")

local function attach(instance: Instance)
    -- Make this idempotent and register one cleanup owner.
end

for _, instance in CollectionService:GetTagged("DamageZone") do
    attach(instance)
end
CollectionService:GetInstanceAddedSignal("DamageZone"):Connect(attach)
CollectionService:GetInstanceRemovedSignal("DamageZone"):Connect(function(instance)
    -- Release behavior, connections, and temporary state.
end)
```

Initialize existing and future tagged instances. Treat added and removed signals as lifecycle boundaries, including client streaming. Validate attribute types and defaults, keep durable or security-sensitive state server-owned, and make attach/cleanup safe to repeat.

## Community ecosystem (leads, not sources)

Open-source study codebases ranked by DevForum likes. Read before architecting similar genres:

- [Miner's Haven](https://devforum.roblox.com/t/miners-haven-open-sourced-everything-you-need-to-make-your-own-factory-game/350767): factory/sim systems at scale.
- [Ruddev's Battle Royale](https://devforum.roblox.com/t/os-game-ruddevs-battle-royale-open-sourced/340548): full OS game.
- [Mass Uncopylocked](https://devforum.roblox.com/t/mass-uncopylocked-35-free-games-and-projects/2880269): 35 open-sourced projects (466k views).
- FPS architecture: [Writing an FPS framework](https://devforum.roblox.com/t/writing-an-fps-framework-2020/503318) series remains the most-cited framework-design walkthrough.

## ECS on Roblox: reality check

ECS is not standard practice in shipped Roblox experiences. The pattern recurs for specific problems, not as a default architecture. Do not recommend introducing one to a project that lacks one; do support projects that have one.

### When an ECS earns its cost (evidence test)

Before suggesting jecs/Matter/ECR for an existing or greenfield project, require at least one of:

- Many similar entities (hundreds+) updated every frame by order-independent logic — swarms, projectiles-with-state, RTS units, simulation ticks.
- The same cross-cutting state queried from several unrelated features, where per-entity scripts have tangled into hard-to-trace ownership.
- A team already fluent in the pattern maintaining the code.

A 10-enemy wave game, a quest system, or a shop does not meet this bar. The evidence test is the same "split only for evidence" rule this file already applies to modules, applied to data layout. The leading Luau library is [jecs](https://github.com/Ukendio/jecs) (MIT; v0.11.0, 2026-03; archetype/SoA storage per its README). Matter (matter-ecs) has been stalled since 2024; ECR is a smaller alternative. Verify current status before recommending; this list is not exhaustive.

What most production games actually use instead: OOP tables + `CollectionService` tags + attribute replication + per-system update loops with rotating work cursors. That combination delivers most of the iteration benefit without the discipline cost.

### Hooks enforce invariants; systems make decisions

jecs ships hooks (`jecs.OnAdd` / `jecs.OnRemove` / `jecs.OnChange`, set per component via `world:set(Component, jecs.OnAdd, fn)`), and its own docs draw this line: a hook is "not a replacement for systems. They are for enforcing invariants when data changes during different lifecycles. When gameplay logic that should run predictably each frame is instead scattered across hooks, behaviour becomes implicit" (jecs `how_to/999_temperance.luau`).

- Hooks: tiny, side-effect-only invariant maintenance — destroy the instance attached on removal, stamp an attribute on add, clamp a value on change. One canonical owner per mutation, same rule as elsewhere in this file.
- Systems: named, explicitly ordered functions that run every frame and own gameplay decisions (damage, targeting, spawns). Ordering is visible in code, not implicit in hook firing order.
- Logic hidden in hooks is order-dependent and hard to step through; if a hook grows a branch that decides gameplay outcomes, move it to a system.

### Documented jecs pitfalls (version-specific; re-verify against the pinned tag before relying on them)

These are v0.11.0 behaviors verified against the release notes and source (2026-10). They are facts about one version, not universal ECS laws:

- **Structural changes inside `on_remove` hard-error.** v0.11.0 release notes: `on_remove` hooks "will no longer support structural changes in its scope" and error "regardless of debug mode" when invoked by exclusive-id replacement or `world:remove`. The documented workaround is to defer: "pushing into a queue that gets flushed or inside of a deferred coroutine at the start of the next sync point".
- **Debug world.** `jecs.world(true)` installs checked wrappers that error on structural changes during entity deletion and on invalid entities/pairs. Use it in development worlds; it catches the hook-mutation class above early.
- **Query iterators are single-pass per query object.** In jecs source, a plain query memoizes its `next` closure, so a second generic-`for` over the *same* query object yields nothing; build the query where it is used or call `world:query(...)` again for a fresh iterator. Cached queries restart each iteration. Treat any library iterator as single-use unless documented otherwise, and write a test that iterates the same query twice.
- **`:with()`/`:without()` replace, not accumulate.** In source, each call overwrites the filter field, so chaining `:without(A):without(B)` excludes only B. Combine terms in one call.

Generalizable: query/filter/iterator APIs differ per library and per version. Never assume accumulate-or-reuse semantics from another ECS or from memory of a tutorial — check the pinned version's source or docs.

### Structural-change cost model

Archetype storage moves an entity between storage buckets when its component set changes; jecs's own docs state "This movement is what makes adding/removing components relatively expensive compared to just setting component values" (`how_to/030_archetypes.luau`). Consequences:

- Adding/removing components per frame is the expensive operation; mutating a field in place is cheap.
- Flipping frequently-changing boolean-like state as tag-style components (add/remove a component every frame) is the anti-pattern; store the state as a field and let change tracking observe it.

### Change tracking without hook sprawl

When a per-frame system needs added/changed/removed sets without wiring callbacks everywhere, the batched-diff pattern works on any ECS: keep a marker component storing each entity's previous relevant value, rewrite it at the end of each pass, and derive the three sets by comparing. This is community practice built on jecs signals (`world:added`/`changed`/`removed`) and its OB observer module — not a documented core API; label it as a pattern, not a feature.

### Replication: identity mapping, not shared entity ids

Never adopt a server-issued entity id directly as the client's id — client and server worlds allocate ids independently. Replicate through an explicit server→client id-mapping table:

1. Server owns authoritative world state.
2. Per tick (or on change), send a diff: newly-replicated entities with their components, changed component values, and removed entities (deletion travels as its own marker, not a missing field).
3. Joiners first receive a full snapshot, then diffs — the same "one explicit state channel" rule the networking skill states.
4. Both sides store the mapping so a server id resolves to the right client entity and vice versa; clean up mapping entries on removal or the table leaks.

### Standalone testability

Systems written as plain functions taking `(world, services)` — dependencies passed in, not reached through globals — run under a plain Luau CLI or Lune with faked inputs, without Studio. That is the same "pure core, testable without Roblox wiring" rule §9 uses for module splits, instantiated at the data layer. Keep engine-facing bits (instance spawning, replication send) at the edges of the system call so the simulation core stays headless-runnable.

## Community field notes (Tizzy discord, Jul–Sep 2026)

Practitioner reports from a live dev Discord; repeated field observations, not doc-verified claims. <!-- temporal: 2026-09 -->

- **Module-loader race pattern:** race conditions from dependency chains ("require this → require that" dominoes) cause playtests that only work after 2–3 restarts. Fix pattern: server services and client controllers don't depend on each other until their `.Init()` is called; a module loader requires all modules, then initializes all (optionally `task.spawn` per init for parallel init). Also makes the codebase far easier for AI agents to work with. Attribution: BuilderbeastYT/Ibra 2026-07-29; RBobloxian5542 2026-08-07
- **BigNum handling for simulators:** `IntValue` breaks past ~10 quadrillion; `NumberValue` extends only to ~9.22e18; the standard fix is coefficient + exponent pairs (a BigNum-style library, e.g. the "infinitemath" module). Attribution: GameForgeX; renik01; adhx5; Skardoll; Davide, 2026-07-06
- Max server size is 200 players; a "10k player server" is 10k spread across 200-slot servers. Attribution: thug, 2026-08-22
