# Layout: fullscreen-landing

**Use for:** main menu/title/play screen, intro/warning, loading, round-start/respawn; screen fills display and blocks game view.  
**Not for:** ordinary panels, click-to-earn over visible world.

## Semantic contract
**The screen is the panel, and one action dominates.**

## Shared
- `IgnoreGuiInset = true`.
- Fullscreen black backdrop, transparency exactly ~0.18 for the standard variant.
- No centered dialog/card/title bar.
- Zone A (0–35% Y): title lockup.
- Zone B (35–75%): actions.
- Zone C (75–100%): mostly empty; optional footer.
- >=8% empty space above title.
- Title region ~70% screen width ×16% screen height around y~0.19.
- Primary CTA ~26%w ×11%h around y~0.50.
- Primary at least ~1.5× secondary height and ~1.8× secondary width.
- Gap from primary to secondary row >=5%, target ~7% screen height.
- Secondary actions: 2–4, each ~13%w ×7%h, gap ~2%w.
- Optional up to two corner icon buttons ~7% screen height, inset ~2%.
- Exactly one primary CTA.
- No element >30% width except title/tagline/backdrop.
- Bare labels; no plates behind title/tagline.

### Loading variant
- Same backdrop/title.
- **No buttons.**
- Progress ~50%w ×5%h near y~0.64.
- Status text ~3.5%h.
- A loading screen with active buttons is a defect.

## SIM
- Title: FredokaOne, white, navy stroke 5, usually ends `!`.
- Optional event title may use rainbow special treatment.
- Primary green `makeStickerButton`.
- Secondary controls blue; Settings is blue, not disabled-grey.

## STUDS
- Title is bare white→gold gradient text, black stroke ~3.
- Optional sunburst underlay ~1.4× rendered title width, transparency ~0.75; keep within Zone A.
- Backdrop must remain literal black; RGB channels >~0.2 or transparency >~0.30 are defects.
- Use STUDS themed buttons for CTA/secondaries.
