# Layout: shop-grid

**Use for:** shops, stores, gamepasses, bundles, multiple items for sale.  
**Not for:** inventory, rebirth/confirm dialogs, HUD.

## Semantic contract
A dense merchandising surface. Each card contains exactly one product: name, art, price/action. Sections and offers must read as real purchasable content.

## Shared
- Use a scrolling content region when needed.
- Use layout containers, not manual positioning of grid children.
- Keep cards uniform.
- Avoid half-cut rows/cards at the viewport edge.
- Few products → shrink the overall panel rather than leaving dead space.
- A featured banner, if present, must contain a real offer.
- Robux/coin prices use the correct currency icon.

## SIM
- Dialog scaffold, aspect ~`1.7`.
- Wrapper size commonly `UDim2.new(1,0,0.46,120)` (~55×57% screen).
- Scroll begins around 12% panel height, uses remaining ~88%.
- Representative grid constants: content width `1009`, cell H `148`, column gap `14`.
- 4 products → 4 columns; 5 → 5; 6 → 2×3; avoid 5+1.
- Product card: pale `(235,240,252)`, rounded ~0.12, navy stroke 3.
- Art ~62 px; product name ~26 px.
- Green price pill near bottom, ~86% width ×34 px.
- Optional featured banner ~96 px high; white/navy/cyan styling; art ~72 px; green offer action.
- Section heading ~28 px.
- Shared action row may be ~600×72.
- For very small catalogs move panel aspect toward ~1.25.

## STUDS
- Panel ~45% screen width.
- Height adapts to content around 0.40 / 0.53 / 0.55 / 0.66.
- Title bar ~11.3%.
- Restock/status below title, not inside it.
- Scroll area inset ~13 px, gap ~10.
- Optional sparse-stud banner aspect ~3.5.
- Rows ~240 px.
- Product grid cells ~255×235, padding ~14, 3 columns.
- Card bands: name ~18%, art ~50%, buy band bottom ~28%.
- Scrollbar ~6.
- Four or more rows use 3-column scrolling.
- Every Robux price shows the exact Robux icon.
