# UI playtesting reference

Use a playtest for runtime and interaction evidence, not as a substitute for layout judgment.

- A bare playtest spawns the player but does not interact.
- Inspect the live client with `inspect_ui` before choosing a target.
- Prefer `interact_ui` when its selector resolves exactly one button or control.
- Use `simulate_mouse_input` only with current viewport coordinates from semantic bounds or a current screenshot.
- Assert the visible or game-state effect after input; delivery alone is not success.
- Read logs from the peer that produced them.
- Do not bypass a GUI handler and claim the GUI path was tested.
- Stop every playtest Roqer started, including after failure.
- Keep repairs within the retry limits in the core validation reference.
