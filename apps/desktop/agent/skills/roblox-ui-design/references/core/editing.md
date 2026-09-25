# Editing Protocol

Use this instead of layout selection when modifying an existing UI.

1. Locate the existing builder LocalScript.
2. For a small change, search/read the relevant section first. Before a full-source write, read the whole script and retain its revision.
3. Keep ScreenGui and builder identity stable.
4. Do not select a new layout unless the user explicitly requests structural redesign.
5. Preserve current panel size, layout structure, and section arrangement unless explicitly asked to change them.
6. Touch only requested elements; unspecified properties remain exactly as they are.
7. Added elements follow the active/existing theme construction and nearby sizing conventions. If SIM/STUDS is active and source does not already make the construction obvious, load the recovered active-theme parts plus `references/selected/<theme>/<layout>.md`.
8. Added elements reuse the builder's existing motion and gloss helpers when it has them. Do not add the polish layer to a screen that lacks it unless the user asks for polish; then load `references/core/polish.md` and add it without changing the existing geometry.
9. Resolve any new ordinary icon with `resolve_icon`; exact active theme/layout assets win. Never invent an ID or draw a substitute shape for a catalog icon.
10. Read the script back after the edit, then inspect/render when available. Verify the requested change landed and unrelated UI state/geometry stayed unchanged.

Do not "improve" an edit by rebuilding the screen against a different layout or by stretching the surrounding composition.
