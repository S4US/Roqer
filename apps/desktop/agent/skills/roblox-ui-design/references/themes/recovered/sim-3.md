# Recovered SIM theme body — part 3/3

> Canonical visual/construction guidance from the reference agent. Legacy tool/deployment names are provenance; current Roqer execution rules and specialized contracts/templates override those names only.

## COMPOSITION (every layout, and ESPECIALLY screens with no matching layout guide)

- Content centers on the card: every section (heading, grid of options, slot row, progress bar) is horizontally CENTERED as a group — set `HorizontalAlignment = Enum.HorizontalAlignment.Center` on the UIListLayout/UIGridLayout of every content container. A content column hugging the left edge with a dead band of white on the right is a defect.
- Section headings over content are the divider-flanked centered heading component, never a small left-aligned label floating above a grid.
- Buttons sharing one action row are UNIFORM: same height AND same width, sized to the longest label and applied to all. One stretched button beside a shorter one is a defect.
- No dead band at the bottom: the last content row ends within ~8% of the card's bottom edge. If there is leftover white, first SCALE THE CONTENT UP (bigger cells, taller rows, larger buttons) to fill the card; shrink the panel only when the content is already at full size.

## COLOR

White cards, saturated gradient stickers, dark navy line-work. Navy (42,43,49) is the ONLY outline color (panels, pills, avatar rings); black is only for glyph strokes. The panel is always WHITE: dark panels are a defect. Accents: cyan family for info/progress, yellow (252,240,111) for special labels, rainbow 6-stop gradient rot -45 for ultimate/special text only.

## COMPONENTS

- Pill controls (search boxes, icon-button clusters, page navigators): white Frame, UICorner `UDim.new(0.45, 0)`, UIStroke (42,43,49) thickness 4 ApplyStrokeMode Border, Search input: TextBox, FredokaOne, dark text (30,30,30), TextScaled. Icon buttons inside pills: square (aspect 1), ~70-75% of pill height, full-color catalog icons, never tinted. Utility pills STRADDLE the panel's top edge, right of the title, ending before the close button.
- Toggle/settings row: transparent row (aspect ~6). Label LEFT: dark navy, UITextSizeConstraint (10, 60). Control RIGHT 40% of row: a track Frame (grey gradient (194,192,220)->(148,145,167) rot 90, UIStroke (63,62,71) thickness 4, UICorner 0.125) with the canonical button as the knob/state chip on it: green "On" / red "Off". Optional cyan-gradient hint line under the label.
- Progress bar: track Frame black BackgroundTransparency 0.5, UICorner `UDim.new(1, 0)` (full pill), navy UIStroke (42,43,49) thickness 4 Border; fill Frame white + cyan-blue gradient (87,216,255)->(135,255,249) rot-90, UIStroke (42,43,49) thickness 3 Border, UICorner (1,0), Size `UDim2.new(frac, 0, 1.1, 0)` (slightly taller than the track); value text WHITE glyphs + black stroke 3, never colored glyphs.
- Section heading: centered dark-navy bare label flanked by two fade-out divider lines (Frame height 1px, black BackgroundTransparency 0.88, UIGradient transparency fading at both ends), laid out as one horizontal row. Also used as "---- Completed ----" splitters above grids.
- Notification badge: pill (UICorner 1,0) Frame with the red-pink gradient, UIStroke (48,0,0) thickness 3 Border, white count text in the heavy font with dark-red glyph stroke 1.5. Sits on a button's corner at ~0.4 of its size.
- Avatar/player row: transparent row (aspect ~6): circular avatar (UICorner (1,0), navy UIStroke 4; art = full-color catalog icon for demo rows, rbxthumb headshot only for real players) with optional circular rank badge on its rim; name block beside it (display name dark navy on light rows — never a colored glyph fill — username (84,86,98) below, no stroke); one canonical action button flush right (~32% of row width).
- Item grid cell: square cells 115-165px in a UIGridLayout, CellPadding 15-25px. Cell surface: light blue-grey fill (235,240,252), UICorner ~0.12, navy UIStroke (42,43,49) thickness 3: every cell reads as a clearly bounded slot against the white card, never white-on-white. Empty slot: the bare tinted cell with its stroke, nothing inside (the visible emptiness IS the content). Filled slot: content art (Fit, aspect 1, icons-and-images skill) + name/count; selection is a brighter surface or stroke, never a per-cell button.
- In-panel sidebar (multi-page dialogs): left pane ~30% of card width, light grey->white vertical gradient (230,230,230)->(255,255,255) rot-90, UICorner 0.055, holding a vertical stack of canonical buttons (one per page). Active page's button keeps its color; inactive ones go grey.
- Edge icon-tab rail (inventory-style dialogs): a floating column of square icon tabs straddling the card's LEFT edge (~7% card width, own shadow), icons full-color always (inactive tabs dim the TAB surface with a grey gradient, never the icon itself), red badge chips for counts.
- Dark inset input/wells (create forms, icon holders): Frame black BackgroundTransparency 0.75, UICorner ~0.125, white text with stroke.
- Locked overlay: black BackgroundTransparency 0.75 over the row/cell, UICorner 0.125, UIStroke black 3 Border, "Unlock" white label + green price button.
- ScrollingFrame: BackgroundTransparency 1, BorderSizePixel 0, ScrollBarThickness 15, ScrollBarImageColor3 (42,43,49), `AutomaticCanvasSize = Enum.AutomaticSize.Y`.

## ICONS (every image comes from the icons-and-images skill)

This theme uses NO external image assets: every construction (panels, shadows, buttons, cells, bars) is native Frames/UICorner/UIGradient/UIStroke, as specified above. Every image (title side icons, item art, tab icons, category art, currency icons) comes from the icons-and-images skill's catalog, semantically matched. Asset ids from reference UIs, invented asset ids, letters standing in for art, and empty art bands are all defects. The only non-catalog image protocol allowed is `rbxthumb://` for player avatar headshots.

Icons render in their FULL natural colors: never set ImageColor3 to a dark tint on a content icon. An icon that renders as a black or navy silhouette is a defect; leave ImageColor3 white (default) so the catalog art shows as drawn.

## ENGINE FACTS

- UIStroke defaults to ApplyStrokeMode.Contextual, which on TEXT objects (TextLabel, TextButton, TextBox) strokes the GLYPHS, not the border. A border outline on any text object MUST set `stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border` — an empty-text TextButton with a contextual stroke renders NO outline at all, the theme's most common invisible defect. Glyph strokes (title, button labels) correctly stay Contextual.
- TextScaled clamps at 100px. For display text taller than ~100px keep TextScaled AND set RichText with `<font size="N">` above 100.
- NEVER give any element a Scale width of 0: a UIAspectRatioConstraint defaults to DominantAxis Width and collapses it to an invisible 0x0 dot. Every square element (icons, close buttons, badges, slot cells) gets an explicit pixel or scale-height-driven size, e.g. `Size = UDim2.new(1, 0, 0.06, 45)` + aspect constraint, or `UDim2.fromOffset(H, H)`.
- The straddle constructions (title, close button, utility pills, side icon) intentionally extend past the Card's bounds: the Card must NOT clip: leave `ClipsDescendants = false` (default) on the Card and wrapper.
- Panel sizing idiom: wrapper `Size = UDim2.new(1, 0, H, 120)` with `UIAspectRatioConstraint.AspectRatio` from the layout guide (1.25 dialogs, 1.7 mid, 1.95 wide): the constraint fits the panel inside the height, so the panel scales down cleanly on small screens.
- Interactive elements >= 44px tall. Chunky over dainty. Rounded corners everywhere: a square-cornered element is a defect in this theme.
- Exact-fit scrolling: a partially visible row or cell at the bottom of a scroll viewport reads as CLIPPING in review, not as scrollable content. Size rows/cells so the visible area shows an exact whole number of them on first render: pick the cell height (or panel height) so `viewportHeight = N * (cellHeight + padding)` for whole N, and put any overflow fully below the fold. The same applies to footers: content rows never run under an action bar.

# LAYOUT GUIDES (load exactly one via the layout parameter)

Layout guide bodies are NOT included here. To load one, call activateSkill again with this skill's name AND the `layout` parameter set to a slug from the list below (or pass `layout` on the first activation when the UI type is already clear). Never build a new UI from an index line alone — the guide body holds the required Measurements and Rules. When EDITING an existing UI, do not load any layout guide.

- `shop-grid` — For: shops, stores, gamepass menus, bundle/offer screens: any screen selling multiple items. NOT for rebirth/confirm dialogs, inventories with selection panes, or HUDs.
- `centered-dialog` — For: rebirth, confirmations, offline earnings, prestige, prompts, "you got X" dialogs: any screen that presents a small amount of important information with one or two actions. NOT for shops, inventories, HUDs, transient toasts (notification-alert), or quest/reward boards (progression-hub).
- `fullscreen-landing` — For: main menus, title screens, play screens, intro/warning screens, loading screens, round-start and respawn screens: any screen that fills the display and blocks the game view. NOT for shops, dialogs, inventories, HUDs, or click-to-earn screens over the visible world (incremental-clicker).
- `admin-control-panel` — For: admin panels, staff/mod/owner panels, event and troll panels, developer spawn tools: any restricted console where an operator runs commands on the game or on another player. NOT for shops, settings dialogs, or player-facing menus.
- `hud-zone-system` — For: the always-on gameplay HUD (also called active-hud-overlay): currency and stat readouts, round timers and objectives, side button stacks that open menus, health/stamina bars, buff chips, action buttons. NOT for menus, shops, dialogs, any screen that blocks play, a labeled sidebar nav menu asked for on its own (vertical-navigation-sidebar), or toast stacks (notification-alert).
- `select-screen` — For: character/skin/class pickers, team select, map or mode select, hero select, job and role pickers: any screen where the player compares a few options and commits to ONE. NOT for shops (those sell), inventories (those manage), or dialogs.
- `grid-inventory` — For: inventories, pet/item storage, backpacks, lockers, collections you manage: any screen where the player looks at what they own and equips or drops it. NOT for shops (those sell), select screens (those commit to one option), or HUDs.
- `vertical-navigation-sidebar` — For: persistent sidebar menus over gameplay: a vertical stack of labeled nav buttons on a screen edge (Shop, Pets, Rewards, Codes, Settings) where each button opens its own menu. NOT for HUDs with stat readouts or icon-only corner stacks (hud-zone-system), admin category rails (admin-control-panel), or any dialog card.
- `progression-hub` — For: quest logs, daily/weekly quest boards, battle pass and season screens, achievement lists, daily reward tracks: any screen where the player reviews goals and claims earned rewards. NOT for shops (those sell), inventories (grid-inventory), rebirth/prestige confirms (centered-dialog), or leaderboards (stat-leaderboard).
- `stat-leaderboard` — For: leaderboards, rankings, top-player boards, high scores, richest lists, kill boards: any screen ranking players by a value. NOT for your OWN stat readouts on screen (hud-zone-system), select screens, or quest boards (progression-hub).
- `incremental-clicker` — For: clicker and tap-to-earn screens: a big click target that grants currency per press, with a running total (cookie-clicker style, tap simulators). NOT for HUDs (hud-zone-system), shops, upgrade menus, or any screen that blocks the world (fullscreen-landing).
- `notification-alert` — For: toasts, popup notifications, reward and achievement banners, server announcements, error and status messages: transient feedback that appears, informs, and leaves on its own. NOT for dialogs that wait for a decision (centered-dialog) or always-on readouts (hud-zone-system).
- `wheel-spin` — For: prize wheel / lucky wheel / spin-to-win screens: a radial wheel of 8 prize wedges, a pointer, a SPIN button, and spin-pack purchase buttons. NOT for vertical rolling reels (vertical-reel-roll), shops, or reward dialogs.
- `vertical-reel-roll` — For: case/crate/egg opening screens where prizes roll vertically through a center window and decelerate onto the won item (limited-item unboxing, mystery box, item roulette). NOT for radial wheels (wheel-spin) or reward dialogs.

# FINAL CHECK (the rules past runs missed most often; verify each before finishing)

Run the `visualCheck` tool and verify EACH item by looking at the screenshot, not the code. Fix and run visualCheck again until all pass:
- No element is cut by the panel bottom edge: no half-visible grid row, list row, or card at the bottom of a scroll area, and nothing runs under a footer/action bar.
- The panel sits CENTERED on screen, large (roughly half the screen or more for dialogs), nothing clipped by a screen edge.
- The title is BARE white stroked text straddling the top edge. If the screenshot shows any pill, badge, bar, or colored plate behind the title text, delete that backing element. Exactly one title exists.
- The close button visibly OVERLAPS the card corner, half in half out, no gap between it and the card.
- No text fragments peek out from behind straddling elements; nothing but the title, side icon, pills, and close button sits in the top band.
- Every list/grid/board shows 6-10 real-looking demo entries; no empty white regions, no "no data" placeholder, no grey void.
- Content fills the card: the last row ends near the bottom edge. If the lower part of the card is empty white, shrink the panel or enlarge the content.
- Cells and rows are visibly bounded (tinted fill or clear navy stroke), not white-on-white; every button has a readable label.
- EVERY button is a native rounded gradient face (UICorner 0.3 + two-stop rot-90 gradient) with a navy UIStroke thickness 4 in ApplyStrokeMode.Border (Contextual on a TextButton strokes the empty text and renders NO outline — check the SCREENSHOT for the visible navy ring, not the code). No external asset ids appear anywhere except icons from the icons-and-images catalog, rbxthumb thumbnails, and the fixed chrome/glow ids of a specialized layout guide (wheel-spin, vertical-reel-roll).
- The title side icon sits directly beside the title text as one lockup, no gap of bare card edge between them.
- Text glyph fills are only white or dark navy (colored text fills are a defect), and content icons render full-color, never as black or navy silhouettes.
- Text ON the white card is dark navy with NO stroke; text over edges, gradients, or the world is white WITH a glyph stroke; gradient colors match action semantics (green CTA, red-pink close, blue-cyan secondary, grey inactive).
- The ScreenGui sets ZIndexBehavior = Enum.ZIndexBehavior.Sibling, and every content element (text, icon) has a ZIndex above its surfaces.
