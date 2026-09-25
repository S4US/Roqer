---
name: roblox-studio-mcp
description: "Detailed reference for Roqer's Studio bridge beyond the contract already in your instructions: Creator Store assets, generated models, rbxm import/export, network and device simulation, profilers and breakpoints, and Studio process lifecycle."
last_reviewed: 2026-09-22
sources:
  - ../../../../../packages/core/src/tools/definitions.ts
  - ../../../../../docs/configuration.md
  - ../../../../../docs/token-efficiency.md
---

# Roqer Roblox MCP

## When to load

Your developer instructions already carry the contract every Studio task needs: the `roblox_studio` envelope, safe script writes, peers, playtest lifecycle, and UI evidence. Ordinary inspection, script and property edits, playtests, and UI work do not need this skill. Load it only when a task goes deeper into one of these: Creator Store assets, generated models, rbxm import/export, network and device simulation, profilers and breakpoints, or launching and closing Studio processes.

## Tool boundary

Roqer exposes the bridge as one `roblox_studio` tool:

```json
{"operation":"get_place_info","arguments":{}}
```

Use operation names and argument fields from this skill and the live tool description. Roqer injects the selected `instance_id` when it is absent, then applies its own read-only/approval policy before dispatch. Never try to bypass that boundary or treat a successful request as proof of the intended result.

Some other `roblox-brain` domain skills use official or bridge-neutral MCP names. Translate those recommendations by capability to the operations listed here; do not call a name that the live `roblox_studio` schema does not expose.

## Default workflow

1. Inspect the connected instance, relevant subtree, properties, and scripts.
2. Choose the narrowest structured operation that can perform the task.
3. For scripts, read source first. Use its revision for `set_script_source`, or use a localized exact edit when that is safer.
4. Apply one bounded logical change.
5. Read back the changed object or script and compare the result.
6. Playtest, inspect runtime state, and capture evidence only when the request needs it — then stop what you started.

When more than one place may be connected, start with `get_connected_instances`. Do not guess a target. Treat edit, server, and `client-N` as distinct peers.

## High-value operations

- Discover: `get_connected_instances`, `get_place_info`, `get_project_structure`, `search_objects`, `get_instance_properties`, `get_attributes`, `grep_scripts`
- Scripts and instances: `get_script_source`, `set_script_source`, `edit_script_lines`, `edit_script_batch`, `insert_script_lines`, `delete_script_lines`, `set_properties`, `build_instances`, `selection`, `find_and_replace_in_scripts`
- Runtime and tests: `solo_playtest`, `multiplayer_playtest`, `execute_luau`, `eval_server_runtime`, `eval_client_runtime`, `get_runtime_logs`, `breakpoints`
- UI and visual evidence: `inspect_ui`, `interact_ui`, `capture_screenshot`, `simulate_mouse_input`, `simulate_keyboard_input`
- Performance and simulation: `capture_script_profiler`, `capture_micro_profiler`, `get_memory_breakdown`, `get_scene_analysis`, `get_simulation_state`, `set_network_profile`, `set_device_simulator`, `capture_device_matrix`, `reset_simulation_state`
- Assets and files: `search_assets`, `get_asset_details`, `get_asset_thumbnail`, `preview_asset`, `insert_asset`, `generate_model`, `upload_asset`, `import_rbxm`, `export_rbxm`
- Reference and lifecycle: `get_roblox_docs`, `get_roblox_skills`, `manage_instance`

`solo_playtest` and `multiplayer_playtest` are stateful: a started playtest keeps Studio in play mode until something stops it. Start with `solo_playtest {action: "start", mode: "play"}`, read logs from the exact peer that produced them, and always stop with `solo_playtest {action: "stop"}` when the scenario is done. `manage_instance` belongs to that lifecycle group too — it launches and closes Studio processes, and never creates a DataModel instance.

Use `get_roblox_skills` only for Roblox Studio Assistant's installed skill documents. Roqer's bundled `roblox-brain` skills are loaded with `load_skill` instead.

For operation selection, peer routing, safe writes, assets, tests, and recovery details, load [references/full.md](references/full.md).
