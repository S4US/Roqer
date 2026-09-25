# Recovered selected body: STUDS / notification-alert

> Canonical design/composition guidance recovered from the reference agent. Follow its visual, geometry, density, and failure rules. Legacy source-environment tool/deployment names are provenance; use current Roqer operations and the current specialized contract/template for wheel/reel deployment.

# SELECTED LAYOUT GUIDE (loaded via layout="notification-alert")

# LAYOUT guide: notification-alert

For: toasts, popup notifications, reward and achievement banners, server announcements, error and status messages: transient feedback that appears, informs, and leaves on its own. NOT for dialogs that wait for a decision (centered-dialog) or always-on readouts (hud-zone-system).

The defining trait: **a short-lived message chip that never blocks play.** Toasts slide in at the top of the screen, hold for seconds, and remove themselves; the player never has to touch one.

## Measurements (1080p)

- Stack container: ONE transparent Frame anchored top-center, AnchorPoint (0.5, 0), Position (0.5, 0, 0.03, 0), UIListLayout vertical with ~1% screen-height gaps. Newest toast at the TOP; the stack grows downward.
- Toast chip: ~24% screen width x ~5.5% screen height, bar construction from the style guide (bevel base + stroke 4, gradient face, edge-to-edge studs).
- Chip content: square icon (Fit, aspect 1, ~65% of chip height) LEFT with ~1.5% margin, then ONE line of TextScaled message text, white + glyph stroke, TextTruncate = AtEnd. Reward toasts carry the matching currency/item icon; plain system messages may drop the icon and center their text.
- Face color encodes type: green = success/reward, red = error/warning, gold = rare/achievement, any other bright face = information. Construction never changes, only the face color.
- Static generation renders the system MID-LIFE: 2-3 sample toasts of different types stacked in the container (a reward, an achievement, an error), hardcoded content. An empty container shows none of the layout and cannot be evaluated.
- Server-announcement variant: ONE wide banner, top-center, ~40% screen width x ~6.5% screen height, same construction, gold face. It replaces itself, never stacks; sample toasts may sit under it.
- Behavior (ONLY when a later task wires it; never during UI generation): tween in <= 0.3s, hold 3-5 seconds, tween out, Destroy; at most 3 toasts visible, a 4th removes the oldest; the announcement banner holds up to 8 seconds.

## Rules

- Toasts never block: no backdrop, no dimming, and no buttons ON a toast. A message that waits for a click is centered-dialog, not this.
- Never center-screen: the middle of the screen belongs to the game. Toasts live at the top edge.
- ONE line per toast: long text truncates. A toast wrapping to multiple lines is a defect.
- Chips are uniform: same width, same height, same construction; only the face color and content vary.
- Toasts stack; they never overlap each other or sit side by side.
