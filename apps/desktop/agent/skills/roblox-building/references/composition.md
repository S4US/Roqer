# Composition

Use this when building or extending a map, area or zone. Structure, kits and
budgets make a scene correct; composition makes it read as a place. Recorded
builds were structurally sound and still looked like diagrams for the same four
reasons: hard slab edges, flat ground, over-regular layout and uniform scatter.
Plan against all four before the first batch, then check them in the overview
screenshot.

The style still decides. A blocky or symmetrical request (a castle courtyard, a
grid city, a lobby) keeps its regularity on purpose. These rules are for scenes
meant to feel natural or lived-in, and they never override the stated style,
part budget or traversal.

## 1. Finish every edge

Nothing should end as the side of a flat slab unless the style is a floating
island or a diorama.

- Give each boundary a treatment: a cliff face stepped in two or three ledges,
  a slope or wedge ramp down to a lower level, a shoreline of water or sand,
  a tree line or rock band, or a fence or wall the style supports.
- Break straight outlines. Offset edge blocks by one or two grid steps so the
  silhouette is irregular, or rotate a few edge pieces slightly.
- For Terrain, fade the height toward the edge or run it into water or a
  larger landform. Never leave a rectangular shelf.
- Extend ground a little beyond the playable area so the camera does not see
  the edge from inside it.

## 2. Build relief and a height hierarchy

Flat ground makes everything on it read as a floor plan.

- Give each area one primary level and at least one raised or sunken feature:
  a hill, mound, terrace, sunken pond or stepped plaza. Use a saved hill or
  cliff kit if the world has one.
- Put the landmark on the highest or most central ground, or give it a raised
  base, so the height order reinforces what matters.
- Keep changes walkable where the route crosses them: steps of at most about
  two studs, or ramps and stairs of path width. Playtest routes that change
  level.
- A zone named for height (summit, ridge, highlands) should actually be higher
  than its neighbours and reached by a climb.

## 3. Lay out like a place, not a diagram

- Avoid perfect rings, grids and mirror symmetry unless the style asks for
  them. Vary spacing, setbacks from the path and yaw a little (5–20 degrees),
  keeping doors facing a path.
- Let paths bend, fork and widen at meeting points. One straight spoke per
  building reads as a chart.
- Cluster: two or three buildings closer together with a gap before the next
  group reads as a neighbourhood. Leave some open ground for breathing room.
- Place props where a purpose puts them: barrels by a door, a bench facing the
  plaza, lamps along the route, not in a ring for their own sake.

## 4. Vary repetition

- Scatter with two or more templates or kit variants and unequal weights.
- Use the scatter step's `rotation` for full yaw and `scale` of about 0.8–1.25,
  not the defaults.
- Make clusters and clearings: several smaller scatter rectangles at different
  densities read better than one uniform zone. Thin density near paths and
  buildings with `avoid` distances, and thicken it at the edges, where it also
  hides the boundary.
- Rocks read as rocks when they are chunky, partly buried and grouped; single
  flat slabs read as litter.

## Check it

After the overview screenshot, and before reporting, answer each in one line:

- Edges: does any boundary end as a bare slab side?
- Relief: is there at least one real height change, and is the landmark
  emphasised by it?
- Layout: could the placement be described as a ring, grid or row when the
  style did not ask for one?
- Repetition: does any area show one template at even spacing and one scale?

With a reference image, also compare the overview with it, side by side:

- Palette: are the main surfaces the reference's colours, at its saturation
  and brightness?
- Surface: flat where it is flat, textured only where it is textured?
- Silhouettes: do edges, foliage and rocks have the reference's shapes
  (bevels, overhangs, jagged edges, blockiness)?

A yes on any of the first four, or a no on any of these three, is a defect;
fix the largest first, since a wrong palette or material outweighs any layout
detail. Fix each with the visual-repair loop in the smallest scope that owns it (an edge band, one zone's relief, one
scatter group), within the part budget, and say what remains if you stop.
