/**
 * Top-down footprints for world-layout oracles.
 *
 * A probe cannot hand an oracle whole geometry, and an oracle that only sees
 * axis-aligned bounds scores a diagonal path as a large square: two paths that
 * never touch can look connected. So a probe reports each box as its centre and
 * three half-axes, and the oracle projects the box onto the ground plane
 * exactly. The Minkowski sum of three segments is a hexagon, or a parallelogram
 * for a flat slab.
 *
 * Only the ground plane is judged. A bridge over a path counts as touching it,
 * and a stair between two levels counts as joining them. That leniency is
 * deliberate: connectivity here catches layouts with no route at all, and the
 * playtest and screenshots catch the rest.
 */

export type Point = readonly [number, number];

/** What a probe reports for one box: its XZ centre, top, and XZ half-axes. */
export type ProbedBox = {
  x: number;
  z: number;
  top?: number;
  /** The box's right, up, and look half-vectors, projected onto XZ. */
  h: readonly Point[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1]);

/** Reads one probed box, or nothing when the probe returned something else. */
export function readBox(value: unknown): ProbedBox | undefined {
  if (!isRecord(value) || !finite(value.x) || !finite(value.z)) return undefined;
  const halves = value.h;
  if (!Array.isArray(halves) || halves.length === 0 || halves.length > 3 || !halves.every(isPoint)) return undefined;
  return { x: value.x, z: value.z, ...(finite(value.top) ? { top: value.top } : {}), h: halves };
}

/** Convex hull, counter-clockwise, without repeated points. */
function hull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique = sorted.filter((point, index) =>
    index === 0 || point[0] !== sorted[index - 1][0] || point[1] !== sorted[index - 1][1]);
  if (unique.length <= 2) return unique;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The exact ground-plane shadow of a probed box. */
export function footprint(box: ProbedBox): Point[] {
  let corners: Point[] = [[box.x, box.z]];
  for (const [dx, dz] of box.h) {
    corners = corners.flatMap(([x, z]): Point[] => [[x + dx, z + dz], [x - dx, z - dz]]);
  }
  return hull(corners);
}

function axesOf(polygon: readonly Point[]): Point[] {
  if (polygon.length < 2) return [];
  return polygon.map((point, index): Point => {
    const next = polygon[(index + 1) % polygon.length];
    return [next[1] - point[1], point[0] - next[0]];
  });
}

function centroid(polygon: readonly Point[]): Point {
  const sum = polygon.reduce<[number, number]>((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
  return [sum[0] / polygon.length, sum[1] / polygon.length];
}

/**
 * Separation between two convex footprints, in studs; zero when they overlap.
 *
 * The largest gap along any separating axis. It is exact edge to edge and
 * slightly generous corner to corner, which is the forgiving side for a
 * "within a few studs" check.
 */
export function footprintGap(a: readonly Point[], b: readonly Point[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  const [ax, az] = centroid(a);
  const [bx, bz] = centroid(b);
  // The centre-to-centre axis makes point and segment footprints measurable.
  const candidates = [...axesOf(a), ...axesOf(b), [bx - ax, bz - az] as Point];
  let gap = 0;
  for (const [nx, nz] of candidates) {
    const length = Math.hypot(nx, nz);
    if (length < 1e-9) continue;
    const project = (polygon: readonly Point[]) => polygon.map(([x, z]) => (x * nx + z * nz) / length);
    const pa = project(a);
    const pb = project(b);
    gap = Math.max(gap, Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
  }
  return gap;
}

/** Groups footprints that touch within `tolerance`; returns each one's group. */
export function connectedGroups(polygons: readonly (readonly Point[])[], tolerance: number): number[] {
  const parent = polygons.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < polygons.length; i += 1) {
    for (let j = i + 1; j < polygons.length; j += 1) {
      if (find(i) !== find(j) && footprintGap(polygons[i], polygons[j]) <= tolerance) parent[find(i)] = find(j);
    }
  }
  return polygons.map((_, index) => find(index));
}
