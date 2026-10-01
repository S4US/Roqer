import assert from "node:assert/strict";
import test from "node:test";

import {
  ANIMATION_ALL_CHECKS_PASSED, ANIMATION_CHECKED_AS_GAIT, ANIMATION_GAIT_CHECKS_LABEL, ANIMATION_MOTION_CHECKS_LABEL,
  ANIMATION_NAME_LABEL, ANIMATION_PLAYED_FROM_LABEL, ANIMATION_PLAYED_PUBLISHED, ANIMATION_PREVIEW_TITLE, animationSlotLabel,
  MODEL_MOVED_BY_GAME, MODEL_MOVED_BY_LABEL, MODEL_MOVED_BY_VERIFY, MODEL_WHILE_MOVING_LABEL, MODEL_WHILE_STANDING_LABEL,
  RIG_RANGE_SHEET_TITLE, type RunEvidence,
} from "../shared/run-events";
import { EVAL_TASKS, findEvalTask, needsPublishedPlace, needsUploadKey, type EvalOracleInput } from "./tasks";

function verdict(taskId: string, input: EvalOracleInput) {
  const task = findEvalTask(taskId);
  assert.ok(task, `missing task ${taskId}`);
  return task.oracle(input);
}

test("T7 accepts an efficient low-detail island instead of requiring filler parts", () => {
  const result = verdict("T7-world-blocky-island", {
    probe: {
      found: true,
      parts: 20,
      unanchored: 0,
      defaultGray: 0,
      trees: 6,
      spawns: 1,
      sizeX: 120,
      sizeY: 12,
      sizeZ: 118,
      terrainGrew: false,
    },
    outcome: "completed",
    verified: true,
    toolCalls: [{ tool: "capture_screenshot", ok: true }],
    changedTargets: [],
  });
  assert.equal(result.passed, true, result.detail);
});

test("T7 still rejects pathological part counts", () => {
  const result = verdict("T7-world-blocky-island", {
    probe: {
      found: true,
      parts: 2001,
      unanchored: 0,
      defaultGray: 0,
      trees: 6,
      spawns: 1,
      sizeX: 120,
      sizeY: 12,
      sizeZ: 118,
      terrainGrew: false,
    },
    outcome: "completed",
    verified: true,
    toolCalls: [{ tool: "capture_screenshot", ok: true }],
    changedTargets: [],
  });
  assert.equal(result.passed, false);
  assert.match(result.detail, /unreasonable number of parts/i);
});

test("T9 requires a local structured repair bracketed by visual and structural evidence", () => {
  const result = verdict("T9-world-visual-repair", {
    probe: {
      found: true,
      canopyX: 12,
      canopyY: 12,
      canopyZ: 12,
      red: 0.25,
      green: 0.6,
      blue: 0.3,
      ridgeStable: true,
    },
    outcome: "completed",
    verified: true,
    toolCalls: [
      { tool: "capture_screenshot", ok: true },
      { tool: "get_instance_properties", ok: true },
      { tool: "build_instances", ok: true },
      { tool: "get_instance_properties", ok: true },
      { tool: "capture_screenshot", ok: true },
    ],
    changedTargets: ["game.Workspace.WorkbenchEvalRepair.Cove.BadTree.Canopy"],
  });
  assert.equal(result.passed, true, result.detail);
});

test("T9 accepts an explicit post-edit Luau readback of the repaired canopy", () => {
  const result = verdict("T9-world-visual-repair", {
    probe: {
      found: true,
      canopyX: 11,
      canopyY: 11,
      canopyZ: 11,
      red: 0.2588,
      green: 0.5647,
      blue: 0.2863,
      ridgeStable: true,
    },
    outcome: "completed",
    verified: true,
    toolCalls: [
      { tool: "capture_screenshot", ok: true },
      { tool: "build_instances", ok: true },
      {
        tool: "execute_luau",
        ok: true,
        detail: "Workspace.WorkbenchEvalRepair.Cove.BadTree.Canopy | size=11, 11, 11 color=0.258824, 0.564706, 0.286275",
      },
      { tool: "capture_screenshot", ok: true },
    ],
    changedTargets: ["game.Workspace.WorkbenchEvalRepair.Cove.BadTree"],
  });
  assert.equal(result.passed, true, result.detail);
});

test("T9 does not treat a generic post-edit Luau call as structural readback", () => {
  const result = verdict("T9-world-visual-repair", {
    probe: {
      found: true,
      canopyX: 11,
      canopyY: 11,
      canopyZ: 11,
      red: 0.2588,
      green: 0.5647,
      blue: 0.2863,
      ridgeStable: true,
    },
    outcome: "completed",
    verified: true,
    toolCalls: [
      { tool: "capture_screenshot", ok: true },
      { tool: "build_instances", ok: true },
      { tool: "execute_luau", ok: true, detail: "camera=0, 70, 110" },
      { tool: "capture_screenshot", ok: true },
    ],
    changedTargets: ["game.Workspace.WorkbenchEvalRepair.Cove.BadTree"],
  });
  assert.equal(result.passed, false);
  assert.match(result.detail, /structurally read back/i);
});

test("T9 rejects collateral Ridge edits", () => {
  const result = verdict("T9-world-visual-repair", {
    probe: {
      found: true,
      canopyX: 12,
      canopyY: 12,
      canopyZ: 12,
      red: 0.25,
      green: 0.6,
      blue: 0.3,
      ridgeStable: false,
    },
    outcome: "completed",
    verified: true,
    toolCalls: [
      { tool: "capture_screenshot", ok: true },
      { tool: "build_instances", ok: true },
      { tool: "get_instance_properties", ok: true },
      { tool: "capture_screenshot", ok: true },
    ],
    changedTargets: ["game.Workspace.WorkbenchEvalRepair.Ridge.TreeA.Canopy"],
  });
  assert.equal(result.passed, false);
  assert.match(result.detail, /Ridge/i);
});

/** A flat box as the village probe reports it. */
const slab = (x: number, z: number, hx: number, hz: number, top = 1) => ({ x, z, top, h: [[hx, 0], [0, 0], [0, hz]] });

/**
 * A plain but complete village: a plaza with the landmark in it, four houses on
 * straight paths and a fifth on a diagonal one, and a spawn on the plaza.
 */
function village(overrides: Record<string, unknown> = {}) {
  const house = (name: string, x: number, z: number, kit: string) => ({ ...slab(x, z, 8, 8, 20), name, kit });
  const diagonal = { x: 23.5, z: 23.5, top: 1, h: [[8.49, 8.49], [0, 0], [-2.83, 2.83]] };
  return {
    found: true, terrainGrew: false, parts: 180, unanchored: 0, defaultGray: 0, sizeX: 150, sizeZ: 150, truncated: false,
    houses: [
      house("House_1", 50, 0, "House_A"),
      house("House_2", -50, 0, "House_B"),
      house("House_3", 0, 50, "House_A"),
      house("House_4", 0, -50, "House_B"),
      house("House_5", 40, 40, "House_A"),
    ],
    paths: [
      { ...slab(0, 0, 15, 15), name: "Path_Plaza" },
      slab(28.5, 0, 13.5, 4),
      slab(-28.5, 0, 13.5, 4),
      slab(0, 28.5, 4, 13.5),
      slab(0, -28.5, 4, 13.5),
      diagonal,
    ],
    spawns: [slab(8, 8, 3, 3, 2)],
    landmark: slab(0, 0, 6, 6, 40),
    landmarks: 1,
    registeredKits: ["House_A", "House_B", "Tree_A"],
    worldSpec: true,
    ...overrides,
  };
}

const VILLAGE_EVIDENCE = [
  { tool: "build_instances", ok: true },
  { tool: "capture_screenshot", ok: true },
  { tool: "solo_playtest", ok: true },
];

function judgeVillage(probe: unknown, toolCalls: EvalOracleInput["toolCalls"] = VILLAGE_EVIDENCE) {
  return verdict("T10-world-lowpoly-village", { probe, outcome: "completed", verified: true, toolCalls, changedTargets: [] });
}

test("T10 passes a plain village that meets every stated requirement", () => {
  const result = judgeVillage(village());
  assert.equal(result.passed, true, result.detail);
});

test("T10 names the houses no path links to the landmark", () => {
  const withoutNorth = village().paths.filter((path) => !(path.x === 0 && path.z === 28.5));
  const result = judgeVillage(village({ paths: withoutNorth }));
  assert.equal(result.passed, false);
  assert.match(result.detail, /House_3\.$/);
});

test("T10 does not let a diagonal path's bounding box stand in for reaching a house", () => {
  // Slid two studs off the plaza's corner: its bounding square still overlaps
  // the plaza, the strip itself stops about 2.8 studs short, so House_5 at the
  // other end has no route.
  const paths = village().paths.map((path) => path.x === 23.5
    ? { x: 24.5, z: 24.5, top: 1, h: [[7.5, 7.5], [0, 0], [-2.83, 2.83]] }
    : path);
  const result = judgeVillage(village({ paths }));
  assert.equal(result.passed, false);
  assert.match(result.detail, /House_5/);
});

test("T10 requires a reused kit with two variants, all of them saved", () => {
  const houses = village().houses;
  assert.match(judgeVillage(village({ houses: houses.map((house) => ({ ...house, kit: "House_A" })) })).detail, /same kit/);
  assert.match(
    judgeVillage(village({ houses: houses.map((house, index) => ({ ...house, kit: `House_${index}` })) })).detail,
    /No house kit is reused/,
  );
  assert.match(judgeVillage(village({ registeredKits: ["House_A"] })).detail, /no saved Kit entry: House_B/);
  assert.match(judgeVillage(village({ houses: [...houses.slice(1), { ...houses[0], kit: undefined }] })).detail, /House_1/);
});

test("T10 requires the landmark to stand above every house", () => {
  const result = judgeVillage(village({ landmark: slab(0, 0, 6, 6, 18) }));
  assert.equal(result.passed, false);
  assert.match(result.detail, /taller than every house/);
});

test("T10 requires the spawn to stand on the connected network", () => {
  const result = judgeVillage(village({ spawns: [slab(90, 90, 3, 3, 2)] }));
  assert.equal(result.passed, false);
  assert.match(result.detail, /SpawnLocation/);
});

test("T10 rejects Terrain, an overspent budget, and an empty probe", () => {
  assert.match(judgeVillage(village({ terrainGrew: true })).detail, /Terrain/);
  assert.match(judgeVillage(village({ parts: 1500 })).detail, /1,500-part budget/);
  assert.match(judgeVillage(village({ truncated: true })).detail, /more houses or path pieces/);
  assert.match(judgeVillage({ found: false, terrainGrew: false }).detail, /not built/);
});

test("T10 needs a screenshot of the final build and a playtest", () => {
  const stale = judgeVillage(village(), [
    { tool: "capture_screenshot", ok: true },
    { tool: "build_instances", ok: true },
    { tool: "solo_playtest", ok: true },
  ]);
  assert.match(stale.detail, /finally built/);
  // A failed write after the screenshot changed nothing, so the screenshot still stands.
  const afterFailedWrite = judgeVillage(village(), [...VILLAGE_EVIDENCE, { tool: "set_properties", ok: false }]);
  assert.equal(afterFailedWrite.passed, true, afterFailedWrite.detail);
  const unplayed = judgeVillage(village(), VILLAGE_EVIDENCE.slice(0, 2));
  assert.match(unplayed.detail, /never playtested/);
});

/** A crossing probed after a good repair: a flat deck level with the rim paths. */
function crossing(deckY = 40.6, overrides: (sample: { x: number; dz: number; y: number; bridge: boolean }) => object = (s) => s) {
  const samples = [];
  for (const dz of [-2, 2]) {
    for (let x = -26; x <= 26; x += 4) {
      const onBridge = Math.abs(x) < 20;
      samples.push(overrides({ x, dz, y: onBridge ? deckY : 40.4, bridge: onBridge }));
    }
  }
  return samples;
}

function adventure(overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    villageSame: true, forestSame: true, canyonSame: true, kitsSame: true,
    villageKept: true, forestKept: true, wellKept: true, wellX: -138,
    crossing: crossing(),
    summit: {
      box: slab(100, 290, 40, 40, 60),
      kits: ["Tree_A", "Rock_A"],
      paths: [slab(100, 262, 4, 12)],
      landmark: slab(100, 300, 5, 5, 80),
    },
    northPath: slab(100, 223, 4, 27),
    zones: ["Village", "Canyon", "Forest", "Summit"],
    ...overrides,
  };
}

const ADVENTURE_EVIDENCE = [
  { tool: "capture_screenshot", ok: true },
  { tool: "build_instances", ok: true },
  { tool: "build_instances", ok: true },
  { tool: "capture_screenshot", ok: true },
  { tool: "solo_playtest", ok: true },
];

function judgeAdventure(probe: unknown, changedTargets: string[] = [], toolCalls: EvalOracleInput["toolCalls"] = ADVENTURE_EVIDENCE) {
  return verdict("T11-world-adventure-edit", { probe, outcome: "completed", verified: true, toolCalls, changedTargets });
}

test("T11 passes a bridge repaired to walking height and a joined, registered Summit", () => {
  const result = judgeAdventure(adventure(), [
    "game.Workspace.WorkbenchEvalAdventure.Canyon.Bridge",
    "game.Workspace.WorkbenchEvalAdventure.Summit",
    "game.ServerStorage.WorkbenchEval.RoqerWorld",
  ]);
  assert.equal(result.passed, true, result.detail);
});

test("T11 fails the seeded bridge: it floats above the rim and leaves the gap open", () => {
  // The seed: a 28-stud deck topped at 46.5 over a 40-stud gap.
  const seeded = crossing(46.5, (sample) => Math.abs(sample.x) > 14 && Math.abs(sample.x) < 20
    ? { ...sample, y: 6, bridge: false }
    : sample);
  assert.match(judgeAdventure(adventure({ crossing: seeded })).detail, /drops into the canyon at x=-18/);
  // Closed but still floating: the step up onto the deck is what fails.
  assert.match(judgeAdventure(adventure({ crossing: crossing(46.5) })).detail, /6\.1-stud step near x=-18/);
});

test("T11 does not accept filling the canyon instead of repairing the bridge", () => {
  const filled = crossing(40.4, (sample) => ({ ...sample, bridge: false }));
  assert.match(judgeAdventure(adventure({ crossing: filled })).detail, /something other than the Bridge/);
});

test("T11 protects the user's edit, the untouched zones and the kits", () => {
  assert.match(judgeAdventure(adventure({ wellX: -150, villageSame: false })).detail, /undoing the user's edit/);
  assert.match(judgeAdventure(adventure({ wellKept: false })).detail, /Well was replaced/);
  assert.match(judgeAdventure(adventure({ forestKept: false })).detail, /replaced rather than left in place/);
  assert.match(judgeAdventure(adventure({ forestSame: false })).detail, /^Forest changed/);
  assert.match(judgeAdventure(adventure({ canyonSame: false })).detail, /outside the bridge/);
  assert.match(judgeAdventure(adventure({ kitsSame: false })).detail, /kits or templates/);
  // A write is caught even when it happens to leave the values as they were.
  assert.match(
    judgeAdventure(adventure(), ["game.Workspace.WorkbenchEvalAdventure.Forest.Path_North"]).detail,
    /wrote to Forest/,
  );
  assert.match(judgeAdventure(adventure(), ["game.ServerStorage.WorkbenchEval.RoqerWorld.Templates.Tree_A"]).detail, /saved templates/);
});

test("T11 requires Summit to be registered, kit-built, north of Forest and joined to its path", () => {
  const summit = adventure().summit;
  assert.match(judgeAdventure(adventure({ summit: undefined })).detail, /No Summit/);
  assert.match(judgeAdventure(adventure({ zones: ["Village", "Canyon", "Forest"] })).detail, /not registered/);
  assert.match(judgeAdventure(adventure({ summit: { ...summit, landmark: undefined } })).detail, /no Landmark/);
  assert.match(judgeAdventure(adventure({ summit: { ...summit, kits: ["Pine_New"] } })).detail, /nothing from the saved kits/);
  assert.match(judgeAdventure(adventure({ summit: { ...summit, box: slab(100, 150, 40, 40) } })).detail, /not north of Forest/);
  assert.match(judgeAdventure(adventure({ summit: { ...summit, paths: [slab(100, 275, 4, 12)] } })).detail, /joins the end/);
});

test("T11 needs a before screenshot, an after screenshot and a playtest", () => {
  assert.match(judgeAdventure(adventure(), [], ADVENTURE_EVIDENCE.slice(1)).detail, /before-and-after/);
  assert.match(judgeAdventure(adventure(), [], ADVENTURE_EVIDENCE.slice(0, 3)).detail, /before-and-after/);
  assert.match(judgeAdventure(adventure(), [], ADVENTURE_EVIDENCE.slice(0, 4)).detail, /never playtested/);
});

test("T11's seed carries valid saved intent and no unfilled template text", () => {
  const task = findEvalTask("T11-world-adventure-edit");
  assert.ok(task);
  for (const source of [task.seed, task.probe]) {
    assert.doesNotMatch(source, /\$\{|undefined|NaN/);
  }
  const documents = [...task.seed.matchAll(/doc\("(\w+)", "(\w+)", \[==\[(.*?)\]==\]\)/g)];
  assert.equal(documents.length, 7);
  for (const [, , name, json] of documents) {
    const parsed = JSON.parse(json) as { schemaVersion: number; id?: string };
    assert.equal(parsed.schemaVersion, 1);
    if (name !== "WorldSpec") assert.equal(parsed.id, name);
  }
});

test("T9 rejects a repair without a before screenshot and post-edit readback", () => {
  const result = verdict("T9-world-visual-repair", {
    probe: {
      found: true,
      canopyX: 12,
      canopyY: 12,
      canopyZ: 12,
      red: 0.25,
      green: 0.6,
      blue: 0.3,
      ridgeStable: true,
    },
    outcome: "completed",
    verified: true,
    toolCalls: [
      { tool: "build_instances", ok: true },
      { tool: "capture_screenshot", ok: true },
      { tool: "capture_screenshot", ok: true },
    ],
    changedTargets: ["game.Workspace.WorkbenchEvalRepair.Cove.BadTree.Canopy"],
  });
  assert.equal(result.passed, false);
  assert.match(result.detail, /before-and-after screenshots/i);
});

const CART = {
  found: true, parts: 5, unanchored: 0, meshParts: 3, uploadedMeshes: 3, meshColors: 2,
  length: 8.2, height: 3.1, bottom: 0.1, ground: 0, x: 30, z: 30,
};
const CART_CALLS: EvalOracleInput["toolCalls"] = [
  { tool: "run_blender_script", ok: true },
  { tool: "upload_asset", ok: true },
  { tool: "insert_asset", ok: true },
  { tool: "set_properties", ok: true },
  { tool: "capture_screenshot", ok: true },
];
const cart = (probe: Record<string, unknown>, toolCalls = CART_CALLS, verified = true) =>
  verdict("T12-model-prop", { probe: { ...CART, ...probe }, outcome: "completed", verified, toolCalls, changedTargets: [] });

test("T12 passes a modeled, uploaded, coloured cart resting on the ground", () => {
  const result = cart({});
  assert.equal(result.passed, true, result.detail);
});

test("T12 fails what the first Blender run got wrong: one colour on every mesh part, and a 1-stud model", () => {
  assert.match(cart({ meshColors: 1 }).detail, /same colour and carries no texture or vertex colours/);
  assert.match(cart({ length: 1.2 }).detail, /1\.2 studs long/);
});

test("T12 accepts a cart coloured in Blender, by texture or by vertex colours, on white mesh parts", () => {
  assert.equal(cart({ meshColors: 1, texturedMeshes: 1 }).passed, true);
  assert.equal(cart({ meshColors: 1, vertexColoredMeshes: 1 }).passed, true);
  assert.match(cart({ meshColors: 1, vertexUnread: 1 }).detail, /could not be verified/);
});

test("T12 requires a real Blender job and upload, not a Part build", () => {
  assert.match(cart({}, CART_CALLS.filter((call) => call.tool !== "run_blender_script")).detail, /No Blender job/);
  assert.match(cart({}, CART_CALLS.filter((call) => call.tool !== "upload_asset")).detail, /never uploaded/);
  assert.match(cart({ uploadedMeshes: 0 }).detail, /no uploaded mesh/);
});

test("T12 requires the cart anchored, resting on the ground, and screenshotted after the last change", () => {
  assert.match(cart({ unanchored: 2 }).detail, /not anchored/);
  assert.match(cart({ bottom: 3 }).detail, /from the ground/);
  assert.match(cart({ ground: undefined }).detail, /no ground/);
  const late = [...CART_CALLS.filter((call) => call.tool !== "set_properties"), { tool: "set_properties", ok: true }];
  assert.match(cart({}, late).detail, /No screenshot shows the cart/);
  assert.match(cart({}, CART_CALLS, false).detail, /completion gate/);
});

test("T12 names a missing or wrongly typed cart", () => {
  assert.match(cart({ found: false }).detail, /was not built/);
  assert.match(cart({ found: "not a Model" }).detail, /not a Model/);
});

test("T12 is the only task that needs the Blender worker", () => {
  assert.equal(findEvalTask("T12-model-prop")?.needsBlender, true);
  assert.equal(findEvalTask("T10-world-lowpoly-village")?.needsBlender, undefined);
});

test("T15, T18 and a Blender run check the bridge's upload key first, and other tasks do not", () => {
  const task = (id: string) => findEvalTask(id)!;
  assert.equal(needsUploadKey([task("T15-animation-run")], false), true);
  assert.equal(needsUploadKey([task("T18-npc-patrol")], false), true);
  assert.equal(needsUploadKey([task("T12-model-prop")], true), true);
  // Skipped without --blender, so it uploads nothing.
  assert.equal(needsUploadKey([task("T12-model-prop")], false), false);
  assert.equal(needsUploadKey([task("T10-world-lowpoly-village")], true), false);
});

/** A T13 probe of a map that does what the reference and the guidance ask. */
const STYLE = {
  found: true, parts: 120, textured: 0, texturedMaterials: [], distinctMeshes: 5, maxReuse: 9, collidingVisuals: 0,
  standingLevels: [0, 6, 10], ownSpawns: 1, placeSpawnsKept: true,
  worldSpec: { style: "blocky stylised, flat bright colours", paletteColours: 6 }, sizeX: 150, sizeZ: 148,
};
const STYLE_CALLS: EvalOracleInput["toolCalls"] = [
  { tool: "run_blender_script", ok: true },
  { tool: "upload_asset", ok: true },
  { tool: "insert_asset", ok: true },
  { tool: "build_instances", ok: true },
  { tool: "capture_screenshot", ok: true },
  { tool: "solo_playtest", ok: true },
];
const style = (probe: Record<string, unknown>, toolCalls = STYLE_CALLS) =>
  verdict("T13-reference-style", { probe: { ...STYLE, ...probe }, outcome: "completed", verified: true, toolCalls, changedTargets: [] });

test("T13 passes a map of reused Blender kits over flat Parts, with plateaus, its own spawn and a recorded palette", () => {
  const result = style({});
  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, /5 Blender kits \(one placed 9 times\).*plateaus 10 studs high/);
});

test("T13 fails what the live reference run did: Parts only, textured Grass, and the place's spawn moved", () => {
  assert.match(style({}, STYLE_CALLS.filter((call) => call.tool !== "run_blender_script")).detail, /No Blender job/);
  assert.match(style({ distinctMeshes: 0, maxReuse: 0 }).detail, /0 modeled kit/);
  assert.match(style({ textured: 12, texturedMaterials: ["Grass"] }).detail, /12 visible Parts use textured materials \(Grass\)/);
  assert.match(style({ placeSpawnsKept: false }).detail, /existing SpawnLocation was moved/);
});

test("T13 requires reuse, collision off the art, real plateaus, a spawn and a palette", () => {
  assert.match(style({ maxReuse: 1 }).detail, /more than once/);
  assert.match(style({ collidingVisuals: 3 }).detail, /3 visual meshes collide/);
  assert.match(style({ standingLevels: [0, 2] }).detail, /no raised plateau/);
  assert.match(style({ standingLevels: [6] }).detail, /no raised plateau/);
  assert.match(style({ ownSpawns: 0 }).detail, /no SpawnLocation of its own/);
  assert.match(style({ worldSpec: { style: "blocky", paletteColours: 2 } }).detail, /three palette colours/);
  assert.match(style({ worldSpec: undefined }).detail, /WorldSpec/);
  assert.match(style({ found: false }).detail, /not built/);
});

test("T13 needs a screenshot of the final map and a playtest", () => {
  const [blender, upload, insert, build, shot] = STYLE_CALLS;
  assert.match(style({}, [blender, upload, insert, shot, build]).detail, /finally built/);
  assert.match(style({}, [blender, upload, insert, build, shot]).detail, /never playtested/);
});

/** T14's probe of a shop, and the harness's clean audit of it. */
const SHOP = { found: true, screenGui: true, buttons: 12, observed: { texts: 30, textScaled: 0, images: 14, distinctImages: 6 } };
const CLEAN_AUDIT = { ran: true, elements: 64, issues: [] };
const SHOP_CALLS: EvalOracleInput["toolCalls"] = [
  { tool: "build_instances", ok: true },
  { tool: "solo_playtest", ok: true },
  { tool: "inspect_ui", ok: true },
  { tool: "capture_screenshot", ok: true },
];
const shop = (probe: Record<string, unknown> = {}, interfaceAudit: EvalOracleInput["interfaceAudit"] = CLEAN_AUDIT, toolCalls = SHOP_CALLS) =>
  verdict("T14-ui-polished-shop", {
    probe: { ...SHOP, ...probe }, outcome: "completed", verified: true, toolCalls, changedTargets: [], interfaceAudit,
  });

test("T14 passes a shop the harness's own audit finds clean", () => {
  const result = shop();
  assert.equal(result.passed, true, result.detail);
  assert.match(result.detail, /64 elements with a clean layout audit/);
});

test("T14 fails the live run's defects, named by the harness's audit", () => {
  const result = shop({}, { ran: true, elements: 60, issues: [
    { code: "text_obscured", path: "Players.Ada.PlayerGui.WorkbenchEvalSimShop.Card1.Title" },
    { code: "text_straddles_edge", path: "Players.Ada.PlayerGui.WorkbenchEvalSimShop.Top.Balance" },
    { code: "content_beyond_scroll", path: "Players.Ada.PlayerGui.WorkbenchEvalSimShop.Scroll.Passes" },
  ] });
  assert.equal(result.passed, false);
  assert.match(result.detail, /3 layout problem\(s\): text_obscured at Card1\.Title; text_straddles_edge at Top\.Balance; content_beyond_scroll at Scroll\.Passes\./);
});

test("T14 does not pass a shop it could not audit, or one that is not a shop", () => {
  assert.match(shop({}, { ran: false, error: "No playtest client connected.", elements: 0, issues: [] }).detail, /could not audit the shop: No playtest client/);
  const unaudited = verdict("T14-ui-polished-shop", { probe: SHOP, outcome: "completed", verified: true, toolCalls: SHOP_CALLS, changedTargets: [] });
  assert.match(unaudited.detail, /no audit was taken/);
  assert.match(shop({ found: false }).detail, /not built/);
  assert.match(shop({ screenGui: false }).detail, /not a ScreenGui/);
  assert.match(shop({ buttons: 2 }).detail, /2 buttons/);
});

test("T14 wants a screenshot after the last interface write, a builder script counting as one", () => {
  const [build, playtest, inspect, shot] = SHOP_CALLS;
  assert.match(shop({}, CLEAN_AUDIT, [build, shot, playtest, { tool: "set_script_source", ok: true }]).detail, /finally built/);
  assert.equal(shop({}, CLEAN_AUDIT, [build, playtest, inspect, { tool: "execute_luau", ok: false }, shot]).passed, true);
});

const RUN_PROBE = {
  loader: "Script", enabled: true, assetId: "555",
  owner: { id: 42, type: "User", assetType: 24 }, place: { id: 42, type: "User" }, sequences: 1,
};

/** The evidence a finished run records, labelled as the Studio tool runner labels it. */
function runEvidence(): RunEvidence[] {
  return [
    {
      id: "e1", kind: "inspection", title: ANIMATION_PREVIEW_TITLE, passed: true, imageDataUrl: "data:image/png;base64,QUJD",
      modelPreviewId: "a1b2c3d4-0", metadata: [{ label: ANIMATION_NAME_LABEL, value: "Run" }],
    },
    {
      id: "e2", kind: "verification", changeKind: "instance", title: "game.ServerStorage.WorkbenchEval.Run", passed: true,
      metadata: [
        { label: ANIMATION_MOTION_CHECKS_LABEL, value: ANIMATION_ALL_CHECKS_PASSED },
        { label: ANIMATION_GAIT_CHECKS_LABEL, value: ANIMATION_CHECKED_AS_GAIT },
      ],
    },
    { id: "e3", kind: "verification", changeKind: "asset", title: "rbxassetid://555", passed: true },
    { id: "e4", kind: "verification", changeKind: "instance", title: "game.ServerScriptService.RoqerAnimate", passed: true },
    {
      id: "e5", kind: "playtest", title: "Run on the playtest character", passed: true,
      metadata: [
        { label: ANIMATION_PLAYED_FROM_LABEL, value: ANIMATION_PLAYED_PUBLISHED },
        { label: animationSlotLabel("run"), value: "Wired" },
      ],
    },
  ];
}

function animationRun(probe: Record<string, unknown> = {}, evidence: RunEvidence[] = runEvidence(), verified = true) {
  return verdict("T15-animation-run", {
    probe: { ...RUN_PROBE, ...probe }, outcome: "completed", verified, toolCalls: [], changedTargets: [], evidence,
  });
}

const withMetadata = (evidence: RunEvidence[], id: string, label: string, value: string) => evidence.map((item) => item.id === id
  ? { ...item, metadata: item.metadata?.map((entry) => entry.label === label ? { label, value } : entry) }
  : item);

test("T15 passes a run that meets every one of the plan's conditions", () => {
  const result = animationRun();
  assert.equal(result.passed, true, result.detail);
});

test("only the tasks that judge an owner against the place's need a published place", () => {
  assert.deepEqual(EVAL_TASKS.filter((task) => needsPublishedPlace([task])).map((task) => task.id), ["T15-animation-run", "T18-npc-patrol", "T19-creature-parts", "T17-creature-blender", "T20-creature-skinned"]);
  assert.match(animationRun({ place: { id: 0, type: "User" } }).detail, /The place is not published/);
});

test("T15 wants the published animation, owned by the place's owner, in the run slot", () => {
  assert.match(animationRun({}, runEvidence().filter((item) => item.id !== "e3")).detail, /No animation was published/);
  assert.match(animationRun({ loader: false }).detail, /No RoqerAnimate loader/);
  assert.match(animationRun({ assetId: undefined }).detail, /run slot is not wired/);
  // Roblox's own run animation in the slot is not this run's.
  assert.match(animationRun({ assetId: "913376220" }).detail, /did not publish/);
  assert.match(animationRun({ owner: undefined }).detail, /could not be confirmed/);
  assert.match(animationRun({ owner: { ...RUN_PROBE.owner, id: 7 } }).detail, /not the place's owner/);
  assert.match(animationRun({ owner: { ...RUN_PROBE.owner, assetType: 10 } }).detail, /not an Animation/);
});

test("T15 wants the published asset seen playing, a 3D preview, and a gait whose checks all passed", () => {
  const evidence = runEvidence();
  assert.match(animationRun({}, withMetadata(evidence, "e5", ANIMATION_PLAYED_FROM_LABEL, "A temporary clip")).detail, /No playtest/);
  assert.match(animationRun({}, withMetadata(evidence, "e5", animationSlotLabel("run"), "Not wired")).detail, /No playtest/);
  assert.match(
    animationRun({}, evidence.map((item) => item.id === "e1" ? { ...item, modelPreviewId: undefined } : item)).detail,
    /No 3D preview/,
  );
  assert.match(
    animationRun({}, withMetadata(evidence, "e2", ANIMATION_MOTION_CHECKS_LABEL, "Passed, with footSliding waived")).detail,
    /footSliding waived/,
  );
  assert.match(animationRun({}, withMetadata(evidence, "e2", ANIMATION_GAIT_CHECKS_LABEL, "Not checked as a gait")).detail, /as a gait/);
  assert.match(animationRun({ sequences: 0 }).detail, /No KeyframeSequence/);
  assert.match(animationRun({}, evidence, false).detail, /completion gate/);
});

const OWNED = { id: 42, type: "User", assetType: 24 };
const GUARD_PROBE = {
  guard: "Model", humanoid: true, loader: "Script", enabled: true, idle: "601", walk: "602",
  idleOwner: OWNED, walkOwner: OWNED, walkGroundSpeed: 2.21, place: { id: 42, type: "User" }, sequences: 2,
};

/** The evidence a finished guard run records, labelled as the Studio tool runner labels it. */
function patrolEvidence(): RunEvidence[] {
  const built = (id: string, name: string, gait: boolean): RunEvidence => ({
    id, kind: "verification", changeKind: "instance", title: `game.ServerStorage.WorkbenchEval.${name}`, passed: true,
    metadata: [
      { label: ANIMATION_MOTION_CHECKS_LABEL, value: ANIMATION_ALL_CHECKS_PASSED },
      ...(gait ? [{ label: ANIMATION_GAIT_CHECKS_LABEL, value: ANIMATION_CHECKED_AS_GAIT }] : []),
    ],
  });
  return [
    {
      id: "p1", kind: "inspection", title: ANIMATION_PREVIEW_TITLE, passed: true, imageDataUrl: "data:image/png;base64,QUJD",
      modelPreviewId: "a1b2c3d4-0", metadata: [{ label: ANIMATION_NAME_LABEL, value: "Walk" }],
    },
    built("p2", "Idle", false),
    built("p3", "Walk", true),
    { id: "p4", kind: "verification", changeKind: "asset", title: "rbxassetid://601", passed: true },
    { id: "p5", kind: "verification", changeKind: "asset", title: "rbxassetid://602", passed: true },
    { id: "p6", kind: "verification", changeKind: "instance", title: "game.Workspace.WorkbenchEvalGuard.RoqerModelAnimate", passed: true },
    {
      id: "p7", kind: "playtest", title: "game.Workspace.WorkbenchEvalGuard in the playtest", passed: true,
      metadata: [
        { label: MODEL_MOVED_BY_LABEL, value: MODEL_MOVED_BY_GAME },
        { label: MODEL_WHILE_MOVING_LABEL, value: "walk 100%" },
        { label: MODEL_WHILE_STANDING_LABEL, value: "idle 90%, walk 10%" },
      ],
    },
  ];
}

function patrol(probe: Record<string, unknown> = {}, evidence: RunEvidence[] = patrolEvidence(), verified = true) {
  return verdict("T18-npc-patrol", {
    probe: { ...GUARD_PROBE, ...probe }, outcome: "completed", verified, toolCalls: [], changedTargets: [], evidence,
  });
}

test("T18 passes a guard whose own idle and walk played through its own patrol", () => {
  const result = patrol();
  assert.equal(result.passed, true, result.detail);
});

test("T18 wants the guard's loader holding an idle and a walk this run published, owned by the place's owner, the walk paced", () => {
  assert.match(patrol({}, patrolEvidence().filter((item) => item.changeKind !== "asset")).detail, /No animation was published/);
  assert.match(patrol({ guard: false }).detail, /no WorkbenchEvalGuard/);
  assert.match(patrol({ humanoid: false }).detail, /not a Model with a Humanoid/);
  assert.match(patrol({ loader: false }).detail, /no RoqerModelAnimate loader/);
  assert.match(patrol({ idle: undefined }).detail, /idle is not wired/);
  // Roblox's default walk, which rig puts in the loader, is not this run's.
  assert.match(patrol({ walk: "507777826" }).detail, /walk holds 507777826, which this run did not publish/);
  assert.match(patrol({ walkOwner: { ...OWNED, id: 7 } }).detail, /not the place's owner/);
  assert.match(patrol({ idleOwner: undefined }).detail, /could not be confirmed/);
  // Its first run: a place never published has no owner, whoever uploaded.
  assert.match(
    patrol({ place: { id: 0, type: "User" }, walkOwner: { ...OWNED, id: 972858366 } }).detail,
    /^The place is not published, or was opened from a file, so it has no owner for asset 601 to match/,
  );
  assert.match(patrol({ walkGroundSpeed: false }).detail, /without its ground speed/);
});

test("T18 wants a playtest after the last wiring that watched the guard's own patrol play the walk and then the idle", () => {
  const evidence = patrolEvidence();
  assert.match(patrol({}, withMetadata(evidence, "p7", MODEL_MOVED_BY_LABEL, MODEL_MOVED_BY_VERIFY)).detail, /No playtest after the last wiring/);
  assert.match(patrol({}, withMetadata(evidence, "p7", MODEL_WHILE_STANDING_LABEL, "nothing 100%")).detail, /No playtest after the last wiring/);
  assert.match(patrol({}, withMetadata(evidence, "p7", MODEL_WHILE_MOVING_LABEL, "idle 100%")).detail, /No playtest after the last wiring/);
  assert.match(patrol({}, evidence.map((item) => item.id === "p7" ? { ...item, passed: false } : item)).detail, /No playtest/);
  // A playtest before the last wire saw states that are no longer wired.
  const [p1, p2, p3, p4, p5, p6, p7] = evidence;
  assert.match(patrol({}, [p1, p2, p3, p4, p5, p7, p6]).detail, /No playtest after the last wiring/);
});

const DOG_PATH = "game.Workspace.WorkbenchEvalDog";
const DOG_PROBE = {
  dog: "Model", humanoid: true, loader: "Script", enabled: true, idle: "601", walk: "602",
  idleOwner: OWNED, walkOwner: OWNED, walkGroundSpeed: 1.85, place: { id: 42, type: "User" }, sequences: 2,
  motors: 11, meshParts: 0, feet: 4, rigStamp: "rr1:4300:eacf5e7cde01a843",
};

/** A finished dog run: the rig's read-back and range sheet, then what a guard run records, on the dog. */
function dogEvidence(): RunEvidence[] {
  const onDog = patrolEvidence().map((item) => ({ ...item, title: item.title.replace("game.Workspace.WorkbenchEvalGuard", DOG_PATH) }));
  return [
    { id: "d1", kind: "verification", changeKind: "instance", title: DOG_PATH, passed: true },
    { id: "d2", kind: "inspection", title: RIG_RANGE_SHEET_TITLE, subject: DOG_PATH, passed: true, imageDataUrl: "data:image/png;base64,QUJD", modelPreviewId: "a1b2c3d4-1" },
    ...onDog,
  ];
}

function creature(probe: Record<string, unknown> = {}, evidence: RunEvidence[] = dogEvidence(), verified = true) {
  return verdict("T19-creature-parts", {
    probe: { ...DOG_PROBE, ...probe }, outcome: "completed", verified, toolCalls: [], changedTargets: [], evidence,
  });
}

test("T19 passes a dog of Parts that rig rigged, whose own idle and walk played through its own wandering", () => {
  const result = creature();
  assert.equal(result.passed, true, result.detail);
});

test("T19 wants the dog built from Parts, with a rig that rig built, read back, declared four feet on and drew", () => {
  assert.match(creature({ dog: false }).detail, /no WorkbenchEvalDog/);
  assert.match(creature({ meshParts: 2 }).detail, /built from Parts/);
  // Joints made in hand-written Luau carry no stamp, and no pivot of theirs was checked.
  assert.match(creature({ rigStamp: false }).detail, /not built by rig/);
  assert.match(creature({}, dogEvidence().filter((item) => item.id !== "d1")).detail, /No rig call built/);
  assert.match(creature({}, dogEvidence().map((item) => item.id === "d1" ? { ...item, passed: false } : item)).detail, /did not read back/);
  assert.match(creature({ feet: 0 }).detail, /declares 0 feet on 11 joints/);
  assert.match(creature({}, dogEvidence().filter((item) => item.id !== "d2")).detail, /No range sheet/);
  // A range sheet of some other model is not the dog's.
  assert.match(creature({}, dogEvidence().map((item) => item.id === "d2" ? { ...item, subject: "game.Workspace.Cat" } : item)).detail, /No range sheet/);
});

test("T19 then holds the dog to what T18 holds the guard to", () => {
  assert.match(creature({ walk: "507777826" }).detail, /The dog's walk holds 507777826, which this run did not publish/);
  assert.match(creature({ walkGroundSpeed: false }).detail, /The dog's walk was wired without its ground speed/);
  assert.match(creature({}, withMetadata(dogEvidence(), "p7", MODEL_MOVED_BY_LABEL, MODEL_MOVED_BY_VERIFY)).detail, /watched the dog's own wandering/);
  assert.match(creature({}, withMetadata(dogEvidence(), "p3", ANIMATION_GAIT_CHECKS_LABEL, "Not checked as a gait")).detail, /checked as a gait/);
  assert.match(creature({}, dogEvidence(), false).detail, /completion gate/);
});

const WOLF_PATH = "game.Workspace.WorkbenchEvalWolf";
// The dog's probe under the wolf's key: `dog` set aside, so the judge reads the body by `wolf` alone.
const WOLF_PROBE = { ...DOG_PROBE, dog: undefined, wolf: "Model", meshParts: 11 };
const BLENDER_CALLS = [{ tool: "run_blender_script", ok: true }, { tool: "upload_asset", ok: true }];

function wolf(probe: Record<string, unknown> = {}, evidence?: RunEvidence[], toolCalls = BLENDER_CALLS) {
  const onWolf = dogEvidence().map((item) => ({
    ...item,
    title: item.title.replace(DOG_PATH, WOLF_PATH),
    ...(item.subject === undefined ? {} : { subject: item.subject.replace(DOG_PATH, WOLF_PATH) }),
  }));
  return verdict("T17-creature-blender", {
    probe: { ...WOLF_PROBE, ...probe }, outcome: "completed", verified: true, toolCalls, changedTargets: [], evidence: evidence ?? onWolf,
  });
}

test("T17 passes a wolf modelled in Blender, uploaded as pieces and rigged by rig, that walks and idles on its own", () => {
  const result = wolf();
  assert.equal(result.passed, true, result.detail);
});

test("T17 wants a Blender job, an upload, and the pieces the upload arrived as, under a rig that rig built", () => {
  assert.match(wolf({}, undefined, [{ tool: "upload_asset", ok: true }]).detail, /No Blender job succeeded; the wolf was not modelled/);
  assert.match(wolf({}, undefined, [{ tool: "run_blender_script", ok: true }, { tool: "upload_asset", ok: false }]).detail, /never uploaded/);
  // A wolf of Parts, or one uploaded as a single mesh, was not modelled as moving pieces.
  assert.match(wolf({ meshParts: 0 }).detail, /The wolf has 0 MeshParts/);
  assert.match(wolf({ meshParts: 1 }).detail, /The wolf has 1 MeshParts/);
  // The importer's rig left in place carries no stamp.
  assert.match(wolf({ rigStamp: false }).detail, /The wolf's rig was not built by rig/);
  assert.match(wolf({ feet: 0 }).detail, /The wolf's rig declares 0 feet/);
  assert.match(wolf({ walkGroundSpeed: false }).detail, /The wolf's walk was wired without its ground speed/);
});

/** The wolf as one skinned mesh: a MeshPart Roblox reports as skinned, holding its bones, under the root rig made. */
const SKINNED_PROBE = { meshParts: 1, skinnedParts: 1, bones: 16, motors: 1 };

function skinnedWolf(probe: Record<string, unknown> = {}, toolCalls = BLENDER_CALLS) {
  const onWolf = dogEvidence().map((item) => ({
    ...item,
    title: item.title.replace(DOG_PATH, WOLF_PATH),
    ...(item.subject === undefined ? {} : { subject: item.subject.replace(DOG_PATH, WOLF_PATH) }),
  }));
  return verdict("T20-creature-skinned", {
    probe: { ...WOLF_PROBE, ...SKINNED_PROBE, ...probe }, outcome: "completed", verified: true, toolCalls, changedTargets: [], evidence: onWolf,
  });
}

test("T20 passes a wolf that is one skinned mesh, rigged by rig around its bones, that walks and idles on its own", () => {
  const result = skinnedWolf();
  assert.equal(result.passed, true, result.detail);
});

test("T20 wants one skinned MeshPart holding a four-legged body's bones, under a rig that rig built", () => {
  assert.match(skinnedWolf({}, [{ tool: "upload_asset", ok: true }]).detail, /No Blender job succeeded/);
  // Pieces, or a mesh Roblox does not report as skinned, are not one skinned mesh.
  assert.match(skinnedWolf({ meshParts: 12, skinnedParts: 0 }).detail, /The wolf has 12 MeshParts, 0 of them skinned; it was to be one skinned mesh/);
  assert.match(skinnedWolf({ skinnedParts: 0 }).detail, /it was to be one skinned mesh/);
  assert.match(skinnedWolf({ bones: 4 }).detail, /The wolf's mesh holds 4 Bones/);
  assert.match(skinnedWolf({ rigStamp: false }).detail, /The wolf's rig was not built by rig/);
  // Declared but never built around: no root joins the mesh.
  assert.match(skinnedWolf({ motors: 0 }).detail, /The wolf's rig declares 4 feet on 16 joints/);
  assert.match(skinnedWolf({ feet: 0 }).detail, /The wolf's rig declares 0 feet/);
  // The pieces task still refuses one mesh.
  assert.match(wolf({ ...SKINNED_PROBE }).detail, /The wolf has 1 MeshParts/);
});

test("T18 wants a 3D preview, both sequences kept with every check passed, a gait among them, and the completion gate", () => {
  const evidence = patrolEvidence();
  assert.match(patrol({}, evidence.map((item) => item.id === "p1" ? { ...item, modelPreviewId: undefined } : item)).detail, /No 3D preview/);
  assert.match(patrol({}, evidence.filter((item) => item.id !== "p2")).detail, /Only one animation was built/);
  assert.match(
    patrol({}, withMetadata(evidence, "p2", ANIMATION_MOTION_CHECKS_LABEL, "Passed, with jointLimits waived")).detail,
    /last build of game\.ServerStorage\.WorkbenchEval\.Idle: Passed, with jointLimits waived/,
  );
  assert.match(patrol({}, withMetadata(evidence, "p3", ANIMATION_GAIT_CHECKS_LABEL, "Not checked as a gait")).detail, /checked as a gait/);
  assert.match(patrol({ sequences: 1 }).detail, /not both kept/);
  assert.match(patrol({}, evidence, false).detail, /completion gate/);
  // A failed build of a sequence that a later build replaced does not count against it.
  const failedFirst = { ...evidence[1], id: "p0", passed: false };
  assert.equal(patrol({}, [failedFirst, ...evidence]).passed, true);
});
