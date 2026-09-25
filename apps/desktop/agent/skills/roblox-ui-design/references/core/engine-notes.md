# Engine and Tooling Notes

These are supporting constraints, not primary visual style.

- `TextScaled` effectively clamps around 100 px in the STUDS source. Large display text may need RichText font sizing while keeping TextScaled.
- Avoid accidental zero-width visual elements with aspect constraints; they can collapse to 0×0.
- Specialized reel templates intentionally use a zero-size positional holder whose children extend beyond it; do not generalize that pattern.
- In STUDS, explicit square pixel sizes are preferred for icons/close buttons/rank badges/slots/hubs.
- Do not put scale fractions into UDim2 offset slots.
- `AutomaticCanvasSize = Enum.AutomaticSize.Y` for scrolling content where specified.
- `Color3` serialization for Studio create/update tools uses `[r,g,b]`; if any component >1, values are interpreted as 0–255.
- Custom attributes belong in the tool's `attributes` field, not `properties`.
