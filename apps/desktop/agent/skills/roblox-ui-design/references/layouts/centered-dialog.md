# Layout: centered-dialog

**Use for:** rebirth/prestige, confirmations, offline earnings, small important prompts, reward/info dialogs with one or two actions.  
**Not for:** shops, persistent HUD, transient toast, progression board.

## Semantic contract
A loose centered composition with a small amount of important information and at most two actions. Vertical rhythm and breathing room matter more than density.

## Shared
- Max 2 actions.
- Two actions: confirm left, cancel/right; same size; gap ~3%.
- Single action centered.
- Symmetric padding.
- Bottom breathing room >=~6%.
- Reward/info cards may sit in the middle; avoid turning the dialog into a catalog.
- This layout may intentionally be less dense than general panel guidance.

## SIM
- Dialog scaffold.
- Wrapper commonly `UDim2.new(1,0,0.4,120)`.
- Aspect ~`1.25` (~36×51% screen).
- Straddling title/icon/close.
- Content gaps >=~4%.
- Divider heading ~40.
- Reward/info cards ~20–47% card width.
- Typical title ~30, description ~22, art ~56.
- Progress bar ~84% ×10%.
- Two actions around y~0.85, each ~28%×14%.
- Single action width ~40%, y~0.85.
- Optional note: navy ~26, no stroke.

## STUDS
- Panel ~45%×55%, centered around y~0.45.
- Title bar ~13.5%.
- One vertical `UIListLayout`, padding ~4%.
- Headings bare centered ~7% height.
- Reward/info blocks ~20–24% width, gap ~2%.
- Progress ~84%×13%.
- Actions ~28%×13%, y~0.82, gap ~3%.
- Optional warning uses red face + white glyph.
- Bottom breathing >=6%.
