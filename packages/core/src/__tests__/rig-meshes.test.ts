import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { drawnParts } from '../animation/box-rig.js';
import {
  cachedRigMeshes,
  currentRigMeshes,
  normalizeRigMeshes,
  resetRigMeshesForTests,
  storeRigMeshes,
} from '../animation/rig-meshes.js';

/** One triangle a part, as the plugin sends it: corners in the part's frame and a normal at each. */
function payload(winding: 'outward' | 'inward' = 'outward') {
  const corners = winding === 'outward'
    ? [0, 0, 0.3, 0.1, 0, 0.3, 0, 0.1, 0.3]
    : [0, 0, 0.3, 0, 0.1, 0.3, 0.1, 0, 0.3];
  return {
    parts: Object.fromEntries(drawnParts().map((part) => [part, { positions: corners, normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] }])),
    head: 'classic',
  };
}

describe('rig meshes', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rig-meshes-'));
    resetRigMeshesForTests();
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    resetRigMeshesForTests();
  });

  test('turn every triangle to face the way its normals do', () => {
    for (const winding of ['outward', 'inward'] as const) {
      const meshes = normalizeRigMeshes(payload(winding));
      const mesh = meshes?.parts.get('Head');
      expect(meshes?.source).toBe('studio');
      // The corners are indexed so the triangle's winding faces +Z, as its normals do.
      const [a, b, c] = mesh!.indices.map((index) => mesh!.positions.slice(index * 3, index * 3 + 3));
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      expect(cross).toBeGreaterThan(0);
    }
  });

  test('refuse a payload with a part missing, a malformed array, or a vertex far outside its part', () => {
    const missing = payload();
    delete (missing.parts as Record<string, unknown>).LeftFoot;
    expect(normalizeRigMeshes(missing)).toBeUndefined();
    const ragged = payload();
    ragged.parts.Head = { positions: [0, 0, 0, 1], normals: [0, 0, 1, 0] };
    expect(normalizeRigMeshes(ragged)).toBeUndefined();
    const far = payload();
    far.parts.Head = { positions: [0, 0, 5, 0.1, 0, 5, 0, 0.1, 5], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
    expect(normalizeRigMeshes(far)).toBeUndefined();
    expect(normalizeRigMeshes('meshes')).toBeUndefined();
  });

  test('are kept on disk and read back by a later process, and a damaged cache falls back', () => {
    expect(storeRigMeshes(payload(), directory)?.source).toBe('studio');
    resetRigMeshesForTests();
    expect(cachedRigMeshes(directory)?.source).toBe('studio');

    resetRigMeshesForTests();
    fs.writeFileSync(path.join(directory, 'r15-rig-meshes-v1.json'), '{"parts": ');
    expect(cachedRigMeshes(directory)).toBeUndefined();
    const saved = process.env.ROBLOXSTUDIO_MCP_CACHE_DIR;
    process.env.ROBLOXSTUDIO_MCP_CACHE_DIR = directory;
    try {
      expect(currentRigMeshes().source).toBe('generated');
    } finally {
      if (saved === undefined) delete process.env.ROBLOXSTUDIO_MCP_CACHE_DIR; else process.env.ROBLOXSTUDIO_MCP_CACHE_DIR = saved;
    }
  });
});
