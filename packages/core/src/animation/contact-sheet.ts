// A contact sheet of an animation: a grid of frames of the block rig, drawn in
// trusted code so a model that can see images can check the motion. Each
// column is a moment; the top row looks from the front three-quarter, the
// bottom row from the character's right side, facing right. The scale is the
// same in every frame, so drift and height changes show as they are.
//
// A small software rasteriser draws it: a depth buffer, one light-grey
// rounded mesh a part, and smooth shading from a key and a fill light, on a
// dark ground with a soft contact shadow.

import { rgbaToPng } from '../png-encoder.js';
import { drawnParts, groundHeight, partColor, partMesh, type PartMesh, type Rgb } from './box-rig.js';
import { buildTracks, poseRig, sequenceDuration, type Frame, type MotionSequence } from './motion.js';
import type { Vec3 } from './r15-rig.js';

const CELL_WIDTH = 172;
const CELL_HEIGHT = 236;
const LABEL_HEIGHT = 18;
/** Studs across the cell's height; the width follows the cell's shape. */
const VIEW_HEIGHT_STUDS = 7.4;
const COLUMNS = 5;

const TOP: Rgb = [30, 33, 40];
const BOTTOM: Rgb = [18, 20, 25];
const DIVIDER: Rgb = [42, 46, 54];
const TEXT: Rgb = [142, 149, 161];
const KEY_LIGHT: Vec3 = normalize([0.45, 0.75, -0.5]);
const FILL_LIGHT: Vec3 = normalize([-0.6, 0.25, -0.35]);

interface View {
  right: Vec3;
  up: Vec3;
  /** Toward the viewer: a larger value is nearer. */
  toward: Vec3;
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function view(toward: Vec3): View {
  const t = normalize(toward);
  const right = normalize(cross([0, 1, 0], t));
  return { right, up: cross(t, right), toward: t };
}

// The character faces -Z with its right hand at +X.
const YAW = Math.PI * 35 / 180;
const PITCH = Math.PI * 14 / 180;
const THREE_QUARTER = view([Math.sin(YAW) * Math.cos(PITCH), Math.sin(PITCH), -Math.cos(YAW) * Math.cos(PITCH)]);
const SIDE = view([1, 0.06, 0]);

// 3x5 glyphs for the time labels, one bit per pixel, top row first.
const GLYPHS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7], '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
  '.': [0, 0, 0, 0, 2], s: [0, 3, 6, 3, 6],
};

type Vertex = { x: number; y: number; z: number; r: number; g: number; b: number };

class Canvas {
  readonly rgba: Buffer;
  private readonly depth: Float32Array;

  constructor(readonly width: number, readonly height: number) {
    this.rgba = Buffer.alloc(width * height * 4);
    this.depth = new Float32Array(width * height).fill(-Infinity);
  }

  put(x: number, y: number, color: readonly number[]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    this.rgba[index] = color[0];
    this.rgba[index + 1] = color[1];
    this.rgba[index + 2] = color[2];
    this.rgba[index + 3] = 255;
  }

  /** Darken what is there by a share, for the shadow. */
  darken(x: number, y: number, share: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    for (let channel = 0; channel < 3; channel += 1) this.rgba[index + channel] = Math.round(this.rgba[index + channel] * (1 - share));
  }

  /** A triangle with its colour blended from its corners, depth-tested, clipped to a cell. */
  triangle(a: Vertex, b: Vertex, c: Vertex, clip: { x0: number; y0: number; x1: number; y1: number }) {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 1e-9) return;
    const minX = Math.max(clip.x0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(clip.x1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(clip.y0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(clip.y1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
        const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * a.z + w1 * b.z + w2 * c.z;
        const index = y * this.width + x;
        if (z <= this.depth[index]) continue;
        this.depth[index] = z;
        this.put(x, y, [
          Math.round(w0 * a.r + w1 * b.r + w2 * c.r),
          Math.round(w0 * a.g + w1 * b.g + w2 * c.g),
          Math.round(w0 * a.b + w1 * b.b + w2 * c.b),
        ]);
      }
    }
  }

  text(value: string, x: number, y: number, scale: number, color: Rgb) {
    let cursor = x;
    for (const character of value) {
      const glyph = GLYPHS[character];
      if (glyph) {
        glyph.forEach((row, rowIndex) => {
          for (let bit = 0; bit < 3; bit += 1) {
            if (row & (4 >> bit)) {
              for (let dy = 0; dy < scale; dy += 1) {
                for (let dx = 0; dx < scale; dx += 1) this.put(cursor + bit * scale + dx, y + rowIndex * scale + dy, color);
              }
            }
          }
        });
      }
      cursor += 4 * scale;
    }
  }
}

function rotate(frame: Frame, v: Vec3): Vec3 {
  const r = frame.r;
  return [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
}

function lighting(normal: Vec3, camera: View): number {
  const key = Math.max(0, dot(normal, KEY_LIGHT));
  const fill = Math.max(0, dot(normal, FILL_LIGHT));
  // A rim where the surface turns away from the viewer lifts the silhouette off the dark ground.
  const rim = (1 - Math.max(0, dot(normal, camera.toward))) ** 3;
  return 0.3 + 0.62 * key + 0.18 * fill + 0.12 * rim;
}

const MESHES = new Map<string, PartMesh>(drawnParts().map((part) => [part, partMesh(part)]));

function drawBackground(canvas: Canvas, left: number, top: number, height: number) {
  for (let y = 0; y < height; y += 1) {
    const share = y / height;
    const color = TOP.map((value, channel) => Math.round(value + (BOTTOM[channel] - value) * share));
    for (let x = 0; x < CELL_WIDTH; x += 1) canvas.put(left + x, top + y, color);
  }
}

function drawCell(canvas: Canvas, parts: Map<string, Frame>, camera: View, left: number, top: number) {
  const scale = CELL_HEIGHT / VIEW_HEIGHT_STUDS;
  const ground = groundHeight();
  const originX = left + CELL_WIDTH / 2;
  const groundY = top + CELL_HEIGHT - 22;
  const project = (p: Vec3) => ({
    x: originX + dot(p, camera.right) * scale,
    y: groundY - (dot(p, camera.up) - ground * camera.up[1]) * scale,
    z: dot(p, camera.toward),
  });

  // A soft shadow on the ground under the body, as the viewer's floor casts.
  const body = parts.get('LowerTorso');
  if (body) {
    const centre = project([body.p[0], ground, body.p[2]]);
    const radiusX = 1.35 * scale;
    const radiusY = Math.max(3, 1.35 * scale * Math.abs(camera.up[2] * camera.toward[2] + camera.up[0] * camera.toward[0]) + 3);
    for (let y = Math.floor(centre.y - radiusY); y <= Math.ceil(centre.y + radiusY); y += 1) {
      for (let x = Math.floor(centre.x - radiusX); x <= Math.ceil(centre.x + radiusX); x += 1) {
        if (x < left || x >= left + CELL_WIDTH) continue;
        const d = ((x - centre.x) / radiusX) ** 2 + ((y - centre.y) / radiusY) ** 2;
        if (d < 1) canvas.darken(x, y, 0.55 * (1 - d) ** 1.5);
      }
    }
  }

  const clip = { x0: left, y0: top, x1: left + CELL_WIDTH - 1, y1: top + CELL_HEIGHT - 1 };
  for (const [part, mesh] of MESHES) {
    const frame = parts.get(part);
    if (!frame) continue;
    const color = partColor(part);
    const vertices: Vertex[] = [];
    const world: Vec3[] = [];
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const local: Vec3 = [mesh.positions[index], mesh.positions[index + 1], mesh.positions[index + 2]];
      const rotated = rotate(frame, local);
      const point: Vec3 = [rotated[0] + frame.p[0], rotated[1] + frame.p[1], rotated[2] + frame.p[2]];
      world.push(point);
      const normal = rotate(frame, [mesh.normals[index], mesh.normals[index + 1], mesh.normals[index + 2]]);
      const light = lighting(normal, camera);
      const projected = project(point);
      vertices.push({
        ...projected,
        r: Math.min(255, color[0] * light),
        g: Math.min(255, color[1] * light),
        b: Math.min(255, color[2] * light),
      });
    }
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const [ia, ib, ic] = [mesh.indices[index], mesh.indices[index + 1], mesh.indices[index + 2]];
      const [a, b, c] = [world[ia], world[ib], world[ic]];
      const facing = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      if (dot(facing, camera.toward) <= 0) continue;
      canvas.triangle(vertices[ia], vertices[ib], vertices[ic], clip);
    }
  }
}

export interface ContactSheet {
  png: Buffer;
  width: number;
  height: number;
  /** The moment each column shows, in seconds. */
  times: number[];
}

/**
 * The moments a sheet shows: evenly across one pass, the loop's wrap left out
 * since it repeats the first frame, a one-shot's last frame kept.
 */
export function sheetTimes(sequence: MotionSequence, columns = COLUMNS): number[] {
  const duration = sequenceDuration(sequence);
  if (duration === 0) return [0];
  const spans = sequence.loop ? columns : columns - 1;
  return Array.from({ length: columns }, (_unused, index) => (duration * index) / spans);
}

export function renderContactSheet(sequence: MotionSequence): ContactSheet {
  const times = sheetTimes(sequence);
  const tracks = buildTracks(sequence);
  const width = CELL_WIDTH * times.length;
  const rowHeight = CELL_HEIGHT + LABEL_HEIGHT;
  const height = rowHeight * 2;
  const canvas = new Canvas(width, height);
  times.forEach((time, column) => {
    const parts = poseRig(tracks, time).parts;
    const left = column * CELL_WIDTH;
    [THREE_QUARTER, SIDE].forEach((camera, row) => {
      const top = row * rowHeight;
      drawBackground(canvas, left, top, rowHeight);
      drawCell(canvas, parts, camera, left, top);
      canvas.text(`${time.toFixed(2)}s`, left + 10, top + CELL_HEIGHT + 2, 2, TEXT);
    });
    if (column > 0) for (let y = 0; y < height; y += 1) canvas.put(left, y, DIVIDER);
  });
  for (let x = 0; x < width; x += 1) canvas.put(x, rowHeight, DIVIDER);
  return { png: rgbaToPng(canvas.rgba, width, height), width, height, times };
}
