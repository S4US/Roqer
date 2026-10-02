// The VFX reference's recipes are build_instances steps the agent copies
// straight into Studio, so a recipe that names a property Roblox does not have,
// or a value the plugin refuses, costs a failed call. These tests hold each
// recipe to the class's real properties, the shapes the plugin converts, and
// the attributes the emit module it ships with actually reads.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadAgentRuntime } from "./agent-definition";

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(runtimeDirectory, "../agent");
const SKILL = "roblox-animation-vfx";
const REFERENCE = "references/vfx-craft.md";
const MODULE = "templates/vfx/emit.lua";

type Kind =
  | "number" | "boolean" | "content" | "Color3" | "ColorSequence" | "NumberSequence"
  | "NumberRange" | "Vector2" | "Vector3" | readonly string[];

// Enum items, from @rbxts/types 1.0.906 (generated from Roblox's API dump).
const NORMAL_ID = ["Right", "Top", "Back", "Left", "Bottom", "Front"] as const;
const TEXTURE_MODE = ["Stretch", "Wrap", "Static"] as const;

// Properties a recipe may set, with their value types, from the same typings.
const CLASSES: Record<string, Record<string, Kind>> = {
  ParticleEmitter: {
    Acceleration: "Vector3", Brightness: "number", Color: "ColorSequence", Drag: "number",
    EmissionDirection: NORMAL_ID, Enabled: "boolean", FlipbookFramerate: "NumberRange",
    FlipbookLayout: ["None", "Grid2x2", "Grid4x4", "Grid8x8", "Custom"],
    FlipbookMode: ["Loop", "OneShot", "PingPong", "Random"], FlipbookStartRandom: "boolean",
    Lifetime: "NumberRange", LightEmission: "number", LightInfluence: "number", LockedToPart: "boolean",
    Orientation: ["FacingCamera", "FacingCameraWorldUp", "VelocityParallel", "VelocityPerpendicular"],
    Rate: "number", RotSpeed: "NumberRange", Rotation: "NumberRange",
    Shape: ["Box", "Sphere", "Cylinder", "Disc"], ShapeInOut: ["Outward", "Inward", "InAndOut"],
    ShapePartial: "number", ShapeStyle: ["Volume", "Surface"], Size: "NumberSequence",
    Speed: "NumberRange", SpreadAngle: "Vector2", Squash: "NumberSequence", Texture: "content",
    TimeScale: "number", Transparency: "NumberSequence", VelocityInheritance: "number",
    WindAffectsDrag: "boolean", ZOffset: "number",
  },
  Beam: {
    Brightness: "number", Color: "ColorSequence", CurveSize0: "number", CurveSize1: "number",
    Enabled: "boolean", FaceCamera: "boolean", LightEmission: "number", LightInfluence: "number",
    Segments: "number", Texture: "content", TextureLength: "number", TextureMode: TEXTURE_MODE,
    TextureSpeed: "number", Transparency: "NumberSequence", Width0: "number", Width1: "number",
    ZOffset: "number",
  },
  Trail: {
    Brightness: "number", Color: "ColorSequence", Enabled: "boolean", FaceCamera: "boolean",
    Lifetime: "number", LightEmission: "number", LightInfluence: "number", MaxLength: "number",
    MinLength: "number", Texture: "content", TextureLength: "number", TextureMode: TEXTURE_MODE,
    Transparency: "NumberSequence", WidthScale: "NumberSequence",
  },
  PointLight: { Brightness: "number", Color: "Color3", Enabled: "boolean", Range: "number", Shadows: "boolean" },
  Part: {
    Anchored: "boolean", CanCollide: "boolean", Color: "Color3", Material: ["Neon", "ForceField", "SmoothPlastic", "Glass"],
    Shape: ["Ball", "Block", "Cylinder", "Wedge", "CornerWedge"], Size: "Vector3", Transparency: "number",
  },
  Model: {},
};

const EASING_STYLES = ["Linear", "Sine", "Back", "Quad", "Quart", "Quint", "Bounce", "Elastic", "Exponential", "Circular", "Cubic"];
const EASING_DIRECTIONS = ["In", "Out", "InOut"];

// Textures that ship in Studio's and the client's content/textures/particles.
const BUILT_IN_TEXTURES = new Set([
  "explosion01_implosion_main.dds", "explosion01_shockwave_main.dds", "explosion01_core_main.dds",
  "smoke_main.dds", "sparkles_main.dds", "fire_main.dds", "forcefield_vortex_main.dds",
].map((name) => `rbxasset://textures/particles/${name}`));

interface Step {
  op: string;
  id?: string;
  className: string;
  name: string;
  parent?: string;
  rotation?: unknown;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNumberList = (value: unknown, size: number): value is number[] =>
  Array.isArray(value) && value.length === size && value.every(isNumber);
const isColor = (value: unknown): boolean => isNumberList(value, 3) && value.every((component) => component >= 0 && component <= 1);

/** Keypoints the way the plugin reads them, and as Roblox requires: from time 0 to 1, in order. */
function keypointProblem(value: unknown, isValue: (entry: unknown) => boolean): string | undefined {
  if (!Array.isArray(value) || value.length < 2) return "needs at least two keypoints";
  const times = value.map((entry) => (entry as { time?: unknown }).time);
  if (!times.every(isNumber)) return "every keypoint needs a numeric time";
  if (times[0] !== 0 || times[times.length - 1] !== 1) return "keypoints must start at time 0 and end at time 1";
  for (let index = 1; index < times.length; index++) {
    if ((times[index] as number) < (times[index - 1] as number)) return "keypoint times must ascend";
  }
  if (!value.every((entry) => isValue((entry as { value?: unknown }).value))) return "a keypoint value has the wrong shape";
  return undefined;
}

function valueProblem(kind: Kind, value: unknown): string | undefined {
  if (Array.isArray(kind)) return typeof value === "string" && kind.includes(value) ? undefined : `is not one of ${kind.join(", ")}`;
  switch (kind) {
    case "number": return isNumber(value) ? undefined : "is not a number";
    case "boolean": return typeof value === "boolean" ? undefined : "is not a boolean";
    case "content": return typeof value === "string" && /^rbxasset(id)?:\/\//.test(value) ? undefined : "is not an asset URI";
    case "Color3": return isColor(value) ? undefined : "is not [r, g, b] from 0 to 1";
    case "Vector2": return isNumberList(value, 2) ? undefined : "is not [x, y]";
    case "Vector3": return isNumberList(value, 3) ? undefined : "is not [x, y, z]";
    case "NumberRange":
      if (isNumber(value)) return undefined;
      return isNumberList(value, 2) && value[0] <= value[1] ? undefined : "is not a number or [min, max]";
    case "NumberSequence":
      return isNumber(value) ? undefined : keypointProblem(value, isNumber);
    case "ColorSequence":
      return isColor(value) ? undefined : keypointProblem(value, isColor);
    default: return undefined;
  }
}

async function loadSkill(resource?: string): Promise<string> {
  const runtime = await loadAgentRuntime(agentRoot);
  return (await runtime.skillLibrary.load(SKILL, resource)).content;
}

function recipes(reference: string): Step[] {
  const steps: Step[] = [];
  for (const match of reference.matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    const parsed = JSON.parse(match[1]) as Step | Step[] | { operation: string };
    // A whole tool call, such as capture_moments, is an example of a call, not a build step.
    if (!Array.isArray(parsed) && "operation" in parsed) continue;
    steps.push(...(Array.isArray(parsed) ? parsed : [parsed as Step]));
  }
  return steps;
}

/** Attribute names the emit module reads, from its numberAttribute and enumAttribute calls. */
function moduleAttributes(source: string): Set<string> {
  return new Set([...source.matchAll(/(?:number|enum)Attribute\(\w+, "(\w+)"/g)].map((match) => match[1]));
}

test("the VFX skill links its reference and emit module, and both load", async () => {
  const entrypoint = await loadSkill();
  assert.ok(entrypoint.includes(`(${REFERENCE})`));
  assert.ok(entrypoint.includes(`(${MODULE})`));
  assert.ok(entrypoint.includes("(references/vfx-design.md)"));
  assert.match(await loadSkill("references/vfx-design.md"), /^# VFX design/);
  const reference = await loadSkill(REFERENCE);
  assert.match(reference, /# VFX craft/);
  const source = await loadSkill(MODULE);
  assert.match(source, /^-- ROQER_VFX_EMIT/);
  assert.match(source, /\nreturn VFX\s*$/);
});

test("every VFX recipe sets only real properties, in shapes the plugin converts", async () => {
  const steps = recipes(await loadSkill(REFERENCE));
  assert.ok(steps.length >= 10, `expected the recipes, found ${steps.length} steps`);
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    const where = `${step.className} ${step.name}`;
    if (step.op !== "create") problems.push(`${where}: op is ${step.op}, not create`);
    const properties = CLASSES[step.className];
    if (properties === undefined) {
      problems.push(`${where}: class is not in the checked list`);
      continue;
    }
    if (step.parent !== undefined && step.parent.startsWith("$") && !ids.has(step.parent.slice(1))) {
      problems.push(`${where}: parent ${step.parent} is not an earlier step's id`);
    }
    if (step.id !== undefined) ids.add(step.id);
    for (const [name, value] of Object.entries(step.properties ?? {})) {
      const kind = properties[name];
      if (kind === undefined) {
        problems.push(`${where}: ${step.className} has no property ${name}`);
        continue;
      }
      const problem = valueProblem(kind, value);
      if (problem !== undefined) problems.push(`${where}: ${name} ${problem}`);
      if (name === "Texture" && !BUILT_IN_TEXTURES.has(value as string)) {
        problems.push(`${where}: ${String(value)} is not a checked built-in texture`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every built-in texture the reference lists is one the recipes may use", async () => {
  const reference = await loadSkill(REFERENCE);
  const listed = new Set([...reference.matchAll(/`(rbxasset:\/\/textures\/particles\/[\w.]+)`/g)].map((match) => match[1]));
  assert.deepEqual([...listed].sort(), [...BUILT_IN_TEXTURES].sort());
});

test("recipe attributes are ones the emit module reads, with values it accepts", async () => {
  const read = moduleAttributes(await loadSkill(MODULE));
  assert.deepEqual(
    [...read].sort(),
    ["Duration", "Easing", "EasingDirection", "EffectDuration", "EmitCount", "EmitDelay", "EmitDuration", "Spin"],
  );
  const problems: string[] = [];
  for (const step of recipes(await loadSkill(REFERENCE))) {
    for (const [name, value] of Object.entries(step.attributes ?? {})) {
      const where = `${step.className} ${step.name}: ${name}`;
      if (!read.has(name)) problems.push(`${where} is not read by the emit module`);
      else if (name === "Easing") {
        if (!EASING_STYLES.includes(value as string)) problems.push(`${where} is not an EasingStyle`);
      } else if (name === "EasingDirection") {
        if (!EASING_DIRECTIONS.includes(value as string)) problems.push(`${where} is not an EasingDirection`);
      } else if (!isNumber(value) || value < 0) {
        problems.push(`${where} is not a non-negative number`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the reference documents every attribute the emit module reads", async () => {
  const reference = await loadSkill(REFERENCE);
  const start = reference.indexOf("| On | Attribute | Meaning |");
  assert.ok(start >= 0, "the attribute table is missing");
  const table = reference.slice(start).split(/\r?\n(?!\|)/)[0];
  for (const name of moduleAttributes(await loadSkill(MODULE))) {
    assert.ok(table.includes(`\`${name}\``), `${name} is read by the module but not in the attribute table`);
  }
});
