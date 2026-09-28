// A contact sheet of an animation: a grid of frames of the box rig, drawn in
// trusted code so a model that can see images can check the motion. Each
// column is a moment; the top row looks from the front three-quarter, the
// bottom row from the character's right side, facing right. The scale is the
// same in every frame, so drift and height changes show as they are.

import { rgbaToPng } from '../png-encoder.js';
import { drawnParts, groundHeight, partColor, type Rgb } from './box-rig.js';
import { buildTracks, poseRig, sequenceDuration, type Frame, type MotionSequence } from './motion.js';
import { R15_RIG, type Vec3 } from './r15-rig.js';

const CELL_WIDTH = 176;
const CELL_HEIGHT = 220;
const LABEL_HEIGHT = 16;
/** Studs across the cell's height; the width follows the cell's shape. */
const VIEW_HEIGHT_STUDS = 7.5;
const COLUMNS = 6;

const BACKGROUND: Rgb = [247, 248, 250];
const GRID: Rgb = [222, 226, 232];
const GROUND: Rgb = [176, 182, 192];
const TEXT: Rgb = [92, 100, 112];
const LIGHT: Vec3 = normalize([0.35, 0.85, -0.4]);

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
const THREE_QUARTER = view([Math.sin(Math.PI * 35 / 180) * Math.cos(Math.PI / 12), Math.sin(Math.PI / 12), -Math.cos(Math.PI * 35 / 180) * Math.cos(Math.PI / 12)]);
const SIDE = view([1, 0, 0]);

// 3x5 glyphs for the time labels, one bit per pixel, top row first.
const GLYPHS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7], '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
  '.': [0, 0, 0, 0, 2], s: [0, 3, 6, 3, 6],
};

class Canvas {
  readonly rgba: Buffer;
  private readonly depth: Float32Array;

  constructor(readonly width: number, readonly height: number) {
    this.rgba = Buffer.alloc(width * height * 4);
    this.depth = new Float32Array(width * height).fill(-Infinity);
    for (let index = 0; index < width * height; index += 1) this.put(index, BACKGROUND);
  }

  private put(index: number, color: Rgb) {
    this.rgba[index * 4] = color[0];
    this.rgba[index * 4 + 1] = color[1];
    this.rgba[index * 4 + 2] = color[2];
    this.rgba[index * 4 + 3] = 255;
  }

  pixel(x: number, y: number, color: Rgb) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.put(y * this.width + x, color);
  }

  line(x0: number, x1: number, y: number, color: Rgb) {
    for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x += 1) this.pixel(x, y, color);
  }

  column(x: number, y0: number, y1: number, color: Rgb) {
    for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y += 1) this.pixel(x, y, color);
  }

  /** A filled triangle, depth-tested, clipped to a cell. */
  triangle(points: [number, number, number][], color: Rgb, clip: { x0: number; y0: number; x1: number; y1: number }) {
    const [a, b, c] = points;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) return;
    const minX = Math.max(clip.x0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(clip.x1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(clip.y0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(clip.y1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const index = y * this.width + x;
        if (z <= this.depth[index]) continue;
        this.depth[index] = z;
        this.put(index, color);
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
                for (let dx = 0; dx < scale; dx += 1) this.pixel(cursor + bit * scale + dx, y + rowIndex * scale + dy, color);
              }
            }
          }
        });
      }
      cursor += 4 * scale;
    }
  }
}

// Each face of a unit box: its outward normal and its corners, counter-clockwise seen from outside.
const FACES: { normal: Vec3; corners: Vec3[] }[] = [
  { normal: [1, 0, 0], corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { normal: [0, 0, 1], corners: [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]] },
  { normal: [0, 0, -1], corners: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
];

function rotate(frame: Frame, v: Vec3): Vec3 {
  const r = frame.r;
  return [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
}

function shade(color: Rgb, normal: Vec3): Rgb {
  const light = 0.5 + 0.5 * Math.max(0, dot(normal, LIGHT));
  return [Math.round(color[0] * light), Math.round(color[1] * light), Math.round(color[2] * light)];
}

function drawCell(canvas: Canvas, parts: Map<string, Frame>, camera: View, left: number, top: number) {
  const scale = CELL_HEIGHT / VIEW_HEIGHT_STUDS;
  const ground = groundHeight();
  // The ground sits a little above the cell's bottom; the figure is centred across.
  const originX = left + CELL_WIDTH / 2;
  const groundY = top + CELL_HEIGHT - 18;
  const project = (p: Vec3): [number, number, number] => [
    originX + dot(p, camera.right) * scale,
    groundY - (dot(p, camera.up) - ground * camera.up[1]) * scale,
    dot(p, camera.toward),
  ];
  canvas.line(left + 8, left + CELL_WIDTH - 9, Math.round(groundY), GROUND);
  const clip = { x0: left, y0: top, x1: left + CELL_WIDTH - 1, y1: top + CELL_HEIGHT - 1 };
  for (const part of drawnParts()) {
    const frame = parts.get(part);
    if (!frame) continue;
    const half = R15_RIG.parts[part].map((size) => size / 2) as unknown as Vec3;
    for (const face of FACES) {
      const normal = rotate(frame, face.normal);
      if (dot(normal, camera.toward) <= 0) continue;
      const color = shade(partColor(part), normal);
      const corners = face.corners.map((corner) => {
        const local: Vec3 = [corner[0] * half[0], corner[1] * half[1], corner[2] * half[2]];
        const world = rotate(frame, local);
        return project([world[0] + frame.p[0], world[1] + frame.p[1], world[2] + frame.p[2]]);
      });
      canvas.triangle([corners[0], corners[1], corners[2]], color, clip);
      canvas.triangle([corners[0], corners[2], corners[3]], color, clip);
    }
  }
}

function formatTime(time: number): string {
  return `${time.toFixed(2)}s`;
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
  const height = (CELL_HEIGHT + LABEL_HEIGHT) * 2;
  const canvas = new Canvas(width, height);
  times.forEach((time, column) => {
    const parts = poseRig(tracks, time).parts;
    const left = column * CELL_WIDTH;
    [THREE_QUARTER, SIDE].forEach((camera, row) => {
      const top = row * (CELL_HEIGHT + LABEL_HEIGHT);
      drawCell(canvas, parts, camera, left, top);
      canvas.text(formatTime(time), left + 8, top + CELL_HEIGHT + 2, 2, TEXT);
    });
    if (column > 0) canvas.column(left, 0, height - 1, GRID);
  });
  canvas.line(0, width - 1, CELL_HEIGHT + LABEL_HEIGHT, GRID);
  return { png: rgbaToPng(canvas.rgba, width, height), width, height, times };
}
