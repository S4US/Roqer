# Recovered STUDS theme body — part 2/2

> Canonical visual/construction guidance from the reference agent. Legacy tool/deployment names are provenance; current Roqer execution rules and specialized contracts/templates override those names only.

## COLOR

Bright saturated palette, hues flexible. Faces never dark (dark = bases/outlines/panel bg only). CTAs green; destructive may be red. Panel background BLACK at transparency 0.40. Big display numbers: UIGradient rot90 white(0)->gold(0.5)->gold(1), red variant for timers, never flat.

## COMPONENTS

- Title bar: bevel stack; scoped icon fully INSIDE the bar, sized EXACTLY `Size = UDim2.fromOffset(50, 50)`, centered vertically, left margin ~1.5%; title text FredokaOne white + stroke, LEFT-aligned, starting past the icon + 1% margin.
- Canonical button (every button in every UI): bevel base + black stroke 4, face 0.90 with the 3-stop shine, edge-to-edge studs at the button tile size. Label TextScaled in a container ~62% of button height; icon square ~55-60% of button height with explicit offset size; text+icon centered as a row, ~4% gap. Sits inside its parent face with >= 6% bottom margin; minimum 140×48; at most ~30% of its card's height, never grown to fill space.
- Cards, content bands (maximums, compressed — never stretch to fill): name 2-18%, art 20-62% (Fit, aspect 1, ends above the button band), button 66-94%. No overlaps, no dead gap between art and button; shrink the card rather than leave empty face.
- Progress bar: dark track + thickness-4 outline, bright gradient fill by fraction, centered gradient value text.
- Plain headings: bare TextLabels, no background box.

## ICONS (default NONE; integral ones mandatory)

shop basket rbxassetid://110972987269284 (SHOP title bars only) · pig+money rbxassetid://103120983042082 (money/reward art) · coin rbxassetid://84697600263846 (beside coin amounts only) · cash stack rbxassetid://70565105539676 · crystal rbxassetid://73150429062000 · diamond rbxassetid://75581768563141 · Robux rbxassetid://87608142780557 (integral to Robux buttons) · sunburst rbxassetid://91084849147872 (decorative underlay only).
Content art beyond this list: activate the `icons-and-images` skill and use a semantically matching catalog icon (a pet card gets a real pet icon; letters, empty art bands, or invented ids are defects). Only when neither list nor catalog matches: no icon.
Decorative rays/radials/circles are NEVER assembled from rotated Frames — use sunburst rbxassetid://91084849147872 as an ImageLabel underlay. A content pane always renders demo content; a decorated but empty pane is a defect.

## ENGINE FACTS

- TextScaled clamps at 100px (UITextSizeConstraint and UIScale do not lift it). For display text taller than ~100px, keep TextScaled AND set RichText with `<font size="N">` above 100.
- NEVER give any element a Scale width of 0 (`UDim2.fromScale(0, h)` / `UDim2.new(0, 0, h, 0)`), with or without a UIAspectRatioConstraint — UIAspectRatioConstraint defaults to `DominantAxis = Width`, so a zero-width element collapses to an invisible 0x0 dot (this shipped: close buttons, title icons, and an entire prize wheel rendered as nothing). Every square element (icons, close buttons, rank badges, slot cells, wheel hubs) gets an explicit pixel size: `UDim2.fromOffset(H, H)`.
- frame.AutomaticCanvasSize = Enum.AutomaticSize.Y.
- NEVER put a scale fraction in an offset slot: `UDim2.new(1, -26, 1, -0.113 - 16)` evaluates the height as full-scale minus ~16px, so the frame overflows its panel (this shipped: shop cards spilling below the panel bottom). The content region under a title bar is EXACTLY `Position = UDim2.new(0, PAD, TITLE_H, 0)`, `Size = UDim2.new(1, -2 * PAD, 1 - TITLE_H, -PAD)` — TITLE_H a scale fraction (e.g. 0.113) only ever in scale slots, PAD in px only ever in offset slots.
- Interactive elements >= 44px tall. Chunky over dainty. Square corners, no UICorner.

# LAYOUT GUIDES (load exactly one via the layout parameter)

Layout guide bodies are NOT included here. To load one, call activateSkill again with this skill's name AND the `layout` parameter set to a slug from the list below (or pass `layout` on the first activation when the UI type is already clear). Never build a new UI from an index line alone — the guide body holds the required Measurements and Rules. When EDITING an existing UI, do not load any layout guide.

- `shop-grid` — For: shops, stores, gamepass menus, bundle/offer screens: any screen selling multiple items. NOT for rebirth/confirm dialogs, inventories with selection panes, or HUDs.
- `centered-dialog` — For: rebirth, confirmations, offline earnings, prestige, prompts, "you got X" dialogs: any screen that presents a small amount of important information with one or two actions. NOT for shops, inventories, HUDs, transient toasts that dismiss themselves (notification-alert), or quest/reward boards (progression-hub).
- `fullscreen-landing` — For: main menus, title screens, play screens, intro/warning screens, loading screens, round-start and respawn screens: any screen that fills the display and blocks the game view. NOT for shops, dialogs, inventories, HUDs, or click-to-earn screens over the visible world (incremental-clicker).
- `admin-control-panel` — For: admin panels, staff/mod/owner panels, event and troll panels, developer spawn tools: any restricted console where an operator runs commands on the game or on another player. NOT for shops, settings dialogs, or player-facing menus.
- `hud-zone-system` — For: the always-on gameplay HUD (also called active-hud-overlay): currency and stat readouts, round timers and objectives, side button stacks that open menus, health/stamina bars, buff chips, action buttons. NOT for menus, shops, dialogs, any screen that blocks play, a labeled sidebar nav menu asked for on its own (vertical-navigation-sidebar), or toast stacks (notification-alert).
- `select-screen` — For: character/skin/class pickers, team select, map or mode select, hero select, job and role pickers: any screen where the player compares a few options and commits to ONE. NOT for shops (those sell), inventories (those manage), or dialogs.
- `grid-inventory` — For: inventories, pet/item storage, backpacks, lockers, collections you manage: any screen where the player looks at what they own and equips or drops it. NOT for shops (those sell), select screens (those commit to one option), or HUDs.
- `vertical-navigation-sidebar` — For: persistent sidebar menus over gameplay: a vertical stack of labeled nav buttons on a screen edge (Shop, Pets, Rewards, Codes, Settings) where each button opens its own menu. NOT for HUDs with stat readouts or icon-only corner stacks (that is hud-zone-system), admin category rails (admin-control-panel), or any bordered panel with a title bar.
- `progression-hub` — For: quest logs, daily/weekly quest boards, battle pass and season screens, achievement lists, daily reward tracks: any screen where the player reviews goals and claims earned rewards. NOT for shops (those sell), inventories (grid-inventory), rebirth/prestige confirms (centered-dialog), or leaderboards (stat-leaderboard).
- `stat-leaderboard` — For: leaderboards, rankings, top-player boards, high scores, richest lists, kill boards: any screen ranking players by a value. NOT for your OWN stat readouts on screen (that is hud-zone-system), select screens (those commit to an option), or quest boards (progression-hub).
- `incremental-clicker` — For: clicker and tap-to-earn screens: a big click target that grants currency per press, with a running total (cookie-clicker style, tap simulators). NOT for HUDs (hud-zone-system), shops, upgrade menus, or any screen that blocks the world (fullscreen-landing).
- `notification-alert` — For: toasts, popup notifications, reward and achievement banners, server announcements, error and status messages: transient feedback that appears, informs, and leaves on its own. NOT for dialogs that wait for a decision (centered-dialog) or always-on readouts (hud-zone-system).
- `wheel-spin` — For: prize wheel / lucky wheel / spin-to-win screens: a radial wheel of 8 prize wedges, a pointer, a SPIN button, and spin-pack purchase buttons. NOT for vertical rolling reels (vertical-reel-roll), shops, or reward dialogs.
- `vertical-reel-roll` — For: case/crate/egg opening screens where prizes roll vertically through a center window and decelerate onto the won item (limited-item unboxing, mystery box, item roulette). NOT for radial wheels (wheel-spin) or reward dialogs.

# FINAL CHECK (the rules past runs missed most often; verify each before finishing)

- EVERY button carries a black UIStroke thickness 4 on its outermost frame, including small price buttons.
- Every face except the title bar has its white-to-color vertical gradient; title bar faces are flat solid color.
- Stud tiles are square pixel sizes computed per element class and clearly visible; no fine/zoomed-out studs anywhere.
- The close button sits INSIDE the title bar at ~66% of its height (never filling or overflowing the bar) and owns that corner; Robux prices show the Robux icon; the title icon stays inside the bar.
- Banners contain a real product offer, and card rows span the same full width as the banner.
- No overlapping elements, no zero-size elements, one product per card, all content hardcoded.
- The ScreenGui sets ZIndexBehavior = Enum.ZIndexBehavior.Sibling, and every content element (text, icon) has a ZIndex above its face and pattern.
