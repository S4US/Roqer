# Kit API

Every public function of the installed modules with its doc comment, copied from the modules by the update script. The modules are installed in `ReplicatedStorage`; never load them.

## StudUI (`local UI = require(ReplicatedStorage.StudUI)`)

```text
StudUI - Stud UI Clean Roblox kit for Roblox (ModuleScript)
=========================================================
Rebuilds, from scratch and without templates, every component of the "Stud UI" simulator style:
chunky 3D stud buttons, glossy purchase buttons, stud-header windows, dark glass bodies, product cards,
item slots with spinning sunbursts, stud panels, inset boxes, progress bars, pills, badges.

All measurements are in OFFSET pixels for a 1050 x 620 reference screen. Scale whole roots with a
UIScale named "WindowScale" driven by StudMotion.BindResponsive (never use Scale sizes for chrome).

Instance names are kept identical to the reference game (French): Fenetre, Entete, Corps, Biseau, Face,
Fond, Reflets, LueurBas, LiseréInterne1/2, Ombre, Texte, Icone, ... so runtime scripts written for the
reference game (recolor, tabs, disabled state) keep working on generated UI.

Quick start:
    local UI = require(path.StudUI)
    local gui = UI.ScreenGui("MenuShop", 11)
    local win = UI.Window(gui, { Size = Vector2.new(662, 448), Title = "Nest Shop", Header = "pink",
        Icon = UI.Assets.Basket })
    UI.Button(win.Entete, { Text = "Restock", Style = "Chunky", Theme = "orange", Size = Vector2.new(146, 56),
        Position = UDim2.fromOffset(511, 36) })
```

### 1. TOKENS

- `UI.seq(...)`

  ```text
  ColorSequence from colors spread evenly, or from {time, color} pairs.
  ```

- `UI.Fonts` (a table)

- `UI.Assets` (a table)

- `UI.Colors` (a table)

  ```text
  Text highlight colors (RichText <font color=...>) and semantic text colors
  ```

- `UI.ButtonThemes` (a table)

  ```text
  Button themes. Keys:
     fond   = face gradient (vertical, 90deg) - the bright color
     biseau = bottom lip gradient - the 3D thickness
     bord   = ImageButton background = 2px outer outline (darkest tone of the hue) ; also the dark reflection streak
     texte  = text outline + drop-shadow color (very dark tint of the hue, NEVER pure black)
     lueur  = optional tint of the bottom glow line (Glossy/Chunky styles)
     liserE = optional inner bevel tint (Chunky style) / gradient (Glossy style)
  ```

- `UI.Rarities` (a table)

  ```text
  Rarity ladder (Index tabs, product cards, slot accents). text = gradient on the rarity label.
  ```

- `UI.HeaderThemes` (a table)

  ```text
  Window header gradients (stud headers). "image" headers use UI.Assets.ShopHeader instead.
  ```

- `UI.PanelThemes` (a table)

  ```text
  Stud panel gradients (Daily tiles, Rebirth cards, shop offers, reward banner)
  ```

- `UI.TextGradients` (a table)

  ```text
  Text gradients
  ```

### 2. LOW LEVEL HELPERS

- `UI.new(class, props, parent)`

- `UI.Corner(parent, px)`

- `UI.Stroke(parent, color, thickness, transparency, mode, name)`

- `UI.Gradient(parent, colorSeq, rotation, name, transparency)`

- `UI.Stripes(bands)`

  ```text
  Hard-edged light stripes: bands = { {from, to, alpha}, ... } (alpha = transparency inside the band, 0.69-0.93).
  This is how the "glass reflections" are made: a white full-size Frame + a UIGradient whose TRANSPARENCY
  jumps between 1 and ~0.75 at nearly identical times. No images involved.
  ```

- `UI.ReflectionPresets` (a table)

  ```text
  Exact reflection presets measured on the reference UI (bands, rotation). Max 4 bands (NumberSequence = 20 pts).
  ```

- `UI.Reflection(parent, preset, color, zIndex)`

  ```text
  Adds a full-size reflection layer "Reflets". color = WHITE for light streaks, a dark tone for shadow streaks.
  ```

- `UI.StudsOverlay(parent, zIndex)`

  ```text
  Tiled stud overlay that fades in toward the bottom-right (stud buttons / stud headers).
  ```

- `UI.StudsFlat(parent, zIndex, transparency)`

  ```text
  Flat stud texture for panels (constant 0.82 transparency, inset 2px).
  ```

- `UI.InnerLine(parent, name, inset, color, thickness, transparency, corner, z, mode)`

### 3. TEXT

- `UI.Text(parent, text, p)`

  ```text
  Outlined text. Every text in this style has a Contextual UIStroke 2.0-4.0 thick, tinted (not pure black).
     p: Name, Size (UDim2), Position, AnchorPoint, Color, Stroke (Color3), Thickness, Font ("Heavy"|"Gotham"|"Bold"|Font),
        TextSize (number -> fixed) or Max (number -> TextScaled + UITextSizeConstraint), AlignX, AlignY, Rich, ZIndex,
        Rotation, Gradient (ColorSequence, applied to the text fill), AutoX (AutomaticSize X)
  ```

- `UI.ShadowText(parent, text, p)`

  ```text
  Extruded text: "Ombre" (same text, dark fill = stroke color, +offset px lower) under "Texte" (white).
     Used on every stud/chunky button label, HUD money, Friend Boost, X of the close button.
     p = UI.Text props + Offset (default 2: Ombre at +0, Texte at -2)
  ```

- `UI.MoneyText(parent, text, p)`

  ```text
  Big money counter (HUD): Gotham 36, lime gradient, dark green outline, 2px extrusion.
  ```

- `UI.Image(parent, image, p)`

- `UI.Sunburst(parent, size, p)`

  ```text
  Spinning-ready sunburst ("Soleil"). Rotate it with StudMotion.SpinSunbursts.
  ```

- `UI.OutlinedIcon(parent, imageDark, imageTop, p)`

  ```text
  Faux outline for a flat icon (ImageLabel has no stroke): 11 dark copies offset by 1px (+3px below = thickness),
     a grey "Tranche" 1px lower, then the white icon on top. Reference: the "+" of the money HUD.
  ```

### 4. BUTTONS

- `UI.Button(parent, p)`

  ```text
  3D button. Three styles, all built from the same layers:
     ImageButton (bg = theme.bord -> 2px outline)
      ├ Biseau   bottom lip, dark gradient (the thickness)
      ├ Face     CanvasGroup inset 2px (GroupTransparency 0.45 = disabled, GroupColor3 = inactive tint)
      │   ├ Fond        bright gradient (z1)
      │   ├ Brillance   (Glossy) top 55% white gloss
      │   ├ Reflets     diagonal hard-edged light / dark streaks (z5)
      │   ├ Studs       (Stud) tiled studs fading to bottom-right (z6)
      │   ├ LiseréInterne1/2  double inner bevel (z8)
      │   └ LueurBas    2-3px bottom glow (z8)
      ├ Icone    rotated -8deg, overflowing "sticker"
      ├ Ombre/Texte  extruded label
      └ ButtonScale (UIScale for hover/press)

     p: Name, Size (Vector2 px), Position (UDim2), AnchorPoint (default .5,.5), Theme (name|table), Style ("Stud"|"Glossy"|"Chunky"),
        Text, TextSize (Max size, scaled) or FixedTextSize, Font, Icon (image), IconSize (fraction of height, .74),
        IconLayout ("Left" default | "Top" | "Big" (square menu tile: big icon top, label bottom)), IconRotation (-8),
        Studs (bool, default true for Stud style), Reflections ({preset names}), ZIndex, LayoutOrder
  ```

- `UI.Recolor(b, theme)`

  ```text
  Re-color an existing 3D button (same contract as the reference game's ModuleMenus.Theme).
  ```

- `UI.SetButtonText(b, text)`

- `UI.SetDisabled(b, disabled)`

  ```text
  Disabled / sold-out look: the whole face fades (this is why Face is a CanvasGroup).
  ```

- `UI.CloseButton(parent, p)`

  ```text
  Square 55x55 close button with extruded "X" (Montserrat 38).
  ```

- `UI.RobuxBadge(button, price, oldPrice, icon)`

  ```text
  Robux price badge sitting on the top-right corner of a button: green robux icon + light-green price.
     oldPrice -> red struck-through price, rotated -8deg, top-left.
  ```

- `UI.RobuxContent(button, price)`

  ```text
  Robux content for purple Glossy buttons inside product cards: coin + green-gradient number.
  ```

- `UI.NotifBadge(parent, p)`

  ```text
  Red circular notification badge "!" with a UIScale "Pulse" (animate with StudMotion.PulseScale(badge.Pulse)).
  ```

### 5. CONTAINERS

- `UI.ScreenGui(name, displayOrder, p)`

  ```text
  Standard ScreenGui (+ empty "Sons" folder and "Basculer" BindableEvent used by StudMotion.Window).
  ```

- `UI.StudPanel(parent, p)`

  ```text
  Colored stud panel ("panneau"): gradient + flat studs 0.82 + thick dark stroke 3 + inner white line @0.35.
     Used for Daily tiles, Rebirth cards, shop offer banners, the gold reward banner, FREE/PREMIUM tracks.
     p: Name, Size (UDim2), Position, AnchorPoint, Gradient (ColorSequence or UI.PanelThemes key), Rotation (90), Corner (6), Stroke (3), ZIndex
  ```

- `UI.InsetBox(parent, p)`

  ```text
  Dark recessed box ("boite"): #141E24 @0.1, stroke #080C0E 2.5, inner line #4B7D91 1.2 @0.45, corner 6.
     Used for "Lvl." headers, requirements frame, HUD boost pills, bottom bars, shop sub-boxes (transparency 0.25).
  ```

- `UI.ProgressBar(parent, p)`

  ```text
  Progress bar: inset box, orange-gold fill (Remplissage.Size.X.Scale = progress) with a top gloss strip, centered value.
  ```

- `UI.Pill(parent, text, p)`

  ```text
  Rounded info pill ("Minuteur"/"Aide"): #1C242C, stroke #0A0C10 2.5, inner line #6E8CA5 1.2 @0.35, RichText Montserrat 18.
  ```

- `UI.ScrollList(parent, p)`

  ```text
  Scroll list with padding + layout. p: Size, Position, Direction ("Y"|"X"), Padding (list gap), Grid (Vector2 cell) + GridGap,
     PadTop, PadLeft, PadRight, PadBottom, BarColor
  ```

- `UI.Window(gui, p)`

  ```text
  WINDOW ("Fenetre"). Returns a table { Fenetre, Entete, Corps, Fermer, Titre, Icone, WindowScale }.
     Geometry (header height Hh = 78 stud / 81 image):
       Entete  (W x Hh) plate #070505 corner 4, z4  -> Face (W-4 x Hh-4) at (2,2): gradient + reflections + studs + bevels
       Icone   96x96 at (-14,-14) rot -10 z12  (overflows the top-left corner: "sticker")
       Titre   Montserrat 50 at (86, 39) left aligned, outline 4px
       Fermer  55x55 at (W-41, Hh/2-2)
       Corps   (W-5 x H-Hh-2) at (2, Hh) black @0.5, corner 2, stroke #020403 2
       LisereCorps (W-9 x H-Hh+17) at (3, Hh-21) white 1.5 @0.62 (thin second frame)
     p: Size (Vector2), Title, Icon, Header ("blue"|"purple"|"gold"|"pink"|"green"|ColorSequence|"image"), HeaderImage,
        IconSize, Close (bool, default true), Position, Visible (false)
  ```

### 6. CARDS & SLOTS

- `UI.ItemSlot(parent, p)`

  ```text
  Dark item slot / reward card ("Case"/"Carte"): translucent #141210 @0.35, NO corner, Bord #040302 3px, inner line
     #EBE8E4 1.4 @0.15 + hidden lime "Selection" stroke, spinning sunburst clipped inside, big icon, name at bottom,
     optional quantity top-right, tag top-left, check / lock overlay bottom-right.
     p: Name, Size (Vector2), Position, AnchorPoint, Icon, Title (name), Quantity ("x1"), Tag, TagColor, Top (text above the card,
        e.g. drop chance "60%") + TopColor, Check (bool), Lock (bool), Selected (bool), ZIndex, Button (true -> ImageButton)
  ```

- `UI.ProductCard(parent, p)`

  ```text
  Product card for shop windows (617 x 168 in a 662-wide window): dark translucent interior, double frame (black outside,
     white @0.25 inside), rarity panel image on the left with the product icon, name / rarity (gradient) / stock (gradient)
     left column, description right-aligned (Montserrat Bold 21), two Glossy buy buttons bottom-right (Robux purple, cash lime).
     p: Name, Width (617), Title, Rarity ("Common".."Cosmic"), Description, Stock ("Stock x6"), Icon, Panel (image, default rarity panel),
        Robux (number|nil), Price (string "$100"|nil), LayoutOrder
  ```

## StudMotion (`local Motion = require(ReplicatedStorage.StudMotion)`)

```text
StudMotion - motion, sound and responsive behaviour of the Stud UI Clean Roblox (client ModuleScript)
===================================================================================================
Every timing below is the exact value used by the reference game. Do not "improve" them: the snappy
0.05s press + Back-Out release IS the feel of the style.

    local Motion = require(path.StudMotion)
    Motion.BindResponsive(win.WindowScale)             -- 1050x620 reference, clamp 0.52..1.18
    Motion.BindButton(button, 1.05, gui.Sons)          -- hover 1.05 / press 0.92 / Back release
    local menu = Motion.Window(gui, win.Fenetre)       -- open/close with bounce, blur, FOV, hide other GUIs
    menu.Open()
```

- `Motion.HOVER = TweenInfo.new(0.08, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)`

- `Motion.PRESS = TweenInfo.new(0.05, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)`

- `Motion.RELEASE = TweenInfo.new(0.12, Enum.EasingStyle.Back, Enum.EasingDirection.Out)`

- `Motion.REFERENCE = Vector2.new(1050, 620)`

- `Motion.MIN_SCALE, Motion.MAX_SCALE = 0.52, 1.18`

- `Motion.BLUR, Motion.FOV_PLUS = 18, 8`

- `Motion.SOUNDS` (a table)

  ```text
  Default sound set (ids from the reference game). Use M.CreateSounds(gui.Sons) to populate a "Sons" folder.
  ```

- `Motion.CreateSounds(folder: Instance)`

- `Motion.Play(sounds, name, speed)`

- `Motion.ScreenScale()`

  ```text
  Screen factor: min(vx/1050, vy/620) clamped to [0.52, 1.18].
  ```

- `Motion.BindResponsive(uiScale: UIScale, size: number?, anim: NumberValue?)`

  ```text
  Keeps a UIScale ("WindowScale") at size * ScreenScale() (* optional animated factor NumberValue).
  ```

- `Motion.BindButton(button: GuiButton, hover: number?, sounds: Instance?, onActivated: (() -> ())?)`

  ```text
  Hover / press / release on a button's "ButtonScale" (created if missing). hover: 1.04 HUD, 1.05 menus, 1.06 close/slots.
  ```

- `Motion.Shake(obj: GuiObject)`

  ```text
  Refusal: horizontal shake -5,+5,-3,+3,0 px every 0.04s.
  ```

- `Motion.Float(obj: GuiObject, text: string, color: Color3?)`

  ```text
  Floating feedback text ("Bought!", "Not enough money") that rises ~28px and fades in 0.9s.
  ```

- `Motion.PopIn(obj: GuiObject, duration: number?)`

  ```text
  Pop-in of a slot / card that just appeared (UIScale 0 -> 1, Back Out 0.35).
  ```

- `Motion.Spin(img: GuiObject, speed: number?, reverse: boolean?)`

- `Motion.SpinSunbursts(root: Instance, speed: number?)`

- `Motion.Sway(img: GuiObject, amp: number?, freq: number?)`

- `Motion.PulseScale(sc: UIScale, amp: number?, freq: number?)`

- `Motion.PulseStroke(st: UIStroke, base: number?, amp: number?, freq: number?)`

- `Motion.StopIdle(obj)`

- `Motion.SelectTab(tabs: { GuiButton }, active: GuiButton, slide: number?, basePositions)`

  ```text
  Tabs: active tab is full color and slides 6px toward the window; inactive tabs are tinted #9696A6 through
     Face.GroupColor3 / Biseau.BackgroundColor3 / Icone.ImageColor3, label #D6D6E0. 0.15s Quad Out.
  ```

- `Motion.Window(gui: ScreenGui, fenetre: Frame, opts)`

  ```text
  Window controller (same behaviour for every menu):
     Open : Fenetre visible, WindowScale factor 0.86 -> 1 (Back Out 0.32) + slides up 24px (Quint Out 0.32),
            Lighting.Flou_Menu blur 0 -> 18 (0.3), camera FOV +8 (0.45), every other ScreenGui and the CoreGui hidden,
            sound "Ouverture".
     Close: factor -> 0.88 and down 18px (Quad In 0.16), blur -> 0 (0.28), FOV back (0.4), hide after 0.16s, restore GUIs,
            sound "Fermeture" at 0.82 pitch. X button, Escape and gamepad B close. Only one menu open at a time.
     opts: Keep = { ScreenGui names never hidden }, Group = shared table to enforce one-menu-at-a-time
  ```

- `Motion.ShowBanner(banner: GuiObject, duration: number?, sounds: Instance?)`

  ```text
  Reward banner: drops from 40px above with UIScale 0.6 -> 0.85 * screen (Back Out 0.35 + Quint Out 0.35),
     stays `duration` seconds (3.2), shrinks to 0.5 (Quad In 0.2) and hides. Sunburst spins at 30 deg/s.
  ```

- `Motion.Abbreviate(n: number, prefix: string?)`

  ```text
  "$1.2K" style abbreviation used on every price.
  ```

- `Motion.Duration(s: number)`

  ```text
  "1:02:03" or "12:34"
  ```
