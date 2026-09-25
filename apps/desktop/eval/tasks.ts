/**
 * The seeded tasks the harness runs.
 *
 * Tasks are added when an observed failure gives them a concrete purpose. The
 * set now covers ordinary mutation/debugging, UI creation/editing, construction
 * choice, one visual-repair loop, and one composed village rather than trying to predict every task
 * shape up front.
 *
 * Every task owns a subtree under one root so `reset.ts` can restore the place
 * to a known state by destroying and rebuilding exactly that subtree, and so a
 * run that wanders outside it is detectable rather than merely untidy.
 */

import { connectedGroups, footprint, footprintGap, readBox } from "./footprints";
import type { InterfaceAudit } from "./interface-audit";

export const EVAL_ROOT = "ServerStorage.WorkbenchEval";

export type EvalOracleInput = {
  /** Whatever `probe` returned, already parsed. */
  probe: unknown;
  outcome: string;
  /** True when the host completion gate was satisfied. */
  verified: boolean;
  toolCalls: ReadonlyArray<{ tool: string; ok: boolean; detail?: string }>;
  changedTargets: readonly string[];
  /** The harness's own audit of the task's interface, when the task names one. */
  interfaceAudit?: InterfaceAudit;
};

export type EvalVerdict = { passed: boolean; detail: string };

export type EvalTask = {
  id: string;
  /** What the user would type. */
  prompt: string;
  /** Luau that builds this task's starting state under `EVAL_ROOT`. */
  seed: string;
  /** Luau returning a table the oracle reads. Runs after the agent finishes. */
  probe: string;
  /**
   * Instance paths this task legitimately touches. A write outside this set is
   * reported: it is the cheapest signal that an agent solved the right problem
   * in the wrong place.
   */
  allowedTargets: readonly string[];
  /**
   * Roots whose whole subtree is on target. A world build legitimately writes
   * under sub-roots it chooses (`Village.Houses`, `RoqerWorld.Kit`), which no
   * exact list can name in advance. Leave it out where a write to a sibling
   * must count as off target, as T9 does.
   */
  allowedRoots?: readonly string[];
  /**
   * The task can only be solved with the local Blender worker, so the harness
   * runs it only when given `--blender` and offers the tool to the planner.
   */
  needsBlender?: boolean;
  /** An image in `eval/fixtures` attached to the prompt, as a user pastes a style reference. */
  referenceImage?: string;
  /**
   * A ScreenGui under StarterGui that the harness audits itself after the run,
   * in its own playtest, so the score rests on what Studio measures.
   */
  auditInterface?: string;
  oracle: (input: EvalOracleInput) => EvalVerdict;
};

/** Whether a recorded change stays inside what the task allows. */
export function isAllowedTarget(task: EvalTask, target: string): boolean {
  return task.allowedTargets.includes(target) ||
    (task.allowedRoots ?? []).some((root) => target === root || target.startsWith(`${root}.`));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function field(probe: unknown, key: string): unknown {
  return isRecord(probe) ? probe[key] : undefined;
}

/**
 * Probe Luau reporting a box as its centre, top, and XZ half-axes: enough for
 * the oracle to project it exactly (see footprints.ts), where an axis-aligned
 * box would not be. Defines `r`, `box(cframe, size)`, and `boxOf(item)`.
 */
const BOX_LUAU = `
      local function r(n) return math.floor(n * 10 + 0.5) / 10 end
      local function box(cf, size)
        local x, y, z = cf.RightVector * (size.X / 2), cf.UpVector * (size.Y / 2), cf.LookVector * (size.Z / 2)
        return {
          x = r(cf.Position.X), z = r(cf.Position.Z),
          top = r(cf.Position.Y + math.abs(x.Y) + math.abs(y.Y) + math.abs(z.Y)),
          h = { { r(x.X), r(x.Z) }, { r(y.X), r(y.Z) }, { r(z.X), r(z.Z) } },
        }
      end
      local function boxOf(item)
        if item:IsA("Model") then return box(item:GetBoundingBox()) end
        return box(item.CFrame, item.Size)
      end
`;

/**
 * Probe Luau defining `worldHalf(part)`: the half-size of a part's world
 * axis-aligned box, rotation included. `Position ± Size / 2` is not that: the
 * second village edged its ground with 160-stud wedges turned 90°, which that
 * formula counted along X and reported as a 326-stud village that was 172.
 */
const EXTENT_LUAU = `
      local function worldHalf(part)
        local cf, s = part.CFrame, part.Size / 2
        local function axis(right, up, look) return math.abs(right) * s.X + math.abs(up) * s.Y + math.abs(look) * s.Z end
        return Vector3.new(
          axis(cf.RightVector.X, cf.UpVector.X, cf.LookVector.X),
          axis(cf.RightVector.Y, cf.UpVector.Y, cf.LookVector.Y),
          axis(cf.RightVector.Z, cf.UpVector.Z, cf.LookVector.Z))
      end
`;

/**
 * A fingerprint of a subtree: every descendant's path and class, with the
 * transform, size, color, material and collision of each part and the value of
 * each StringValue. Sorted, so sibling order does not matter. Two readings are
 * equal only if nothing a player or the saved intent could notice changed.
 */
const SIGNATURE_LUAU = `
      local function signature(container, skip)
        local rows = {}
        for _, item in ipairs(container:GetDescendants()) do
          if skip == nil or (item ~= skip and not item:IsDescendantOf(skip)) then
            local row = item:GetFullName() .. "|" .. item.ClassName
            if item:IsA("BasePart") then
              local p, o, s, c = item.Position, item.Orientation, item.Size, item.Color
              row ..= string.format("|%.2f,%.2f,%.2f|%.1f,%.1f,%.1f|%.2f,%.2f,%.2f|%d,%d,%d|%s|%s|%s",
                p.X, p.Y, p.Z, o.X, o.Y, o.Z, s.X, s.Y, s.Z,
                math.floor(c.R * 255 + 0.5), math.floor(c.G * 255 + 0.5), math.floor(c.B * 255 + 0.5),
                item.Material.Name, tostring(item.Anchored), tostring(item.CanCollide))
            elseif item:IsA("StringValue") then
              row ..= "|" .. item.Value
            end
            table.insert(rows, row)
          end
        end
        table.sort(rows)
        return table.concat(rows, "\\n")
      end
`;

/**
 * T11's map sits on 40-stud ground blocks, so the canyon is a real drop: at the
 * baseplate's height a player could walk around a broken bridge. It is centred
 * 200 studs north so the place's default SpawnLocation is not inside it.
 */
const ADVENTURE_GROUND = 40;
const ADVENTURE_Z = 200;
/** Forest's north path ends here; Summit's path has to meet it. */
const FOREST_NORTH_EDGE = ADVENTURE_Z + 50;
/** The canyon's gap between its two plateaus, in world X. */
const CANYON_HALF_GAP = 20;
const SEEDED_KITS = ["House_A", "Tree_A", "Rock_A"] as const;
const REGISTRY_PATH = `game.${EVAL_ROOT}.RoqerWorld`;

const at = (x: number, z: number) => [x, ADVENTURE_GROUND, z + ADVENTURE_Z];
const zoneDoc = (id: string, minX: number, maxX: number, extra: Record<string, unknown>) => JSON.stringify({
  schemaVersion: 1,
  id,
  shape: { kind: "rect", min: [minX, ADVENTURE_Z - 50], max: [maxX, ADVENTURE_Z + 50] },
  elevation: ADVENTURE_GROUND,
  ...extra,
});
const kitDoc = (id: string, paletteSlots: Record<string, string>) => JSON.stringify({
  schemaVersion: 1,
  id,
  source: { kind: "template", path: `${REGISTRY_PATH}.Templates.${id}` },
  paletteSlots,
  sockets: {},
});
/** The saved intent T11 starts from. The Well's entry is where it was built, not where the user later moved it. */
const ADVENTURE_DOCS: ReadonlyArray<readonly [string, string, string]> = [
  ["registry", "WorldSpec", JSON.stringify({
    schemaVersion: 1,
    buildRoot: "game.Workspace.WorkbenchEvalAdventure",
    origin: at(0, 0),
    style: "chunky low-poly adventure map on raised ground blocks, flat SmoothPlastic colors",
    grid: 2,
    verticalStep: 1,
    palette: {
      grass: { color: [0.416, 0.667, 0.329], material: "SmoothPlastic" },
      path: { color: [0.839, 0.745, 0.549], material: "SmoothPlastic" },
      stone: { color: [0.549, 0.549, 0.588], material: "SmoothPlastic" },
      wood: { color: [0.471, 0.322, 0.204], material: "SmoothPlastic" },
      leaf: { color: [0.243, 0.502, 0.275], material: "SmoothPlastic" },
      wall: { color: [0.941, 0.886, 0.769], material: "SmoothPlastic" },
      roof: { color: [0.769, 0.329, 0.251], material: "SmoothPlastic" },
    },
    budgets: { maxParts: 1500 },
  })],
  ["kit", "House_A", kitDoc("House_A", { Walls: "wall", Door: "wood", RoofFront: "roof", RoofBack: "roof" })],
  ["kit", "Tree_A", kitDoc("Tree_A", { Trunk: "wood", Canopy: "leaf" })],
  ["kit", "Rock_A", kitDoc("Rock_A", { Rock: "stone" })],
  ["zones", "Village", zoneDoc("Village", -150, -50, {
    routes: [{ id: "main", points: [at(-130, 0), at(-50, 0)], width: 8 }],
    landmarks: [{ id: "Well", position: at(-150, 20) }],
  })],
  ["zones", "Canyon", zoneDoc("Canyon", -50, 50, {
    routes: [{ id: "main", points: [at(-50, 0), at(50, 0)], width: 8 }],
    landmarks: [{ id: "Bridge", position: at(0, 0) }],
  })],
  ["zones", "Forest", zoneDoc("Forest", 50, 150, {
    routes: [
      { id: "main", points: [at(50, 0), at(100, 0)], width: 8 },
      { id: "north", points: [at(100, 0), at(100, 50)], width: 8 },
    ],
    landmarks: [],
  })],
];

const ADVENTURE_SEED = `
      local CollectionService = game:GetService("CollectionService")
      local old = workspace:FindFirstChild("WorkbenchEvalAdventure")
      if old then old:Destroy() end
      local O = Vector3.new(0, ${ADVENTURE_GROUND}, ${ADVENTURE_Z})
      local GRASS, PATH, STONE, DARK = Color3.fromRGB(106, 170, 84), Color3.fromRGB(214, 190, 140), Color3.fromRGB(140, 140, 150), Color3.fromRGB(92, 88, 96)
      local WOOD, LEAF, WALL, ROOF = Color3.fromRGB(120, 82, 52), Color3.fromRGB(62, 128, 70), Color3.fromRGB(240, 226, 196), Color3.fromRGB(196, 84, 64)
      local WATER = Color3.fromRGB(70, 120, 170)

      local function part(parent, name, size, cframe, color, className)
        local p = Instance.new(className or "Part")
        p.Name = name
        p.Anchored = true
        p.Size = size
        p.CFrame = cframe
        p.Color = color
        p.Material = Enum.Material.SmoothPlastic
        p.Parent = parent
        return p
      end
      local function mark(item, kit, zone, role)
        for key, value in pairs({ RoqerKit = kit, RoqerZone = zone, RoqerRole = role }) do
          CollectionService:AddTag(item, key)
          item:SetAttribute(key, value)
        end
        return item
      end
      local function model(parent, name)
        local m = Instance.new("Model")
        m.Name = name
        m.Parent = parent
        return m
      end
      -- Kit builders: each builds at the origin with its pivot on the ground.
      local function houseA(parent, name)
        local m = model(parent, name)
        part(m, "Walls", Vector3.new(14, 8, 12), CFrame.new(0, 4, 0), WALL)
        part(m, "Door", Vector3.new(4, 6, 0.4), CFrame.new(0, 3, -6.2), WOOD)
        part(m, "RoofFront", Vector3.new(16, 4, 7), CFrame.new(0, 10, -3.5), ROOF, "WedgePart")
        part(m, "RoofBack", Vector3.new(16, 4, 7), CFrame.new(0, 10, 3.5) * CFrame.Angles(0, math.pi, 0), ROOF, "WedgePart")
        m.WorldPivot = CFrame.new()
        return m
      end
      local function treeA(parent, name)
        local m = model(parent, name)
        part(m, "Trunk", Vector3.new(2, 6, 2), CFrame.new(0, 3, 0), WOOD)
        part(m, "Canopy", Vector3.new(8, 6, 8), CFrame.new(0, 9, 0), LEAF)
        m.WorldPivot = CFrame.new()
        return m
      end
      local function rockA(parent, name)
        local m = model(parent, name)
        part(m, "Rock", Vector3.new(4, 3, 4), CFrame.new(0, 1.2, 0) * CFrame.Angles(math.rad(12), math.rad(30), math.rad(8)), STONE)
        m.WorldPivot = CFrame.new()
        return m
      end
      local function well(parent, name)
        local m = model(parent, name)
        part(m, "Base", Vector3.new(6, 3, 6), CFrame.new(0, 1.5, 0), STONE)
        part(m, "Water", Vector3.new(4.4, 0.2, 4.4), CFrame.new(0, 3.05, 0), WATER)
        part(m, "PostLeft", Vector3.new(0.6, 5, 0.6), CFrame.new(-2.6, 5.5, 0), WOOD)
        part(m, "PostRight", Vector3.new(0.6, 5, 0.6), CFrame.new(2.6, 5.5, 0), WOOD)
        part(m, "Beam", Vector3.new(6, 0.6, 0.6), CFrame.new(0, 8, 0), WOOD)
        m.WorldPivot = CFrame.new()
        return m
      end
      local function place(builder, parent, name, x, z, yaw, kit, zone, role)
        local m = builder(parent, name)
        m:PivotTo(CFrame.new(O + Vector3.new(x, 0, z)) * CFrame.Angles(0, math.rad(yaw), 0))
        return mark(m, kit, zone, role)
      end
      local function ground(parent, zone, role, name, size, x, y, z, color)
        return mark(part(parent, name, size, CFrame.new(O + Vector3.new(x, y, z)), color), nil, zone, role)
      end

      -- Saved intent and templates.
      local registry = model(root, "RoqerWorld")
      local function folder(name)
        local f = Instance.new("Folder")
        f.Name = name
        f.Parent = registry
        return f
      end
      local kitFolder, zoneFolder, templates = folder("Kit"), folder("Zones"), folder("Templates")
      local parents = { registry = registry, kit = kitFolder, zones = zoneFolder }
      local function doc(where, name, json)
        local value = Instance.new("StringValue")
        value.Name = name
        value.Value = json
        value.Parent = parents[where]
      end
${ADVENTURE_DOCS.map(([where, name, json]) => `      doc("${where}", "${name}", [==[${json}]==])`).join("\n")}
      houseA(templates, "House_A")
      treeA(templates, "Tree_A")
      rockA(templates, "Rock_A")

      -- The live map.
      local adventure = model(workspace, "WorkbenchEvalAdventure")
      local function zone(name) return mark(model(adventure, name), nil, name, nil) end

      local village = zone("Village")
      ground(village, "Village", "terrain", "Ground", Vector3.new(100, 40, 100), -100, -20, 0, GRASS)
      ground(village, "Village", "gameplay", "Path_Main", Vector3.new(80, 0.4, 8), -90, 0.2, 0, PATH)
      local spawn = Instance.new("SpawnLocation")
      spawn.Name = "Spawn"
      spawn.Anchored = true
      spawn.Neutral = true
      spawn.Size = Vector3.new(6, 1, 6)
      spawn.CFrame = CFrame.new(O + Vector3.new(-126, 0.9, 0))
      spawn.Color = STONE
      spawn.Material = Enum.Material.SmoothPlastic
      spawn.Parent = village
      mark(spawn, nil, "Village", "gameplay")
      place(houseA, village, "House_1", -115, -25, 180, "House_A", "Village", "decor")
      place(houseA, village, "House_2", -85, -25, 180, "House_A", "Village", "decor")
      place(houseA, village, "House_3", -100, 28, 0, "House_A", "Village", "decor")
      -- Saved at x = -150; a user has since moved it to -138. The live position wins.
      local movedWell = place(well, village, "Well", -138, 20, 0, nil, "Village", "decor")
      for index, spot in ipairs({ { -65, 35 }, { -140, -38 }, { -60, -40 } }) do
        place(treeA, village, "Tree_" .. index, spot[1], spot[2], index * 40, "Tree_A", "Village", "decor")
      end

      local canyon = zone("Canyon")
      ground(canyon, "Canyon", "terrain", "Plateau_West", Vector3.new(30, 40, 100), -35, -20, 0, GRASS)
      ground(canyon, "Canyon", "terrain", "Plateau_East", Vector3.new(30, 40, 100), 35, -20, 0, GRASS)
      ground(canyon, "Canyon", "terrain", "ChasmFloor", Vector3.new(40, 4, 100), 0, -36, 0, DARK)
      ground(canyon, "Canyon", "gameplay", "Path_West", Vector3.new(30, 0.4, 8), -35, 0.2, 0, PATH)
      ground(canyon, "Canyon", "gameplay", "Path_East", Vector3.new(30, 0.4, 8), 35, 0.2, 0, PATH)
      place(rockA, canyon, "Rock_1", -40, -30, 0, "Rock_A", "Canyon", "decor")
      place(rockA, canyon, "Rock_2", 40, 30, 90, "Rock_A", "Canyon", "decor")
      -- The seeded defect: the deck floats six studs above the plateaus and
      -- stops six studs short of each rim.
      local bridge = mark(model(canyon, "Bridge"), nil, "Canyon", "gameplay")
      part(bridge, "Deck", Vector3.new(28, 1, 8), CFrame.new(O + Vector3.new(0, 6, 0)), WOOD)
      part(bridge, "RailNorth", Vector3.new(28, 2, 0.6), CFrame.new(O + Vector3.new(0, 7.5, 3.7)), WOOD)
      part(bridge, "RailSouth", Vector3.new(28, 2, 0.6), CFrame.new(O + Vector3.new(0, 7.5, -3.7)), WOOD)

      local forest = zone("Forest")
      ground(forest, "Forest", "terrain", "Ground", Vector3.new(100, 40, 100), 100, -20, 0, GRASS)
      ground(forest, "Forest", "gameplay", "Path_Main", Vector3.new(50, 0.4, 8), 75, 0.2, 0, PATH)
      ground(forest, "Forest", "gameplay", "Path_North", Vector3.new(8, 0.4, 54), 100, 0.2, 23, PATH)
      local forestTrees = {
        { 60, -30 }, { 72, -20 }, { 85, -38 }, { 115, -30 }, { 130, -15 }, { 140, -40 },
        { 62, 25 }, { 78, 35 }, { 118, 20 }, { 132, 38 }, { 145, 10 }, { 88, -12 },
      }
      for index, spot in ipairs(forestTrees) do
        place(treeA, forest, "Tree_" .. index, spot[1], spot[2], index * 30, "Tree_A", "Forest", "decor")
      end

      -- What "unchanged" means, recorded before the agent arrives.
${SIGNATURE_LUAU}
      local function save(name, value)
        local stored = Instance.new("StringValue")
        stored.Name = name
        stored.Value = value
        stored.Parent = root
      end
      save("SignatureVillage", signature(village))
      save("SignatureForest", signature(forest))
      save("SignatureCanyon", signature(canyon, bridge))
      save("SignatureKits", signature(kitFolder) .. "\\n--\\n" .. signature(templates))
      local function sentinel(name, value)
        local pointer = Instance.new("ObjectValue")
        pointer.Name = "Sentinel" .. name
        pointer.Value = value
        pointer.Parent = root
      end
      sentinel("Village", village)
      sentinel("Forest", forest)
      sentinel("Well", movedWell)
`;

const ADVENTURE_PROBE = `
      local adventure = workspace:FindFirstChild("WorkbenchEvalAdventure")
      if not adventure then return { found = false } end
${BOX_LUAU}
${SIGNATURE_LUAU}
      local village, canyon, forest = adventure:FindFirstChild("Village"), adventure:FindFirstChild("Canyon"), adventure:FindFirstChild("Forest")
      local bridge = canyon and canyon:FindFirstChild("Bridge")
      local registry = root:FindFirstChild("RoqerWorld")
      local function same(name, container, skip)
        local stored = root:FindFirstChild("Signature" .. name)
        return stored ~= nil and container ~= nil and signature(container, skip) == stored.Value
      end
      local function pointsAt(name, instance)
        local pointer = root:FindFirstChild("Sentinel" .. name)
        return pointer ~= nil and instance ~= nil and pointer.Value == instance
      end
      local kitFolder = registry and registry:FindFirstChild("Kit")
      local templates = registry and registry:FindFirstChild("Templates")
      local kitsSame = kitFolder ~= nil and templates ~= nil and root:FindFirstChild("SignatureKits") ~= nil
        and (signature(kitFolder) .. "\\n--\\n" .. signature(templates)) == root.SignatureKits.Value
      local movedWell = village and village:FindFirstChild("Well")

      -- Walk the route by ray: two lines a player's width apart across the gap.
      local params = RaycastParams.new()
      params.FilterType = Enum.RaycastFilterType.Include
      params.FilterDescendantsInstances = { adventure }
      local crossing = {}
      for _, dz in ipairs({ -2, 2 }) do
        for x = -26, 26, 4 do
          local origin = Vector3.new(x, ${ADVENTURE_GROUND + 60}, ${ADVENTURE_Z} + dz)
          local hit = workspace:Raycast(origin, Vector3.new(0, -200, 0), params)
          table.insert(crossing, {
            x = x, dz = dz,
            y = hit and r(hit.Position.Y) or -1000,
            bridge = hit ~= nil and bridge ~= nil and hit.Instance:IsDescendantOf(bridge),
          })
        end
      end

      local summit = adventure:FindFirstChild("Summit")
      local summitInfo = nil
      if summit and summit:IsA("Model") then
        local kits, paths, landmark, kitList = {}, {}, nil, {}
        for _, item in ipairs(summit:GetDescendants()) do
          local kit = item:GetAttribute("RoqerKit")
          if type(kit) == "string" then kits[kit] = true end
          if item:IsA("BasePart") and item.Name:match("^Path") and #paths < 100 then table.insert(paths, boxOf(item)) end
          if item.Name == "Landmark" and (item:IsA("Model") or item:IsA("BasePart")) then landmark = landmark or boxOf(item) end
        end
        for kit in pairs(kits) do table.insert(kitList, kit) end
        local ok, summitBox = pcall(boxOf, summit)
        summitInfo = { box = ok and summitBox or nil, kits = kitList, paths = paths, landmark = landmark }
      end
      local northPath = forest and forest:FindFirstChild("Path_North")

      local zones = {}
      local zoneFolder = registry and registry:FindFirstChild("Zones")
      if zoneFolder then
        local HttpService = game:GetService("HttpService")
        for _, entry in ipairs(zoneFolder:GetChildren()) do
          if entry:IsA("StringValue") then
            local ok, decoded = pcall(HttpService.JSONDecode, HttpService, entry.Value)
            if ok and type(decoded) == "table" and decoded.id == entry.Name then table.insert(zones, entry.Name) end
          end
        end
      end

      return {
        found = true,
        villageSame = same("Village", village), forestSame = same("Forest", forest),
        canyonSame = same("Canyon", canyon, bridge), kitsSame = kitsSame,
        villageKept = pointsAt("Village", village), forestKept = pointsAt("Forest", forest),
        wellKept = pointsAt("Well", movedWell),
        wellX = movedWell and r(movedWell:GetPivot().Position.X) or nil,
        crossing = crossing,
        summit = summitInfo,
        northPath = northPath and northPath:IsA("BasePart") and boxOf(northPath) or nil,
        zones = zones,
      }
`;

export const EVAL_TASKS: readonly EvalTask[] = [
  {
    id: "T1-property-write",
    prompt: `Make the part at game.${EVAL_ROOT}.Target bright red and non-collidable.`,
    seed: `
      local part = Instance.new("Part")
      part.Name = "Target"
      part.Color = Color3.fromRGB(163, 162, 165)
      part.CanCollide = true
      part.Parent = root
    `,
    probe: `
      local part = root:FindFirstChild("Target")
      if not part then return { found = false } end
      return {
        found = true,
        canCollide = part.CanCollide,
        red = part.Color.R,
        green = part.Color.G,
        blue = part.Color.B,
      }
    `,
    allowedTargets: [`game.${EVAL_ROOT}.Target`],
    oracle: ({ probe }) => {
      if (field(probe, "found") !== true) return { passed: false, detail: "The Target part is gone." };
      const canCollide = field(probe, "canCollide");
      const red = Number(field(probe, "red") ?? 0);
      const green = Number(field(probe, "green") ?? 1);
      if (canCollide !== false) return { passed: false, detail: "CanCollide was not turned off." };
      // Deliberately loose on the exact shade: "bright red" is a judgement, and
      // failing an agent for picking 200,30,30 over 255,0,0 measures obedience
      // to an unstated constant rather than whether it did the task.
      if (!(red > 0.6 && green < 0.4)) return { passed: false, detail: "The part is not recognisably red." };
      return { passed: true, detail: "The part is red and non-collidable." };
    },
  },
  {
    id: "T2-seeded-fault",
    prompt: `Coins in game.${EVAL_ROOT}.CoinService never award points. Find out why and fix it.`,
    // The fault: the reward is written to a local copy of the player's stats
    // rather than to the leaderstats value, so nothing observable changes. It
    // is a real Roblox mistake rather than a syntax error, so finding it needs
    // the script to be read and understood, not merely compiled.
    seed: `
      local script = Instance.new("ModuleScript")
      script.Name = "CoinService"
      script.Source = table.concat({
        "local CoinService = {}",
        "",
        "function CoinService.award(player, amount)",
        "\\tlocal leaderstats = player:FindFirstChild(\\"leaderstats\\")",
        "\\tif not leaderstats then return end",
        "\\tlocal coins = leaderstats:FindFirstChild(\\"Coins\\")",
        "\\tif not coins then return end",
        "\\tlocal current = coins.Value",
        "\\tcurrent = current + amount",
        "end",
        "",
        "return CoinService",
      }, "\\n")
      script.Parent = root
    `,
    probe: `
      local script = root:FindFirstChild("CoinService")
      if not script then return { found = false } end
      return { found = true, source = script.Source }
    `,
    allowedTargets: [`game.${EVAL_ROOT}.CoinService`],
    oracle: ({ probe }) => {
      const source = field(probe, "source");
      if (typeof source !== "string") return { passed: false, detail: "CoinService is gone." };
      const assignsValue = /coins\.Value\s*=/.test(source) || /coins\.Value\s*\+=/.test(source);
      const keepsDeadLocal = /^\s*current\s*=\s*current\s*\+/m.test(source) && !assignsValue;
      if (!assignsValue) {
        return {
          passed: false,
          detail: keepsDeadLocal
            ? "The reward is still written to a local that goes nowhere."
            : "Nothing assigns to coins.Value.",
        };
      }
      return { passed: true, detail: "The reward is written to the leaderstats value." };
    },
  },
  {
    id: "T3-runtime-evidence",
    prompt: `Something in game.${EVAL_ROOT}.Startup throws when the place runs. Fix it and show me it no longer errors at runtime.`,
    // `WaitForChild` on a child that never arrives yields forever, so the fault
    // only shows up when the place actually runs. That is the point: it is not
    // findable by reading alone, so a run that reports success without runtime
    // evidence should fail both the oracle and the completion gate.
    seed: `
      local script = Instance.new("Script")
      script.Name = "Startup"
      script.Source = table.concat({
        "local ServerStorage = game:GetService(\\"ServerStorage\\")",
        "local config = ServerStorage:WaitForChild(\\"MissingConfig\\", 5)",
        "print(\\"Startup ready with\\", config.Name)",
      }, "\\n")
      script.Parent = root
    `,
    probe: `
      local script = root:FindFirstChild("Startup")
      if not script then return { found = false } end
      return { found = true, source = script.Source }
    `,
    allowedTargets: [`game.${EVAL_ROOT}.Startup`],
    oracle: ({ probe, verified, toolCalls }) => {
      const source = field(probe, "source");
      if (typeof source !== "string") return { passed: false, detail: "Startup is gone." };
      // The original crashes because `config` is nil after the timeout. Any fix
      // that stops dereferencing a possibly-nil result counts.
      const stillUnguarded = /config\.Name/.test(source) && !/if\s+config/.test(source);
      if (stillUnguarded) return { passed: false, detail: "The script still dereferences a value that can be nil." };
      const playtested = toolCalls.some((call) =>
        (call.tool === "solo_playtest" || call.tool === "multiplayer_playtest") && call.ok);
      if (!playtested) return { passed: false, detail: "The fix was never observed at runtime." };
      if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
      return { passed: true, detail: "Fixed and observed running." };
    },
  },
  {
    id: "T4-ui-create",
    prompt: `Create a polished six-card simulator shop from game.${EVAL_ROOT}.ShopBuilder. `
      + "Keep ShopBuilder as the source of truth, build WorkbenchEvalShop under StarterGui, "
      + "give every card a distinct visible price and a non-empty product image, then playtest, inspect, and screenshot it.",
    seed: `
      local StarterGui = game:GetService("StarterGui")
      local old = StarterGui:FindFirstChild("WorkbenchEvalShop")
      if old then old:Destroy() end

      local script = Instance.new("ModuleScript")
      script.Name = "ShopBuilder"
      script.Source = table.concat({
        "return function(parent)",
        "\\t-- Build WorkbenchEvalShop here.",
        "end",
      }, "\\n")
      script.Parent = root
    `,
    probe: `
      local StarterGui = game:GetService("StarterGui")
      local gui = StarterGui:FindFirstChild("WorkbenchEvalShop")
      if not gui then return { found = false } end
      local cards = 0
      local priced = 0
      local imaged = 0
      local prices = {}
      for _, item in ipairs(gui:GetDescendants()) do
        if item:IsA("TextButton") and item.Name:match("^Card%d+$") then
          cards += 1
          local price = item.Text:match("%d+")
          if price then
            prices[price] = true
            priced += 1
          end
          local image = item:FindFirstChildWhichIsA("ImageLabel", true)
          if image and image.Image ~= "" then imaged += 1 end
        end
      end
      local distinct = 0
      for _ in pairs(prices) do distinct += 1 end
      return { found = true, cards = cards, priced = priced, distinct = distinct, imaged = imaged }
    `,
    allowedTargets: [
      `game.${EVAL_ROOT}.ShopBuilder`,
      "game.StarterGui.WorkbenchEvalShop",
    ],
    oracle: ({ probe, verified, toolCalls }) => {
      if (field(probe, "found") !== true) return { passed: false, detail: "WorkbenchEvalShop was not built." };
      if (field(probe, "cards") !== 6 || field(probe, "priced") !== 6 || field(probe, "distinct") !== 6) {
        return { passed: false, detail: "The shop does not contain six distinctly priced cards." };
      }
      if (field(probe, "imaged") !== 6) return { passed: false, detail: "One or more shop cards has no product image." };
      const used = (tool: string) => toolCalls.some((call) => call.tool === tool && call.ok);
      if (!used("solo_playtest") && !used("multiplayer_playtest")) {
        return { passed: false, detail: "The created shop was not playtested." };
      }
      if (!used("inspect_ui") || !used("capture_screenshot")) {
        return { passed: false, detail: "The created shop lacks semantic and visual evidence." };
      }
      if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
      return { passed: true, detail: "Six-card shop created and visually verified." };
    },
  },
  {
    id: "T5-ui-three-change-edit",
    prompt: `Update game.${EVAL_ROOT}.ShopBuilder and its StarterGui preview with exactly these three changes: `
      + "rename the title from Starter Shop to Power Shop, widen the grid cells from 110 to 140 pixels, "
      + "and change Card6 from 5000 Coins to 7500 Coins. Keep the builder authoritative and visually verify the result.",
    seed: `
      local StarterGui = game:GetService("StarterGui")
      local old = StarterGui:FindFirstChild("WorkbenchEvalShop")
      if old then old:Destroy() end
      local gui = Instance.new("ScreenGui")
      gui.Name = "WorkbenchEvalShop"
      gui.Parent = StarterGui
      local title = Instance.new("TextLabel")
      title.Name = "Title"
      title.Text = "Starter Shop"
      title.Parent = gui
      local grid = Instance.new("Frame")
      grid.Name = "Grid"
      grid.Parent = gui
      local layout = Instance.new("UIGridLayout")
      layout.CellSize = UDim2.fromOffset(110, 90)
      layout.Parent = grid
      local prices = { 100, 250, 500, 1000, 2500, 5000 }
      for index, price in ipairs(prices) do
        local card = Instance.new("TextButton")
        card.Name = "Card" .. index
        card.Text = price .. " Coins"
        card.Parent = grid
      end

      local script = Instance.new("ModuleScript")
      script.Name = "ShopBuilder"
      script.Source = table.concat({
        "return function(parent)",
        "\\tlocal gui = Instance.new(\\"ScreenGui\\")",
        "\\tgui.Name = \\"WorkbenchEvalShop\\"",
        "\\tgui.Parent = parent",
        "\\tlocal title = Instance.new(\\"TextLabel\\")",
        "\\ttitle.Name = \\"Title\\"",
        "\\ttitle.Text = \\"Starter Shop\\"",
        "\\ttitle.Parent = gui",
        "\\tlocal grid = Instance.new(\\"Frame\\")",
        "\\tgrid.Name = \\"Grid\\"",
        "\\tgrid.Parent = gui",
        "\\tlocal layout = Instance.new(\\"UIGridLayout\\")",
        "\\tlayout.CellSize = UDim2.fromOffset(110, 90)",
        "\\tlayout.Parent = grid",
        "\\tlocal prices = { 100, 250, 500, 1000, 2500, 5000 }",
        "\\tfor index, price in ipairs(prices) do",
        "\\t\\tlocal card = Instance.new(\\"TextButton\\")",
        "\\t\\tcard.Name = \\"Card\\" .. index",
        "\\t\\tcard.Text = price .. \\" Coins\\"",
        "\\t\\tcard.Parent = grid",
        "\\tend",
        "\\treturn gui",
        "end",
      }, "\\n")
      script.Parent = root
    `,
    probe: `
      local StarterGui = game:GetService("StarterGui")
      local gui = StarterGui:FindFirstChild("WorkbenchEvalShop")
      local script = root:FindFirstChild("ShopBuilder")
      if not gui or not script then return { found = false } end
      local title = gui:FindFirstChild("Title", true)
      local layout = gui:FindFirstChildWhichIsA("UIGridLayout", true)
      local card = gui:FindFirstChild("Card6", true)
      return {
        found = true,
        title = title and title.Text,
        cellWidth = layout and layout.CellSize.X.Offset,
        card6 = card and card.Text,
        source = script.Source,
      }
    `,
    allowedTargets: [
      `game.${EVAL_ROOT}.ShopBuilder`,
      "game.StarterGui.WorkbenchEvalShop",
      "game.StarterGui.WorkbenchEvalShop.Title",
      "game.StarterGui.WorkbenchEvalShop.Grid.UIGridLayout",
      "game.StarterGui.WorkbenchEvalShop.Grid.Card6",
    ],
    oracle: ({ probe, verified, toolCalls }) => {
      if (field(probe, "found") !== true) return { passed: false, detail: "The builder or preview is missing." };
      if (field(probe, "title") !== "Power Shop") return { passed: false, detail: "The title was not updated." };
      if (field(probe, "cellWidth") !== 140) return { passed: false, detail: "The grid cells were not widened to 140 pixels." };
      if (field(probe, "card6") !== "7500 Coins") return { passed: false, detail: "Card6 still has the wrong price." };
      const source = field(probe, "source");
      if (typeof source !== "string" || !source.includes("Power Shop") ||
        !source.includes("fromOffset(140,") || !source.includes("7500")) {
        return { passed: false, detail: "The preview changed but ShopBuilder is not authoritative." };
      }
      const used = (tool: string) => toolCalls.some((call) => call.tool === tool && call.ok);
      if (!used("inspect_ui") || !used("capture_screenshot")) {
        return { passed: false, detail: "The three edits were not visually verified." };
      }
      if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
      return { passed: true, detail: "All three builder edits were applied and visually verified." };
    },
  },
  {
    id: "T6-purchase-price-debug",
    prompt: `Purchases in game.${EVAL_ROOT}.PurchaseController always deduct 100 Coins even though the two buttons display `
      + "100 and 250 Coins. Diagnose and minimally fix the controller, then playtest and use the real UI to assert both prices independently.",
    seed: `
      local StarterGui = game:GetService("StarterGui")
      local old = StarterGui:FindFirstChild("WorkbenchEvalPurchase")
      if old then old:Destroy() end
      local gui = Instance.new("ScreenGui")
      gui.Name = "WorkbenchEvalPurchase"
      gui.Parent = StarterGui
      local balance = Instance.new("IntValue")
      balance.Name = "Balance"
      balance.Value = 1000
      balance.Parent = gui
      for _, price in ipairs({ 100, 250 }) do
        local button = Instance.new("TextButton")
        button.Name = "Buy" .. price
        button.Text = price .. " Coins"
        button:SetAttribute("Price", price)
        button.Parent = gui
      end
      local script = Instance.new("LocalScript")
      script.Name = "PurchaseController"
      script.Source = table.concat({
        "local gui = script.Parent",
        "local balance = gui:WaitForChild(\\"Balance\\")",
        "for _, button in ipairs({ gui.Buy100, gui.Buy250 }) do",
        "\\tbutton.Activated:Connect(function()",
        "\\t\\tlocal displayedPrice = tonumber(button.Text:match(\\"%d+\\")) or 0",
        "\\t\\tbalance.Value -= 100",
        "\\t\\tprint(\\"PURCHASE_ASSERT\\", displayedPrice, balance.Value)",
        "\\tend)",
        "end",
      }, "\\n")
      script.Parent = gui
    `,
    probe: `
      local StarterGui = game:GetService("StarterGui")
      local gui = StarterGui:FindFirstChild("WorkbenchEvalPurchase")
      local script = gui and gui:FindFirstChild("PurchaseController")
      if not script then return { found = false } end
      return { found = true, source = script.Source }
    `,
    allowedTargets: ["game.StarterGui.WorkbenchEvalPurchase.PurchaseController"],
    oracle: ({ probe, verified, toolCalls }) => {
      const source = field(probe, "source");
      if (typeof source !== "string") return { passed: false, detail: "PurchaseController is missing." };
      if (/balance\.Value\s*[-+]?=\s*100\b/.test(source)) {
        return { passed: false, detail: "The controller still hardcodes a 100-Coin deduction." };
      }
      if (!/GetAttribute\(["']Price["']\)|displayedPrice/.test(source)) {
        return { passed: false, detail: "The deduction is not derived from the selected product price." };
      }
      const interactions = toolCalls.filter((call) => call.tool === "interact_ui" && call.ok).length;
      const playtested = toolCalls.some((call) =>
        (call.tool === "solo_playtest" || call.tool === "multiplayer_playtest") && call.ok);
      const readLogs = toolCalls.some((call) => call.tool === "get_runtime_logs" && call.ok);
      if (!playtested || interactions < 2 || !readLogs) {
        return { passed: false, detail: "Both displayed prices were not asserted through the running UI and logs." };
      }
      if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
      return { passed: true, detail: "The deduction follows both tested product prices." };
    },
  },
  {
    id: "T7-world-blocky-island",
    prompt: "Build a small bright, chunky, blocky island, roughly 120 by 120 studs, as game.Workspace.WorkbenchEvalIsland: "
      + "grass-topped ground with dirt sides at two elevations joined by stairs, a path at least 10 studs wide, "
      + "at least six geometric trees each as a Model named Tree, and a SpawnLocation. Keep it low-detail and "
      + "saturated, then screenshot it. "
      + `For this isolated evaluation, keep world intent and reusable templates under game.${EVAL_ROOT}.RoqerWorld, `
      + "using that path as the build root for every metadata/template batch; do not create a global RoqerWorld registry.",
    // The pair to T8. A stylized request should be built from Parts, not
    // Terrain; the seed records how much Terrain the scratch place already has
    // so a place reused across runs does not blame this run for the last one.
    seed: `
      local old = workspace:FindFirstChild("WorkbenchEvalIsland")
      if old then old:Destroy() end
      root:SetAttribute("TerrainCellsBefore", workspace.Terrain:CountCells())
    `,
    probe: `
      local island = workspace:FindFirstChild("WorkbenchEvalIsland")
      local terrainCells = workspace.Terrain:CountCells()
      local terrainBefore = root:GetAttribute("TerrainCellsBefore")
      if not island then return { found = false, terrainGrew = terrainCells > terrainBefore } end
${EXTENT_LUAU}
      local parts, unanchored, defaultGray, trees, spawns = 0, 0, 0, 0, 0
      local gray = Color3.fromRGB(163, 162, 165)
      local low, high = Vector3.one * math.huge, -Vector3.one * math.huge
      for _, item in ipairs(island:GetDescendants()) do
        if item:IsA("BasePart") then
          parts += 1
          if not item.Anchored then unanchored += 1 end
          if item.Color == gray and item.Material == Enum.Material.Plastic then defaultGray += 1 end
          low = low:Min(item.Position - worldHalf(item))
          high = high:Max(item.Position + worldHalf(item))
        end
        if item:IsA("Model") and item.Name:match("^Tree") then trees += 1 end
        if item:IsA("SpawnLocation") then spawns += 1 end
      end
      local extent = parts > 0 and (high - low) or Vector3.zero
      return {
        found = true, parts = parts, unanchored = unanchored, defaultGray = defaultGray,
        trees = trees, spawns = spawns, sizeX = extent.X, sizeY = extent.Y, sizeZ = extent.Z,
        terrainGrew = terrainCells > terrainBefore,
      }
    `,
    allowedTargets: ["game.Workspace.WorkbenchEvalIsland", `game.${EVAL_ROOT}.RoqerWorld`],
    oracle: ({ probe, verified, toolCalls }) => {
      if (field(probe, "terrainGrew") === true) {
        return { passed: false, detail: "A blocky, stylized island was built with Terrain instead of Parts." };
      }
      if (field(probe, "found") !== true) return { passed: false, detail: "WorkbenchEvalIsland was not built." };
      const count = (key: string) => Number(field(probe, key) ?? 0);
      // Do not impose a minimum part count here. A low-detail island that merges
      // ground/path cells efficiently is better, not worse. Structure, scale,
      // elevation, trees, spawn, materials and screenshot evidence establish
      // whether the requested scene exists; the upper bound still catches a
      // pathological one-Part-per-grid-cell build.
      // Far past what a 120-stud island needs; a count this high means grid
      // cells were placed one by one instead of merged into larger blocks.
      if (count("parts") > 2000) return { passed: false, detail: "The island uses an unreasonable number of parts." };
      if (count("unanchored") > 0) return { passed: false, detail: "Some island parts are not anchored." };
      if (count("defaultGray") > 0) return { passed: false, detail: "Some island parts were left default gray plastic." };
      if (count("trees") < 6) return { passed: false, detail: "Fewer than six Tree models were built." };
      if (count("spawns") < 1) return { passed: false, detail: "The island has no SpawnLocation." };
      const width = Math.max(count("sizeX"), count("sizeZ"));
      if (width < 60 || width > 250) return { passed: false, detail: "The island is far from the requested 120-stud scale." };
      if (count("sizeY") < 8) return { passed: false, detail: "The island has no second elevation." };
      if (!toolCalls.some((call) => call.tool === "capture_screenshot" && call.ok)) {
        return { passed: false, detail: "The island was never screenshotted." };
      }
      if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
      return { passed: true, detail: "A blocky Part-built island at the requested scale, visually checked." };
    },
  },
  {
    id: "T8-world-realistic-meadow",
    prompt: "Make a realistic rolling grassy meadow with gentle hills, roughly 200 by 200 studs, centred near "
      + "game.Workspace.WorkbenchEvalMeadow, which should hold any props or markers you add. Screenshot it. "
      + `For this isolated evaluation, keep world intent and reusable templates under game.${EVAL_ROOT}.RoqerWorld, `
      + "using that path as the build root for every metadata/template batch; do not create a global RoqerWorld registry.",
    // The pair to T7: here natural, continuous ground is the request, which
    // is what Terrain is for. An agent that answers every landscape with
    // blocks fails this one, so the two together measure the choice rather
    // than a preference.
    seed: `
      local old = workspace:FindFirstChild("WorkbenchEvalMeadow")
      if old then old:Destroy() end
      root:SetAttribute("TerrainCellsBefore", workspace.Terrain:CountCells())
    `,
    probe: `
      local terrainBefore = root:GetAttribute("TerrainCellsBefore")
      return {
        terrainAdded = workspace.Terrain:CountCells() - terrainBefore,
        rootFound = workspace:FindFirstChild("WorkbenchEvalMeadow") ~= nil,
      }
    `,
    allowedTargets: ["game.Workspace.WorkbenchEvalMeadow", "game.Workspace.Terrain", `game.${EVAL_ROOT}.RoqerWorld`],
    oracle: ({ probe, verified, toolCalls }) => {
      // A 200-stud meadow is thousands of 4-stud cells; a few hundred is a
      // token patch rather than the ground the request describes.
      if (Number(field(probe, "terrainAdded") ?? 0) < 500) {
        return { passed: false, detail: "Realistic rolling ground was not built with Terrain." };
      }
      if (!toolCalls.some((call) => call.tool === "capture_screenshot" && call.ok)) {
        return { passed: false, detail: "The meadow was never screenshotted." };
      }
      if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
      return { passed: true, detail: "Terrain meadow built and visually checked." };
    },
  },
  {
    id: "T9-world-visual-repair",
    prompt: "Review game.Workspace.WorkbenchEvalRepair visually. There is one obvious visual defect in Cove. "
      + "Identify it from a screenshot, repair only the affected Cove asset, preserve Ridge exactly, "
      + "read the repaired asset back, and capture a second screenshot from a comparable view before finishing.",
    seed: `
      local old = workspace:FindFirstChild("WorkbenchEvalRepair")
      if old then old:Destroy() end

      local scene = Instance.new("Model")
      scene.Name = "WorkbenchEvalRepair"
      scene.Parent = workspace

      local function floor(parent, name, position, color)
        local part = Instance.new("Part")
        part.Name = name
        part.Anchored = true
        part.Size = Vector3.new(90, 2, 70)
        part.Position = position
        part.Color = color
        part.Material = Enum.Material.Grass
        part.Parent = parent
        return part
      end

      local function tree(parent, name, position, canopySize, canopyColor)
        local model = Instance.new("Model")
        model.Name = name
        model.Parent = parent
        local trunk = Instance.new("Part")
        trunk.Name = "Trunk"
        trunk.Anchored = true
        trunk.Size = Vector3.new(3, 10, 3)
        trunk.Position = position + Vector3.new(0, 5, 0)
        trunk.Color = Color3.fromRGB(101, 67, 33)
        trunk.Material = Enum.Material.Wood
        trunk.Parent = model
        local canopy = Instance.new("Part")
        canopy.Name = "Canopy"
        canopy.Anchored = true
        canopy.Shape = Enum.PartType.Ball
        canopy.Size = canopySize
        canopy.Position = position + Vector3.new(0, 12, 0)
        canopy.Color = canopyColor
        canopy.Material = Enum.Material.Grass
        canopy.Parent = model
        return model
      end

      local cove = Instance.new("Model")
      cove.Name = "Cove"
      cove.Parent = scene
      floor(cove, "Ground", Vector3.new(-50, 0, 0), Color3.fromRGB(78, 166, 75))
      tree(cove, "TreeA", Vector3.new(-75, 1, -18), Vector3.new(12, 12, 12), Color3.fromRGB(62, 139, 72))
      tree(cove, "TreeB", Vector3.new(-30, 1, 18), Vector3.new(10, 10, 10), Color3.fromRGB(72, 151, 77))
      tree(cove, "BadTree", Vector3.new(-48, 1, 0), Vector3.new(38, 38, 38), Color3.fromRGB(255, 0, 170))

      local ridge = Instance.new("Model")
      ridge.Name = "Ridge"
      ridge.Parent = scene
      floor(ridge, "Ground", Vector3.new(50, 0, 0), Color3.fromRGB(85, 158, 82))
      tree(ridge, "TreeA", Vector3.new(28, 1, -18), Vector3.new(11, 11, 11), Color3.fromRGB(64, 138, 70))
      tree(ridge, "TreeB", Vector3.new(72, 1, 18), Vector3.new(13, 13, 13), Color3.fromRGB(69, 145, 74))

      local ridgeSentinel = Instance.new("ObjectValue")
      ridgeSentinel.Name = "VisualRepairRidgeSentinel"
      ridgeSentinel.Value = ridge
      ridgeSentinel.Parent = root
    `,
    probe: `
      local scene = workspace:FindFirstChild("WorkbenchEvalRepair")
      local cove = scene and scene:FindFirstChild("Cove")
      local ridge = scene and scene:FindFirstChild("Ridge")
      local badTree = cove and cove:FindFirstChild("BadTree")
      local canopy = badTree and badTree:FindFirstChild("Canopy")
      local sentinel = root:FindFirstChild("VisualRepairRidgeSentinel")
      if not scene or not cove or not ridge or not canopy then return { found = false } end
      local ridgeGround = ridge:FindFirstChild("Ground")
      local ridgeA = ridge:FindFirstChild("TreeA")
      local ridgeB = ridge:FindFirstChild("TreeB")
      local ridgeATrunk = ridgeA and ridgeA:FindFirstChild("Trunk")
      local ridgeACanopy = ridgeA and ridgeA:FindFirstChild("Canopy")
      local ridgeBTrunk = ridgeB and ridgeB:FindFirstChild("Trunk")
      local ridgeBCanopy = ridgeB and ridgeB:FindFirstChild("Canopy")
      local function nearVector(actual, expected)
        return actual ~= nil and (actual - expected).Magnitude < 0.01
      end
      local function nearColor(actual, expected)
        return actual ~= nil and Vector3.new(actual.R - expected.R, actual.G - expected.G, actual.B - expected.B).Magnitude < 0.001
      end
      local ridgeStable =
        sentinel ~= nil and sentinel.Value == ridge and #ridge:GetDescendants() == 7
        and ridgeGround and ridgeGround:IsA("BasePart")
        and nearVector(ridgeGround.Position, Vector3.new(50, 0, 0))
        and nearVector(ridgeGround.Size, Vector3.new(90, 2, 70))
        and nearColor(ridgeGround.Color, Color3.fromRGB(85, 158, 82))
        and ridgeATrunk and ridgeATrunk:IsA("BasePart")
        and nearVector(ridgeATrunk.Position, Vector3.new(28, 6, -18))
        and nearVector(ridgeATrunk.Size, Vector3.new(3, 10, 3))
        and ridgeACanopy and ridgeACanopy:IsA("BasePart")
        and nearVector(ridgeACanopy.Position, Vector3.new(28, 13, -18))
        and nearVector(ridgeACanopy.Size, Vector3.new(11, 11, 11))
        and nearColor(ridgeACanopy.Color, Color3.fromRGB(64, 138, 70))
        and ridgeBTrunk and ridgeBTrunk:IsA("BasePart")
        and nearVector(ridgeBTrunk.Position, Vector3.new(72, 6, 18))
        and nearVector(ridgeBTrunk.Size, Vector3.new(3, 10, 3))
        and ridgeBCanopy and ridgeBCanopy:IsA("BasePart")
        and nearVector(ridgeBCanopy.Position, Vector3.new(72, 13, 18))
        and nearVector(ridgeBCanopy.Size, Vector3.new(13, 13, 13))
        and nearColor(ridgeBCanopy.Color, Color3.fromRGB(69, 145, 74))
      return {
        found = true,
        canopyX = canopy.Size.X,
        canopyY = canopy.Size.Y,
        canopyZ = canopy.Size.Z,
        red = canopy.Color.R,
        green = canopy.Color.G,
        blue = canopy.Color.B,
        ridgeStable = ridgeStable == true,
      }
    `,
    allowedTargets: [
      "game.Workspace.WorkbenchEvalRepair.Cove.BadTree",
      "game.Workspace.WorkbenchEvalRepair.Cove.BadTree.Canopy",
    ],
    oracle: ({ probe, verified, toolCalls, changedTargets }) => {
      if (field(probe, "found") !== true) return { passed: false, detail: "The repair scene or BadTree canopy is missing." };
      const size = Math.max(
        Number(field(probe, "canopyX") ?? Infinity),
        Number(field(probe, "canopyY") ?? Infinity),
        Number(field(probe, "canopyZ") ?? Infinity),
      );
      if (size > 18 || size < 6) return { passed: false, detail: "BadTree is still implausibly scaled for the surrounding trees." };
      const red = Number(field(probe, "red") ?? 1);
      const green = Number(field(probe, "green") ?? 0);
      const blue = Number(field(probe, "blue") ?? 1);
      if (!(green > red && green > blue)) {
        return { passed: false, detail: "BadTree still has the conspicuous magenta canopy instead of matching the green kit." };
      }
      if (field(probe, "ridgeStable") !== true) {
        return { passed: false, detail: "Ridge was rebuilt or changed during a Cove-only repair." };
      }
      if (changedTargets.some((target) => target.includes(".Ridge"))) {
        return { passed: false, detail: "The run wrote to Ridge during a Cove-only repair." };
      }

      const screenshots = toolCalls
        .map((call, index) => ({ ...call, index }))
        .filter((call) => call.tool === "capture_screenshot" && call.ok);
      const mutations = new Set(["build_instances", "set_properties"]);
      const mutationIndex = toolCalls.findIndex((call) => call.ok && mutations.has(call.tool));
      if (screenshots.length < 2 || mutationIndex < 0 || screenshots[0].index > mutationIndex ||
        !screenshots.some((shot) => shot.index > mutationIndex)) {
        return { passed: false, detail: "The repair was not bracketed by before-and-after screenshots." };
      }
      const readbackAfter = toolCalls.slice(mutationIndex + 1).some((call) => {
        if (!call.ok) return false;
        if (["get_instance_properties", "get_scene_analysis", "query_instances"].includes(call.tool)) return true;
        // execute_luau is also a legitimate structural read when the returned
        // payload actually names the repaired instance. Do not count a generic
        // post-edit Luau call (for example, camera framing) as readback.
        return call.tool === "execute_luau" &&
          (call.detail?.includes("WorkbenchEvalRepair.Cove.BadTree.Canopy") ?? false);
      });
      if (!readbackAfter) return { passed: false, detail: "The repaired asset was not structurally read back after the edit." };
      if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
      return { passed: true, detail: "The visible Cove defect was locally repaired, read back, and re-screenshotted without changing Ridge." };
    },
  },
  {
    id: "T10-world-lowpoly-village",
    prompt: "Build a small low-poly village, roughly 160 by 160 studs, as game.Workspace.WorkbenchEvalVillage, "
      + "from faceted Parts and wedges rather than Terrain, in under 1,500 parts. It needs at least five houses, each a "
      + "Model named House_<number> placed from a reusable house kit with at least two variants and carrying a RoqerKit "
      + "attribute naming its kit; a central landmark taller than every house, as a Model named Landmark; walkable paths "
      + "and a plaza at least 6 studs wide, whose Parts are named starting with Path, linking every house door to the "
      + "landmark; and a SpawnLocation inside the village, on that path network. Keep the palette small and consistent. Screenshot the finished "
      + "village from an overview, then playtest to confirm the spawn is usable. "
      + `For this isolated evaluation, keep world intent and reusable templates under game.${EVAL_ROOT}.RoqerWorld, `
      + "using that path as the build root for every metadata/template batch; do not create a global RoqerWorld registry.",
    // The Phase 0 village baseline, scored on what the prompt actually asks for.
    // Every hard check below names a requirement the prompt states: a village
    // that is merely pretty but has no route from a house to the landmark fails,
    // and one that meets them all passes however plain it looks. What is a
    // judgement -- materials, palette spread, narrow path pieces -- the probe
    // records for the trajectory and the oracle leaves alone. A minimum part
    // count is deliberately absent, for the reason T7 dropped its own.
    seed: `
      local old = workspace:FindFirstChild("WorkbenchEvalVillage")
      if old then old:Destroy() end
      root:SetAttribute("TerrainCellsBefore", workspace.Terrain:CountCells())
    `,
    probe: `
      local terrainGrew = workspace.Terrain:CountCells() > root:GetAttribute("TerrainCellsBefore")
      local village = workspace:FindFirstChild("WorkbenchEvalVillage")
      if not village then return { found = false, terrainGrew = terrainGrew } end
      ${BOX_LUAU}
${EXTENT_LUAU}
      local LIMIT = 400
      local gray = Color3.fromRGB(163, 162, 165)
      local parts, unanchored, defaultGray, narrowPaths, landmarks = 0, 0, 0, 0, 0
      local materials, colorKeys, distinctColors = {}, {}, 0
      local low, high = Vector3.one * math.huge, -Vector3.one * math.huge
      local houses, paths, spawns, landmark = {}, {}, {}, nil
      local truncated = false
      for _, item in ipairs(village:GetDescendants()) do
        if item:IsA("BasePart") then
          parts += 1
          if not item.Anchored then unanchored += 1 end
          if item.Color == gray and item.Material == Enum.Material.Plastic then defaultGray += 1 end
          materials[item.Material.Name] = (materials[item.Material.Name] or 0) + 1
          local key = string.format("%d,%d,%d",
            math.floor(item.Color.R * 255 + 0.5), math.floor(item.Color.G * 255 + 0.5), math.floor(item.Color.B * 255 + 0.5))
          if not colorKeys[key] then colorKeys[key] = true; distinctColors += 1 end
          low = low:Min(item.Position - worldHalf(item))
          high = high:Max(item.Position + worldHalf(item))
          if item.Name:match("^Path") then
            if #paths < LIMIT then table.insert(paths, boxOf(item)) else truncated = true end
            if math.min(item.Size.X, item.Size.Z) < 6 then narrowPaths += 1 end
          end
          if item:IsA("SpawnLocation") and #spawns < 8 then table.insert(spawns, boxOf(item)) end
        end
        -- The exact requested name, so a kit's own "HouseRoof" sub-model is not a house.
        if item:IsA("Model") and item.Name:match("^House_%d+$") then
          if #houses < 64 then
            local kit = item:GetAttribute("RoqerKit")
            local entry = boxOf(item)
            entry.name = item.Name
            entry.kit = type(kit) == "string" and kit or nil
            table.insert(houses, entry)
          else
            truncated = true
          end
        end
        if item.Name == "Landmark" and (item:IsA("Model") or item:IsA("BasePart")) then
          landmarks += 1
          landmark = landmark or boxOf(item)
        end
      end
      local kits = {}
      local registry = root:FindFirstChild("RoqerWorld")
      local kitFolder = registry and registry:FindFirstChild("Kit")
      if kitFolder then
        local HttpService = game:GetService("HttpService")
        for _, entry in ipairs(kitFolder:GetChildren()) do
          if entry:IsA("StringValue") then
            local ok, decoded = pcall(HttpService.JSONDecode, HttpService, entry.Value)
            if ok and type(decoded) == "table" and decoded.id == entry.Name then table.insert(kits, entry.Name) end
          end
        end
      end
      local extent = parts > 0 and (high - low) or Vector3.zero
      return {
        found = true, terrainGrew = terrainGrew, parts = parts, unanchored = unanchored, defaultGray = defaultGray,
        sizeX = r(extent.X), sizeZ = r(extent.Z), truncated = truncated,
        houses = houses, paths = paths, spawns = spawns, landmark = landmark, landmarks = landmarks,
        registeredKits = kits, worldSpec = registry ~= nil and registry:FindFirstChild("WorldSpec") ~= nil,
        observed = { materials = materials, distinctColors = distinctColors, narrowPaths = narrowPaths },
      }
    `,
    allowedTargets: [],
    allowedRoots: ["game.Workspace.WorkbenchEvalVillage", `game.${EVAL_ROOT}.RoqerWorld`],
    oracle: ({ probe, verified, toolCalls }) => judgeVillage(probe, verified, toolCalls),
  },
  {
    id: "T11-world-adventure-edit",
    prompt: "game.Workspace.WorkbenchEvalAdventure is an adventure map with Village, Canyon and Forest zones; its world "
      + `intent is saved in ${REGISTRY_PATH}. Do two things. First, the bridge in the Canyon zone is visibly broken: `
      + "screenshot it, identify the defect, and repair only the bridge so the main route crosses the canyon at walking "
      + "height. Second, add a new zone north of Forest as a Model named Summit under WorkbenchEvalAdventure, with a Model "
      + "named Landmark, placements from the saved kits, and a path whose Parts are named starting with Path joined to the "
      + "end of Forest's north path; register the zone in RoqerWorld's Zones. Leave Village and Forest exactly as they "
      + "are, and do not change the saved kits or templates. Screenshot the result from comparable views, and playtest "
      + "the route from the spawn across the bridge. "
      + `Use ${REGISTRY_PATH} as the build root for metadata batches; do not create a global RoqerWorld registry.`,
    // The large-map scenario, shaped as the work a real session brings: a map
    // that already exists, with saved intent, a user's edit the intent does
    // not know about, one local defect and one extension. Rebuilding the map
    // would be the easy path and is the failure: every zone the prompt says to
    // leave is compared against a fingerprint taken at seed time, and the
    // user-moved Well has to stay where the user put it rather than where the
    // intent says it was built. The bridge is judged by walking height, not by
    // any particular deck size, and Summit only by what the prompt asks for.
    seed: ADVENTURE_SEED,
    probe: ADVENTURE_PROBE,
    allowedTargets: [
      "game.Workspace.WorkbenchEvalAdventure",
      "game.Workspace.WorkbenchEvalAdventure.Canyon",
      REGISTRY_PATH,
    ],
    allowedRoots: [
      "game.Workspace.WorkbenchEvalAdventure.Canyon.Bridge",
      "game.Workspace.WorkbenchEvalAdventure.Summit",
      `${REGISTRY_PATH}.Zones`,
      `${REGISTRY_PATH}.WorldSpec`,
    ],
    oracle: ({ probe, verified, toolCalls, changedTargets }) => judgeAdventure(probe, verified, toolCalls, changedTargets),
  },
  {
    id: "T12-model-prop",
    prompt: "Model a low-poly wooden handcart in Blender: an open box bed, two wheels and a pull handle, about 8 studs "
      + "long. Bring it into the place as a Model named WorkbenchEvalCart directly under game.Workspace, standing on the "
      + "ground near (30, 0, 30). The wood should read as wood and the wheel rims and fittings as dark iron. Anchor it, "
      + "then screenshot it.",
    // The first modeling baseline, from the first real Blender run: a barrel
    // that arrived 1 stud tall and all white. Each hard check names something
    // the prompt asks for or that run got wrong: a mesh actually made and
    // uploaded, the requested size, more than one colour on the mesh parts,
    // resting on the ground, anchored, and seen in a screenshot. Wheel count and
    // style are judgements left to the screenshot.
    needsBlender: true,
    seed: `
      local old = workspace:FindFirstChild("WorkbenchEvalCart")
      if old then old:Destroy() end
    `,
    probe: `
      local cart = workspace:FindFirstChild("WorkbenchEvalCart")
      if not cart or not cart:IsA("Model") then return { found = cart ~= nil and "not a Model" or false } end
${EXTENT_LUAU}
      local function r(n) return math.floor(n * 10 + 0.5) / 10 end
      local parts, unanchored, meshParts, uploadedMeshes, distinct = 0, 0, 0, 0, 0
      local texturedMeshes, vertexColoredMeshes, vertexUnread = 0, 0, 0
      local colors = {}
      -- Vertex colours and a packed texture survive upload (npm run eval:colors),
      -- so a cart coloured in Blender is as coloured as one painted in Studio.
      local AssetService = game:GetService("AssetService")
      local function vertexColorCount(meshId)
        local ok, mesh = pcall(function() return AssetService:CreateEditableMeshAsync(Content.fromUri(meshId)) end)
        if not ok then ok, mesh = pcall(function() return AssetService:CreateEditableMeshAsync(meshId) end) end
        if not ok then return nil end
        local seen, count = {}, 0
        local okRead = pcall(function()
          for _, id in ipairs(mesh:GetColors()) do
            local c = mesh:GetColor(id)
            local key = string.format("%d,%d,%d", math.floor(c.R * 255 + 0.5), math.floor(c.G * 255 + 0.5), math.floor(c.B * 255 + 0.5))
            if not seen[key] then seen[key] = true; count += 1 end
          end
        end)
        pcall(function() mesh:Destroy() end)
        return okRead and count or nil
      end
      local low, high = Vector3.one * math.huge, -Vector3.one * math.huge
      for _, item in ipairs(cart:GetDescendants()) do
        if item:IsA("BasePart") then
          parts += 1
          if not item.Anchored then unanchored += 1 end
          low = low:Min(item.Position - worldHalf(item))
          high = high:Max(item.Position + worldHalf(item))
          if item:IsA("MeshPart") then
            meshParts += 1
            if item.MeshId ~= "" then uploadedMeshes += 1 end
            local key = string.format("%d,%d,%d",
              math.floor(item.Color.R * 255 + 0.5), math.floor(item.Color.G * 255 + 0.5), math.floor(item.Color.B * 255 + 0.5))
            if not colors[key] then colors[key] = true; distinct += 1 end
            local surface = item:FindFirstChildWhichIsA("SurfaceAppearance")
            local surfaceMapped = surface ~= nil and select(2, pcall(function()
              return surface.ColorMap ~= "" or (surface.ColorMapContent.Uri or "") ~= ""
            end)) == true
            if item.TextureID ~= "" or surfaceMapped then
              texturedMeshes += 1
            elseif item.MeshId ~= "" then
              local vertexColors = vertexColorCount(item.MeshId)
              if vertexColors == nil then vertexUnread += 1 elseif vertexColors >= 2 then vertexColoredMeshes += 1 end
            end
          end
        end
      end
      if parts == 0 then return { found = true, parts = 0 } end
      local extent = high - low
      local centre = (low + high) / 2
      local params = RaycastParams.new()
      params.FilterType = Enum.RaycastFilterType.Exclude
      params.FilterDescendantsInstances = { cart }
      local hit = workspace:Raycast(Vector3.new(centre.X, high.Y + 1, centre.Z), Vector3.new(0, -(extent.Y + 200), 0), params)
      local assetId = cart:GetAttribute("RoqerAssetId")
      return {
        found = true, parts = parts, unanchored = unanchored, meshParts = meshParts, uploadedMeshes = uploadedMeshes,
        meshColors = distinct, texturedMeshes = texturedMeshes, vertexColoredMeshes = vertexColoredMeshes, vertexUnread = vertexUnread,
        length = r(math.max(extent.X, extent.Z)), height = r(extent.Y),
        bottom = r(low.Y), ground = hit and r(hit.Position.Y) or nil, x = r(centre.X), z = r(centre.Z),
        observed = { assetId = type(assetId) == "string" and assetId or nil },
      }
    `,
    allowedTargets: [],
    allowedRoots: ["game.Workspace.WorkbenchEvalCart"],
    oracle: ({ probe, verified, toolCalls }) => judgeModeledProp(probe, verified, toolCalls),
  },
  {
    id: "T13-reference-style",
    prompt: "Create a small map, about 150 by 150 studs, in the style of the attached reference image, as "
      + "game.Workspace.WorkbenchEvalStyle: raised grass plateaus with dirt cliff faces, a winding path, trees, rocks, "
      + "a fence and a SpawnLocation. Screenshot the finished map from an overview, compare it with the reference, "
      + "then playtest. "
      + `For this isolated evaluation, keep world intent and reusable templates under ${REGISTRY_PATH}, `
      + "using that path as the build root for every metadata/template batch; do not create a global RoqerWorld registry.",
    // The live run this comes from built a stylised reference from Parts with
    // a textured Grass material, a muted palette and a fringe stacked on as a
    // slab. Every hard check is something that run missed or the guidance
    // written after it asks for: Blender kits reused across the map, no
    // textured material where the reference is flat, visual meshes that carry
    // no collision of their own, real plateaus a player can stand on, a spawn
    // of its own, and the palette recorded as colours. How close it looks is
    // the screenshot's to judge.
    needsBlender: true,
    referenceImage: "t13-reference.png",
    seed: `
      local old = workspace:FindFirstChild("WorkbenchEvalStyle")
      if old then old:Destroy() end
      -- The place's own spawns, which the build must leave where they are.
      local spawns = {}
      for _, item in ipairs(workspace:GetChildren()) do
        if item:IsA("SpawnLocation") then
          table.insert(spawns, string.format("%s@%.1f,%.1f,%.1f", item.Name, item.Position.X, item.Position.Y, item.Position.Z))
        end
      end
      table.sort(spawns)
      root:SetAttribute("PlaceSpawns", table.concat(spawns, ";"))
    `,
    probe: `
      local map = workspace:FindFirstChild("WorkbenchEvalStyle")
      local spawns = {}
      for _, item in ipairs(workspace:GetChildren()) do
        if item:IsA("SpawnLocation") then
          table.insert(spawns, string.format("%s@%.1f,%.1f,%.1f", item.Name, item.Position.X, item.Position.Y, item.Position.Z))
        end
      end
      table.sort(spawns)
      local placeSpawnsKept = table.concat(spawns, ";") == root:GetAttribute("PlaceSpawns")
      if not map then return { found = false, placeSpawnsKept = placeSpawnsKept } end
${EXTENT_LUAU}
      local FLAT = { SmoothPlastic = true, Plastic = true, Neon = true, Glass = true, ForceField = true }
      local parts, textured, collidingVisuals, ownSpawns = 0, 0, 0, 0
      local texturedMaterials, meshUses = {}, {}
      local low, high = Vector3.one * math.huge, -Vector3.one * math.huge
      for _, item in ipairs(map:GetDescendants()) do
        if item:IsA("SpawnLocation") then ownSpawns += 1 end
        if item:IsA("BasePart") then
          parts += 1
          low = low:Min(item.Position - worldHalf(item))
          high = high:Max(item.Position + worldHalf(item))
          local visible = item.Transparency < 1
          -- A MeshPart shows its own vertex colours or texture; its Material is
          -- only its surface response, so the flat check is for Parts.
          if visible and not item:IsA("MeshPart") and not FLAT[item.Material.Name] then
            textured += 1
            texturedMaterials[item.Material.Name] = true
          end
          if item:IsA("MeshPart") and item.MeshId ~= "" and visible then
            meshUses[item.MeshId] = (meshUses[item.MeshId] or 0) + 1
            local fidelity = item.CollisionFidelity.Name
            if item.CanCollide and fidelity ~= "Box" and fidelity ~= "Hull" then collidingVisuals += 1 end
          end
        end
      end
      local distinctMeshes, maxReuse = 0, 0
      for _, uses in pairs(meshUses) do
        distinctMeshes += 1
        maxReuse = math.max(maxReuse, uses)
      end
      local materialList = {}
      for name in pairs(texturedMaterials) do table.insert(materialList, name) end
      table.sort(materialList)

      -- Where a player can stand: rays that respect collision, landing face-up on
      -- something at least 6 studs across both ways (a trunk box or a post is not ground).
      local params = RaycastParams.new()
      params.FilterType = Enum.RaycastFilterType.Include
      params.FilterDescendantsInstances = { map }
      params.RespectCanCollide = true
      local levels = {}
      if parts > 0 then
        for i = 1, 11 do
          for j = 1, 11 do
            local x = low.X + (high.X - low.X) * (0.1 + 0.8 * (i - 1) / 10)
            local z = low.Z + (high.Z - low.Z) * (0.1 + 0.8 * (j - 1) / 10)
            local hit = workspace:Raycast(Vector3.new(x, high.Y + 10, z), Vector3.new(0, -(high.Y - low.Y + 20), 0), params)
            if hit and hit.Normal.Y > 0.9 then
              local size = hit.Instance.Size
              if math.min(size.X, size.Z) >= 6 then
                local level = math.floor(hit.Position.Y / 2 + 0.5) * 2
                levels[level] = (levels[level] or 0) + 1
              end
            end
          end
        end
      end
      local standing = {}
      for level, hits in pairs(levels) do
        if hits >= 2 then table.insert(standing, level) end
      end
      table.sort(standing)

      local worldSpec = nil
      local registry = root:FindFirstChild("RoqerWorld")
      local spec = registry and registry:FindFirstChild("WorldSpec")
      if spec and spec:IsA("StringValue") then
        local ok, decoded = pcall(game:GetService("HttpService").JSONDecode, game:GetService("HttpService"), spec.Value)
        if ok and type(decoded) == "table" then
          local colours = 0
          if type(decoded.palette) == "table" then
            for _, entry in pairs(decoded.palette) do
              local colour = type(entry) == "table" and (entry.color or entry) or nil
              if type(colour) == "table" and type(colour[1]) == "number" and type(colour[3]) == "number" then colours += 1 end
            end
          end
          worldSpec = { style = type(decoded.style) == "string" and decoded.style or "", paletteColours = colours }
        end
      end
      local extent = high - low
      return {
        found = true, parts = parts, textured = textured, texturedMaterials = materialList,
        distinctMeshes = distinctMeshes, maxReuse = maxReuse, collidingVisuals = collidingVisuals,
        standingLevels = standing, ownSpawns = ownSpawns, placeSpawnsKept = placeSpawnsKept,
        worldSpec = worldSpec, sizeX = math.floor(extent.X + 0.5), sizeZ = math.floor(extent.Z + 0.5),
      }
    `,
    allowedTargets: [],
    allowedRoots: ["game.Workspace.WorkbenchEvalStyle", REGISTRY_PATH],
    oracle: ({ probe, verified, toolCalls }) => judgeReferenceStyle(probe, verified, toolCalls),
  },
  {
    id: "T14-ui-polished-shop",
    prompt: "Make a simulator themed shop UI, as a ScreenGui named WorkbenchEvalSimShop in StarterGui. Make it polished.",
    // The user's own prompt, from a live run that came out with card titles
    // under their badges, a balance under its "+" button, a discount label off
    // its price button and a bottom row past the end of its scroll. The harness
    // audits the shop itself afterwards, in its own playtest, so the score rests
    // on what Studio measures rather than on what the agent checked or said. The
    // rest is what "a shop" needs at the least; polish beyond it is the
    // screenshot's to judge, and the probe records a few signs of it.
    auditInterface: "WorkbenchEvalSimShop",
    seed: `
      local old = game:GetService("StarterGui"):FindFirstChild("WorkbenchEvalSimShop")
      if old then old:Destroy() end
    `,
    probe: `
      local gui = game:GetService("StarterGui"):FindFirstChild("WorkbenchEvalSimShop")
      if not gui then return { found = false } end
      local buttons, texts, scaled, images = 0, 0, 0, 0
      local distinct, seen = 0, {}
      for _, item in ipairs(gui:GetDescendants()) do
        if item:IsA("GuiButton") then buttons += 1 end
        if item:IsA("TextLabel") or item:IsA("TextButton") then
          texts += 1
          if item.TextScaled then scaled += 1 end
        end
        if (item:IsA("ImageLabel") or item:IsA("ImageButton")) and item.Image ~= "" then
          images += 1
          if not seen[item.Image] then seen[item.Image] = true; distinct += 1 end
        end
      end
      return {
        found = true, screenGui = gui:IsA("ScreenGui"), buttons = buttons,
        observed = { texts = texts, textScaled = scaled, images = images, distinctImages = distinct },
      }
    `,
    allowedTargets: [],
    allowedRoots: ["game.StarterGui.WorkbenchEvalSimShop"],
    oracle: ({ probe, verified, toolCalls, interfaceAudit }) => judgePolishedShop(probe, verified, toolCalls, interfaceAudit),
  },
];

/** A plateau is a real height change, not a kerb: the lowest and highest standing levels this far apart. */
const PLATEAU_STUDS = 4;

function judgeReferenceStyle(probe: unknown, verified: boolean, toolCalls: EvalOracleInput["toolCalls"]): EvalVerdict {
  if (field(probe, "found") !== true) return { passed: false, detail: "WorkbenchEvalStyle was not built." };
  const count = (key: string) => Number(field(probe, key) ?? 0);
  const succeeded = (tool: string) => toolCalls.some((call) => call.tool === tool && call.ok);
  if (!succeeded("run_blender_script")) return { passed: false, detail: "No Blender job succeeded; the visuals were not modeled." };
  if (!succeeded("upload_asset")) return { passed: false, detail: "No model was uploaded." };
  if (count("distinctMeshes") < 3) {
    return { passed: false, detail: `The map shows ${count("distinctMeshes")} modeled kit(s); the reference's trees, rocks and cliff edges call for a set of at least 3.` };
  }
  if (count("maxReuse") < 2) return { passed: false, detail: "No modeled kit is placed more than once; kits are meant to be reused." };
  if (count("textured") > 0) {
    const materials = field(probe, "texturedMaterials");
    return {
      passed: false,
      detail: `${count("textured")} visible Parts use textured materials (${Array.isArray(materials) ? materials.join(", ") : "?"}) where the reference is flat colour.`,
    };
  }
  if (count("collidingVisuals") > 0) {
    return { passed: false, detail: `${count("collidingVisuals")} visual meshes collide at full detail; collision belongs to simple Parts or Box/Hull.` };
  }
  const levels = Array.isArray(field(probe, "standingLevels")) ? (field(probe, "standingLevels") as unknown[]).filter((level): level is number => typeof level === "number") : [];
  if (levels.length < 2 || Math.max(...levels) - Math.min(...levels) < PLATEAU_STUDS) {
    return { passed: false, detail: "There is no raised plateau a player can stand on; the reference's cliffs rise above the ground." };
  }
  if (count("ownSpawns") < 1) return { passed: false, detail: "The map has no SpawnLocation of its own." };
  if (field(probe, "placeSpawnsKept") !== true) return { passed: false, detail: "The place's existing SpawnLocation was moved or removed." };
  const worldSpec = field(probe, "worldSpec");
  if (!isRecord(worldSpec) || Number(worldSpec.paletteColours ?? 0) < 3 || worldSpec.style === "") {
    return { passed: false, detail: "WorldSpec does not record the reference's style and at least three palette colours." };
  }
  const lastWrite = toolCalls.reduce((last, call, index) => call.ok && GEOMETRY_WRITES.has(call.tool) ? index : last, -1);
  if (!toolCalls.some((call, index) => index > lastWrite && call.ok && call.tool === "capture_screenshot")) {
    return { passed: false, detail: "No screenshot shows the map as finally built." };
  }
  if (!toolCalls.some((call) => (call.tool === "solo_playtest" || call.tool === "multiplayer_playtest") && call.ok)) {
    return { passed: false, detail: "The map was never playtested." };
  }
  if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
  return {
    passed: true,
    detail: `${count("distinctMeshes")} Blender kits (one placed ${count("maxReuse")} times), flat materials, plateaus ${Math.max(...levels) - Math.min(...levels)} studs high, its own spawn, palette recorded.`,
  };
}

/** A shop has things to buy: at least this many buttons, the close button included. */
const MIN_SHOP_BUTTONS = 4;
/** An interface is also built by a builder script or Luau, not only by build batches. */
const INTERFACE_WRITES = new Set([
  "build_instances", "set_properties", "manage_instance", "insert_asset", "import_rbxm",
  "execute_luau", "set_script_source", "edit_script_lines", "edit_script_batch",
]);

function judgePolishedShop(
  probe: unknown,
  verified: boolean,
  toolCalls: EvalOracleInput["toolCalls"],
  audit: EvalOracleInput["interfaceAudit"],
): EvalVerdict {
  if (field(probe, "found") !== true) return { passed: false, detail: "WorkbenchEvalSimShop was not built." };
  if (field(probe, "screenGui") !== true) return { passed: false, detail: "WorkbenchEvalSimShop is not a ScreenGui." };
  if (Number(field(probe, "buttons") ?? 0) < MIN_SHOP_BUTTONS) {
    return { passed: false, detail: `The shop has ${Number(field(probe, "buttons") ?? 0)} buttons; a shop needs items to buy and a way to close it.` };
  }
  if (audit === undefined || !audit.ran) {
    return { passed: false, detail: `The harness could not audit the shop: ${audit?.error ?? "no audit was taken"}` };
  }
  if (audit.issues.length > 0) {
    const shown = audit.issues.slice(0, 4).map((issue) => `${issue.code} at ${issue.path.split(".").slice(-2).join(".")}`);
    return {
      passed: false,
      detail: `The harness's audit found ${audit.issues.length} layout problem(s): ${shown.join("; ")}${audit.issues.length > 4 ? "; …" : ""}.`,
    };
  }
  const lastWrite = toolCalls.reduce((last, call, index) => call.ok && INTERFACE_WRITES.has(call.tool) ? index : last, -1);
  if (!toolCalls.some((call, index) => index > lastWrite && call.ok && call.tool === "capture_screenshot")) {
    return { passed: false, detail: "No screenshot shows the shop as finally built." };
  }
  if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
  return { passed: true, detail: `A shop of ${audit.elements} elements with a clean layout audit, screenshotted and verified.` };
}

/** The cart was asked for at about 8 studs; a quarter either way is still "about". */
const CART_LENGTH = { min: 6, max: 10 } as const;
/** How far the cart's lowest point may sit from the ground under it: sunk a little, or resting. */
const RESTING = { below: 0.5, above: 0.5 } as const;

function judgeModeledProp(probe: unknown, verified: boolean, toolCalls: EvalOracleInput["toolCalls"]): EvalVerdict {
  const found = field(probe, "found");
  if (found !== true) {
    return { passed: false, detail: found === "not a Model" ? "WorkbenchEvalCart is not a Model." : "WorkbenchEvalCart was not built." };
  }
  const succeeded = (tool: string) => toolCalls.some((call) => call.tool === tool && call.ok);
  if (!succeeded("run_blender_script")) return { passed: false, detail: "No Blender job succeeded; the cart was not modeled." };
  if (!succeeded("upload_asset")) return { passed: false, detail: "The modeled cart was never uploaded." };
  const count = (key: string) => Number(field(probe, key) ?? 0);
  if (count("uploadedMeshes") < 1) return { passed: false, detail: "The cart contains no uploaded mesh; it was built some other way." };
  if (count("unanchored") > 0) return { passed: false, detail: "Some of the cart's parts are not anchored." };
  // Coloured in Blender (a packed texture, or vertex colours in more than one
  // colour) or painted in Studio (mesh parts in more than one colour).
  if (count("meshColors") < 2 && count("texturedMeshes") === 0 && count("vertexColoredMeshes") === 0) {
    return {
      passed: false,
      detail: count("vertexUnread") > 0
        ? "The mesh parts share one colour and Studio would not let the probe read their vertex colours, so the colouring could not be verified."
        : "Every mesh part has the same colour and carries no texture or vertex colours, so wood and iron cannot be told apart.",
    };
  }
  const length = count("length");
  if (length < CART_LENGTH.min || length > CART_LENGTH.max) {
    return { passed: false, detail: `The cart is ${length} studs long; about 8 was asked for.` };
  }
  const ground = field(probe, "ground");
  if (typeof ground !== "number") return { passed: false, detail: "There is no ground under the cart." };
  const gap = count("bottom") - ground;
  if (gap > RESTING.above || gap < -RESTING.below) {
    return { passed: false, detail: `The cart's lowest point is ${gap.toFixed(1)} studs from the ground under it; it should rest on it.` };
  }
  const lastWrite = toolCalls.reduce((last, call, index) => call.ok && GEOMETRY_WRITES.has(call.tool) ? index : last, -1);
  if (!toolCalls.some((call, index) => index > lastWrite && call.ok && call.tool === "capture_screenshot")) {
    return { passed: false, detail: "No screenshot shows the cart as finally placed." };
  }
  if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
  return { passed: true, detail: `A modeled, uploaded ${length}-stud cart in more than one colour, resting on the ground and screenshotted.` };
}

/** The most a player walks up or down between two samples four studs apart. */
const WALKABLE_STEP_STUDS = 2;

function judgeAdventure(
  probe: unknown,
  verified: boolean,
  toolCalls: EvalOracleInput["toolCalls"],
  changedTargets: readonly string[],
): EvalVerdict {
  if (field(probe, "found") !== true) return { passed: false, detail: "WorkbenchEvalAdventure is gone." };

  const under = (target: string, root: string) => target === root || target.startsWith(`${root}.`);
  const protectedRoots: ReadonlyArray<readonly [string, string]> = [
    ["game.Workspace.WorkbenchEvalAdventure.Village", "Village"],
    ["game.Workspace.WorkbenchEvalAdventure.Forest", "Forest"],
    [`${REGISTRY_PATH}.Kit`, "the saved kits"],
    [`${REGISTRY_PATH}.Templates`, "the saved templates"],
  ];
  for (const [root, name] of protectedRoots) {
    if (changedTargets.some((target) => under(target, root))) {
      return { passed: false, detail: `The run wrote to ${name}, which the prompt said to leave alone.` };
    }
  }
  if (field(probe, "villageKept") !== true || field(probe, "forestKept") !== true) {
    return { passed: false, detail: "Village or Forest was replaced rather than left in place." };
  }
  if (field(probe, "wellKept") !== true) return { passed: false, detail: "The user-moved Well was replaced." };
  // Named separately because it is the specific mistake: treating saved intent
  // as more authoritative than what the user did to the live map.
  if (Math.abs(Number(field(probe, "wellX") ?? 0) + 150) < 1) {
    return { passed: false, detail: "The Well was moved back to its saved position, undoing the user's edit." };
  }
  if (field(probe, "villageSame") !== true) return { passed: false, detail: "Village changed." };
  if (field(probe, "forestSame") !== true) return { passed: false, detail: "Forest changed." };
  if (field(probe, "kitsSame") !== true) return { passed: false, detail: "The saved kits or templates changed." };
  if (field(probe, "canyonSame") !== true) {
    return { passed: false, detail: "Canyon changed outside the bridge." };
  }

  const crossing = (Array.isArray(field(probe, "crossing")) ? field(probe, "crossing") as unknown[] : []).flatMap((sample) => {
    const x = Number(field(sample, "x"));
    const dz = Number(field(sample, "dz"));
    const y = Number(field(sample, "y"));
    return Number.isFinite(x) && Number.isFinite(dz) && Number.isFinite(y)
      ? [{ x, dz, y, bridge: field(sample, "bridge") === true }]
      : [];
  });
  if (crossing.length < 20) return { passed: false, detail: "The canyon crossing could not be measured." };
  const rim = ADVENTURE_GROUND;
  const fall = crossing.find((sample) => sample.y < rim - WALKABLE_STEP_STUDS * 2);
  if (fall) return { passed: false, detail: `The route still drops into the canyon at x=${fall.x}.` };
  const offBridge = crossing.find((sample) => Math.abs(sample.x) < CANYON_HALF_GAP && !sample.bridge);
  if (offBridge) return { passed: false, detail: `The gap at x=${offBridge.x} is spanned by something other than the Bridge.` };
  for (const dz of new Set(crossing.map((sample) => sample.dz))) {
    const line = crossing.filter((sample) => sample.dz === dz).sort((a, b) => a.x - b.x);
    for (let index = 1; index < line.length; index += 1) {
      const step = Math.abs(line[index].y - line[index - 1].y);
      if (step > WALKABLE_STEP_STUDS) {
        return { passed: false, detail: `The crossing has a ${step.toFixed(1)}-stud step near x=${line[index].x}; it is not at walking height.` };
      }
    }
  }

  const summit = field(probe, "summit");
  if (!isRecord(summit)) return { passed: false, detail: "No Summit model was added." };
  const zones = Array.isArray(field(probe, "zones")) ? field(probe, "zones") as unknown[] : [];
  if (!zones.includes("Summit")) return { passed: false, detail: "Summit is not registered in the saved Zones." };
  if (!readBox(field(summit, "landmark"))) return { passed: false, detail: "Summit has no Landmark." };
  const kits = Array.isArray(field(summit, "kits")) ? field(summit, "kits") as unknown[] : [];
  if (!kits.some((kit) => (SEEDED_KITS as readonly unknown[]).includes(kit))) {
    return { passed: false, detail: "Summit places nothing from the saved kits." };
  }
  const summitBox = readBox(field(summit, "box"));
  if (!summitBox || summitBox.z <= FOREST_NORTH_EDGE) return { passed: false, detail: "Summit is not north of Forest." };
  const northPath = readBox(field(probe, "northPath"));
  const summitPaths = (Array.isArray(field(summit, "paths")) ? field(summit, "paths") as unknown[] : []).flatMap((entry) => {
    const box = readBox(entry);
    return box ? [footprint(box)] : [];
  });
  if (!northPath || !summitPaths.some((path) => footprintGap(path, footprint(northPath)) <= PATH_JOIN_STUDS)) {
    return { passed: false, detail: "No Summit path joins the end of Forest's north path." };
  }

  const firstWrite = toolCalls.findIndex((call) => call.ok && GEOMETRY_WRITES.has(call.tool));
  const lastWrite = toolCalls.reduce((last, call, index) => call.ok && GEOMETRY_WRITES.has(call.tool) ? index : last, -1);
  const shots = toolCalls.flatMap((call, index) => call.ok && call.tool === "capture_screenshot" ? [index] : []);
  if (firstWrite < 0 || !shots.some((index) => index < firstWrite) || !shots.some((index) => index > lastWrite)) {
    return { passed: false, detail: "The edit was not bracketed by before-and-after screenshots." };
  }
  if (!toolCalls.some((call) => (call.tool === "solo_playtest" || call.tool === "multiplayer_playtest") && call.ok)) {
    return { passed: false, detail: "The repaired route was never playtested." };
  }
  if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
  return { passed: true, detail: "Bridge repaired to walking height and Summit added, with Village, Forest, the kits and the user's edit untouched." };
}

/** A door is on the path when the house's footprint comes within this reach of it. */
const DOORSTEP_STUDS = 4;
/** Path pieces this close are one surface; the playtest judges anything finer. */
const PATH_JOIN_STUDS = 1;
/** Tools that change geometry. A screenshot taken before the last of them does not show the result. */
const GEOMETRY_WRITES = new Set([
  "build_instances", "set_properties", "manage_instance", "insert_asset", "import_rbxm", "generate_model",
]);

function judgeVillage(probe: unknown, verified: boolean, toolCalls: EvalOracleInput["toolCalls"]): EvalVerdict {
  if (field(probe, "terrainGrew") === true) {
    return { passed: false, detail: "A low-poly village was built with Terrain instead of Parts." };
  }
  if (field(probe, "found") !== true) return { passed: false, detail: "WorkbenchEvalVillage was not built." };
  const count = (key: string) => Number(field(probe, key) ?? 0);
  if (field(probe, "truncated") === true) {
    return { passed: false, detail: "The village has more houses or path pieces than the probe can judge." };
  }
  if (count("parts") >= 1500) return { passed: false, detail: "The village exceeds the 1,500-part budget it was given." };
  if (count("unanchored") > 0) return { passed: false, detail: "Some village parts are not anchored." };
  if (count("defaultGray") > 0) return { passed: false, detail: "Some village parts were left default gray plastic." };
  const width = Math.max(count("sizeX"), count("sizeZ"));
  if (width < 100 || width > 260) return { passed: false, detail: "The village is far from the requested 160-stud scale." };

  const list = (key: string) => {
    const value = field(probe, key);
    return Array.isArray(value) ? value : [];
  };
  const houses = list("houses").flatMap((entry) => {
    const box = readBox(entry);
    return box ? [{ box, name: String(field(entry, "name") ?? "House"), kit: field(entry, "kit") }] : [];
  });
  if (houses.length < 5) return { passed: false, detail: "Fewer than five House models were built." };
  const unkitted = houses.filter((house) => typeof house.kit !== "string" || house.kit === "");
  if (unkitted.length > 0) {
    return { passed: false, detail: `Houses without a RoqerKit attribute: ${unkitted.map((house) => house.name).join(", ")}.` };
  }
  const kits = new Set(houses.map((house) => house.kit as string));
  if (kits.size < 2) return { passed: false, detail: "Every house uses the same kit; two variants were requested." };
  if (kits.size === houses.length) return { passed: false, detail: "No house kit is reused; each house was built as a one-off." };
  const registered = new Set(list("registeredKits").filter((id): id is string => typeof id === "string"));
  const unregistered = [...kits].filter((kit) => !registered.has(kit));
  if (field(probe, "worldSpec") !== true || unregistered.length > 0) {
    return {
      passed: false,
      detail: unregistered.length > 0
        ? `House kits with no saved Kit entry: ${unregistered.join(", ")}.`
        : "No WorldSpec was saved for the village.",
    };
  }

  if (count("landmarks") !== 1) {
    return { passed: false, detail: count("landmarks") === 0 ? "No Landmark was built." : "There is more than one Landmark." };
  }
  const landmark = readBox(field(probe, "landmark"));
  if (!landmark || landmark.top === undefined) return { passed: false, detail: "The Landmark could not be measured." };
  const tallest = Math.max(...houses.map((house) => house.box.top ?? Infinity));
  if (!(landmark.top > tallest)) return { passed: false, detail: "The Landmark is not taller than every house." };

  const paths = list("paths").flatMap((entry) => {
    const box = readBox(entry);
    return box ? [footprint(box)] : [];
  });
  if (paths.length === 0) return { passed: false, detail: "No Parts named Path were built." };
  const groups = connectedGroups(paths, PATH_JOIN_STUDS);
  const reached = (shape: ReturnType<typeof footprint>, reach: number) =>
    new Set(paths.flatMap((path, index) => footprintGap(shape, path) <= reach ? [groups[index]] : []));
  const network = reached(footprint(landmark), DOORSTEP_STUDS);
  if (network.size === 0) return { passed: false, detail: "No path reaches the Landmark." };
  const stranded = houses.filter((house) =>
    ![...reached(footprint(house.box), DOORSTEP_STUDS)].some((group) => network.has(group)));
  if (stranded.length > 0) {
    return { passed: false, detail: `No path links these houses to the Landmark: ${stranded.map((house) => house.name).join(", ")}.` };
  }
  const spawns = list("spawns").flatMap((entry) => {
    const box = readBox(entry);
    return box ? [footprint(box)] : [];
  });
  if (spawns.length === 0) return { passed: false, detail: "The village has no SpawnLocation." };
  if (!spawns.some((spawn) => [...reached(spawn, PATH_JOIN_STUDS)].some((group) => network.has(group)))) {
    return { passed: false, detail: "No SpawnLocation stands on the path network that reaches the Landmark." };
  }

  const lastWrite = toolCalls.reduce((last, call, index) => call.ok && GEOMETRY_WRITES.has(call.tool) ? index : last, -1);
  if (!toolCalls.some((call, index) => index > lastWrite && call.ok && call.tool === "capture_screenshot")) {
    return { passed: false, detail: "No screenshot shows the village as finally built." };
  }
  if (!toolCalls.some((call) => (call.tool === "solo_playtest" || call.tool === "multiplayer_playtest") && call.ok)) {
    return { passed: false, detail: "The village was never playtested." };
  }
  if (!verified) return { passed: false, detail: "The run finished without satisfying the completion gate." };
  return { passed: true, detail: "A kit-built, connected low-poly village with a taller landmark, screenshotted and playtested." };
}

export function findEvalTask(id: string): EvalTask | undefined {
  return EVAL_TASKS.find((task) => task.id === id);
}
