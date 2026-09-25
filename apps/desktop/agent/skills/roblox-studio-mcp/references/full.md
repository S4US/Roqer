# Roqer Roblox MCP reference

This reference describes the MCP implemented by this repository. It is not the schema for Roblox Studio's built-in MCP server.

## Ownership and safety

The model calls only Roqer's `roblox_studio` gateway. Roqer keeps the bridge credential, selected place, approval policy, cancellation, result compaction, and read-back evidence in the host process. A skill can recommend an operation but cannot authorize it.

All calls use this envelope:

```json
{
  "operation": "get_project_structure",
  "arguments": {
    "path": "game.ServerScriptService",
    "maxDepth": 3,
    "scriptsOnly": true
  }
}
```

The selected `instance_id` is normally injected by Roqer. If selection is ambiguous, call `get_connected_instances` and stop rather than choosing a writable place by name.

## Inspection and scripts

Use `get_project_structure` for a bounded subtree, `search_objects` for name/class/property discovery, `get_instance_properties` for one target, and `grep_scripts` for source search. Prefer a stable `instanceRef` returned by inspection when an operation supports it.

`get_script_source` accepts `line_range` as `N`, `N-M`, `N-`, or `-M`. A partial read is useful for inspection but is not a safe base for replacing the entire file.

### Full source replacement

1. Read the whole script with `get_script_source`.
2. Preserve the returned `sourceRevision`.
3. Call `set_script_source` with `instancePath`, complete `source`, and `expectedRevision`.
4. Read the whole script again and verify the intended source and new revision.

Reject a stale revision instead of overwriting newer Studio state.

### Localized edits

- `edit_script_lines`: `instancePath`, exact `old_string`, and `new_string`; add `line_range` when the old text is not unique. It is the line `old_string` starts on (`42`), or a closed range (`42-48`) that covers exactly the lines `old_string` spans.
- `edit_script_batch`: `instancePath`, an `edits` array of the same `{old_string, new_string, line_range?}` entries, and the `expectedRevision` you read. Use it whenever one script needs more than one exact edit. Every `old_string` is located in the source as you read it, overlapping edits are refused, and all of them apply as one transaction producing one revision — so three separate `edit_script_lines` calls become one call, one undo entry, and one read-back. The revision is required here because a batch places several matches against one source you read: a script that changed underneath would put every one of them somewhere you never looked.
- `insert_script_lines`: `instancePath`, `newContent`, and optional `afterLine` (`0` inserts before line 1).
- `delete_script_lines`: `instancePath` and a closed inclusive `line_range` such as `12-18`.
- Pass the `revision` from the `get_script_source` read the line numbers came from as `expectedRevision` on both. If the script changed since, the edit is refused with `source_revision_conflict` instead of landing on the wrong lines; read it again and recompute the lines.
- `find_and_replace_in_scripts`: preview a broad replacement with `dryRun: true` before applying it.

Read back after every mutation. A tool-level success without the expected source is a failed verification.

Use `set_properties` for an atomic property group. Use `build_instances` to create, clone, update, tag, or remove many instances under one build root: every step is checked before Studio changes, the batch applies whole or not at all, and it is one undo step. Parents and targets must be the root or inside it; a clone source may be anywhere. Use `execute_luau` only when traversal or mutation cannot be expressed safely by a structured operation. Re-acquire references inside every `execute_luau` call; calls do not share local variables.

## Edit and runtime peers

- `execute_luau` defaults to the edit DataModel and can target supported peers.
- `eval_server_runtime` runs in the live server VM and shares the game's server `require` cache.
- `eval_client_runtime` runs in a live `client-N` VM and shares that client's `require` cache.

Use `solo_playtest {action:"start", mode:"play"}` for a single-player test and stop it in cleanup. Use `multiplayer_playtest` for multi-client lifecycle work. Query state before assuming peers exist. Read `get_runtime_logs` from the exact relevant peer, and do not confuse plugin/edit output with server or client output.

`breakpoints` records hits without pausing the playtest. Profilers, memory breakdowns, and scene analysis should be scoped to the smallest peer and duration that answers the question.

## UI, screenshots, and input

Prefer semantic state over pixels:

1. `inspect_ui` to find visible elements and stable client-session refs.
2. `interact_ui` with a selector that resolves exactly one element.
3. `capture_screenshot` when visual layout or appearance matters.
4. Use coordinate mouse input only when semantic interaction is unavailable and coordinates came from current evidence.

Refs from runtime UI are session-scoped. Re-inspect after restarting a playtest.

## Assets and local files

For Creator Store assets:

1. `search_assets`.
2. `get_asset_details` and, when useful, `get_asset_thumbnail`.
3. `preview_asset` to inspect the hierarchy, media, and security scan without insertion.
4. `insert_asset` only after provenance and suitability are acceptable. The bridge strips scripts and package links, scans again, and verifies the cleaned result before parenting it.

`generate_model` stages generated models under the bridge's generated-model area; inspect geometry, size, pivots, materials, anchoring, collision, and placement before treating one as accepted content.

`import_rbxm` requires exactly one source (`path`, `url`, or `base64`) plus `parent_path`. `export_rbxm` writes only to the explicit absolute output path. Uploading, publishing, purchasing, and broad deletion are not implied by a request to inspect or build.

## Simulation and device coverage

Use `get_simulation_state` before changing network or device simulation. Apply `set_network_profile` or `set_device_simulator` to the intended client, run a bounded scenario, then use `reset_simulation_state` in cleanup. `capture_device_matrix` is for deliberate cross-device evidence, not a substitute for semantic inspection.

## Studio lifecycle

`manage_instance` can inspect, launch, authorize, complete, or close a managed Studio process and list place revisions. A launch is owned by its returned `launch_id`; close only the launch or instance you deliberately created. Do not close unrelated Studio windows. Process-identity launches require their explicit authorize/complete sequence.

## Recovery rules

- Ambiguous place: call `get_connected_instances`; do not mutate until the target is resolved.
- Stale source: read again and re-evaluate the change; do not reuse the rejected source.
- Missing peer: inspect playtest state and start only the needed session.
- Failed write: do not claim the intended state; inspect what actually exists.
- Failed read-back: report that the change could not be verified even if the mutation returned success.
- Cancellation or refusal: stop proposing dependent calls.
- Playtest or simulation started by the run: stop or reset it in every success/failure path when possible.

## Documentation sources

Use `get_roblox_docs` for exact engine class, enum, datatype, library, or global references. Treat `get_roblox_skills` as access to Roblox Studio Assistant's installed documents, not as the Roqer skill loader.
