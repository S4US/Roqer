# Paths

Use when building anything that follows a line: a road, a race track, a rail,
a river bank, a fence run or a wall. The rules below are facts and checks;
the layout itself is the design's to choose.

## A part between two points

Give a part that runs from A to B its two ends rather than a guessed angle.
The direction of a rotation is easy to get backwards, and the ends are what
the design actually knows.

- In Luau: `CFrame.lookAt((A + B) / 2, B)`, with the part's length on `Size.Z`.
- In `build_instances`: `position` at the midpoint and `rotation`
  `[0, yaw, 0]` with yaw = `math.deg(math.atan2(-(B.X - A.X), -(B.Z - A.Z)))`.
  Roqer applies `rotation` with `CFrame.fromOrientation`, so a yaw of θ turns
  a part's front (−Z) toward (−sin θ, −cos θ): 0 faces −Z, −90 faces +X.

## Curves

- Write the path once, as a centre line of points, and derive every strip
  from it by offsetting sideways: the surface, each kerb, each barrier. Edges
  built from one line agree; edges placed separately drift apart.
- A curve meets a straight at the straight's end and leaves in the same
  direction the straight runs. Find its centre from that: it lies on the line
  through the end, at right angles to the straight, one radius away. For a
  U-turn between two parallel straights that is midway between their ends,
  with a radius of half their separation; a corner, an S-bend or a straight at
  an angle each put it somewhere else.
- Rectangles around a curve leave wedge-shaped gaps on the outside. Size each
  one to the chord at its outer edge, 2 · r · sin(Δθ / 2) with r the outer
  radius and Δθ the angle each segment covers, so neighbours overlap on the
  inside instead. Smaller steps make a smoother edge. A strip at a different
  radius needs its own chord.
- For a surface that must look smooth rather than segmented, model it as a
  mesh ([What gets modeled](mesh-boundary.md)) and keep simple collision
  under it.

## Slopes and banking

Build the flat path first and check it. Then tilt each segment about its own
length: with the length on Z, `segment.CFrame * CFrame.Angles(0, 0, roll)`.
Check a banked or sloped path from the side as well as from above.

## Check it

- Capture a view from directly above the whole path: every segment meets its
  neighbours, each edge runs unbroken, and each curve starts and ends on the
  straights it joins.
- If players walk or drive it, go around it once in a playtest.
