import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, "../agent/skills/roblox-ui-design");

async function read(relative: string): Promise<string> {
  return fs.readFile(path.join(UI_ROOT, relative), "utf8");
}

const LAYOUTS = [
  "admin-control-panel", "centered-dialog", "fullscreen-landing", "grid-inventory",
  "hud-zone-system", "incremental-clicker", "notification-alert", "progression-hub",
  "select-screen", "shop-grid", "stat-leaderboard", "vertical-navigation-sidebar",
  "vertical-reel-roll", "wheel-spin",
] as const;

test("all 28 recovered SIM/STUDS selected layout bodies ship with the desktop agent", async () => {
  for (const theme of ["sim", "studs"] as const) {
    for (const layout of LAYOUTS) {
      const source = await read(`references/selected/${theme}/${layout}.md`);
      assert.match(source, /# SELECTED LAYOUT GUIDE/, `${theme}/${layout} lost the recovered selected body`);
      assert.match(source, new RegExp(`layout=\\"${layout}\\"`), `${theme}/${layout} no longer identifies its route`);
    }
  }
});

test("the recovered STUDS shop keeps the composition anchors that prevent viewport stretching", async () => {
  const source = await read("references/selected/studs/shop-grid.md");
  assert.match(source, /Panel: 45% screen width, centered/);
  assert.match(source, /CellSize = UDim2\.fromOffset\(255, 235\)/);
  assert.match(source, /3 columns/);
  assert.match(source, /never scale cards up to fill vertical space/);
  assert.match(source, /never leave a dead region under the cards/);
});

/**
 * STUDS panels are sized as separate fractions of screen width and height, so a
 * 2248×980 Studio window stretched the shop, and every run spent a repair
 * pass locking it. The lock is now part of the construction.
 */
test("a STUDS panel keeps its 1080p proportions on wide and narrow windows", async () => {
  const generation = await read("references/core/generation.md");
  assert.match(generation, /`AspectRatio = \(widthScale × 16\) \/ \(heightScale × 9\)`/);
  assert.match(generation, /from the panel's `AbsoluteSize`, not the viewport/);
  const shop = await read("references/selected/studs/shop-grid.md");
  assert.match(shop, /1080p proportions locked by a `UIAspectRatioConstraint`/);
});

test("the recovered STUDS theme keeps its load-bearing construction rules", async () => {
  const source = `${await read("references/themes/recovered/studs-1.md")}\n${await read("references/themes/recovered/studs-2.md")}`;
  assert.match(source, /4-layer bevel stack/);
  assert.match(source, /applyCloseButton/);
  assert.match(source, /rbxassetid:\/\/92521981645530/);
  assert.match(source, /rbxassetid:\/\/102751665779866/);
  assert.match(source, /350px right and 70px down/);
});

/**
 * The recovered themes banned all motion, and a model that followed them built
 * a correct but lifeless shop even when asked for a polished one. Motion is now
 * allowed as a presentation layer that adds to the theme and never replaces it,
 * while data and game behavior stay unwired.
 */
test("themed screens get the polish layer's motion but still wire no game behavior", async () => {
  const polish = await read("references/core/polish.md");
  assert.match(polish, /never resizes, moves, recolors, or replaces a canonical element/);
  assert.match(polish, /Never tween the `Size` or `Position` of anything/);
  assert.match(polish, /No `RunService` per-frame work/);
  assert.match(polish, /never buy, grant, or read game data/);
  assert.match(polish, /never to `wheel-spin` or `vertical-reel-roll`/);

  for (const part of ["references/themes/recovered/sim-1.md", "references/themes/recovered/studs-1.md"]) {
    const source = await read(part);
    assert.doesNotMatch(source, /no RunService or TweenService/, part);
    assert.match(source, /TweenService is allowed only for the presentation motion in Roqer's polish layer/, part);
    assert.match(source, /no MarketplaceService or product lookups, no RemoteEvents or RemoteFunctions/, part);
  }

  // A tilted tag on a card scrolled out of view drew below the panel: Roblox
  // does not clip rotated descendants of a ScrollingFrame.
  assert.match(polish, /Nothing inside a `ScrollingFrame` is rotated/);
  assert.match(polish, /small upright sticker/);
  assert.doesNotMatch(polish, /rotated sticker|floats or rocks/);

  const entrypoint = await read("SKILL.md");
  assert.match(entrypoint, /`references\/core\/polish\.md`, except for `wheel-spin` and `vertical-reel-roll`/);
  assert.match(entrypoint, /Never build from a theme or selected body you have not received in full/);
});

test("the UI entrypoint gives recovered selected bodies precedence over generic GUI geometry", async () => {
  const source = await read("SKILL.md");
  assert.match(source, /references\/selected\/studs\/<layout>\.md/);
  assert.match(source, /authoritative for geometry\/composition/i);
  assert.match(source, /generic `roblox-gui` layout advice/);
  // The design-canvas + uniform-root-scale technique is still documented, now
  // scoped to reproducing a reference image rather than offered for any layout.
  assert.match(source, /uniform root `UIScale`/);
});
