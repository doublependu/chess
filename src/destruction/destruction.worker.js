// Fracture (three-pinata) + physics bake (Rapier, lazily loaded) off the main thread.
import { Vector3, MeshBasicMaterial } from 'three';
import { DestructibleMesh, FractureOptions } from '@dgreenheck/three-pinata';
import { buildPieceParts, PIECE_HEIGHT } from '../render/pieces/geometry.js';
import { bakeRapier, bakeFallback } from './bake.js';

let RAPIER = null;
let rapierPromise = null;
let rapierFailed = false;
function loadRapier() {
  if (!rapierPromise) {
    rapierPromise = import('@dimforge/rapier3d')
      .then((m) => { RAPIER = m.default || m; return RAPIER; })
      .catch((e) => { rapierFailed = true; console.warn('Rapier failed to load, using fallback physics', e); return null; });
  }
  return rapierPromise;
}

const MAT = new MeshBasicMaterial();
const partsCache = new Map();

function getParts(type, segments) {
  const key = type + ':' + segments;
  if (!partsCache.has(key)) partsCache.set(key, buildPieceParts(type, { segments }).solid);
  return partsCache.get(key);
}

function volumeOf(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  return (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
}

/** Converts a fragment geometry into transferable arrays, centred on its bounding-box centre. */
function packFragment(geo, offset, groups) {
  const posAttr = geo.attributes.position;
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
  const n = posAttr.count;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = posAttr.getX(i) - cx; pos[i * 3 + 1] = posAttr.getY(i) - cy; pos[i * 3 + 2] = posAttr.getZ(i) - cz;
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const nrm = new Float32Array(geo.attributes.normal.array);
  const idx = geo.index ? new Uint32Array(geo.index.array) : null;
  const size = Math.cbrt(Math.max(1e-6, (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z)));
  return {
    pos, nrm, idx,
    groups: groups || geo.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })),
    center: [cx + offset.x, cy + offset.y, cz + offset.z],
    size,
  };
}

function fracture({ pieceType, segments, fragments: count, seed, impactLocal }) {
  const parts = getParts(pieceType, segments);
  const vols = parts.map(volumeOf);
  const total = vols.reduce((a, b) => a + b, 0);
  const out = [];
  parts.forEach((geo, i) => {
    const share = vols[i] / total;
    const n = Math.round(count * share);
    if (n < 2 || share < 0.06) {
      // Small parts (merlons, crown jewels, the cross) fly off whole.
      const g = geo.clone();
      out.push(packFragment(g, new Vector3(), [{ start: 0, count: g.index.count, materialIndex: 0 }]));
      return;
    }
    const mesh = new DestructibleMesh(geo.clone(), MAT, MAT);
    const opts = new FractureOptions({
      fractureMethod: 'voronoi',
      fragmentCount: n,
      seed: (seed + i * 101) >>> 0,
      voronoiOptions: { mode: '3D', impactPoint: new Vector3(...impactLocal), impactRadius: PIECE_HEIGHT[pieceType] * 0.55 },
    });
    const frags = mesh.fracture(opts);
    for (const f of frags) {
      const g = f.geometry;
      if (g.attributes.uv) g.deleteAttribute('uv');
      out.push(packFragment(g, f.position));
      g.dispose();
    }
    mesh.geometry.dispose();
  });
  return out;
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'warm') {
      if (payload?.physics) loadRapier();
      self.postMessage({ id, ok: true, result: true });
      return;
    }
    if (type !== 'destroy') throw new Error('unknown request ' + type);
    const t0 = performance.now();
    const frags = fracture(payload);
    const t1 = performance.now();
    // Wait briefly for Rapier if it is already loading; otherwise use the fallback simulator.
    if (!RAPIER && !rapierFailed && rapierPromise && payload.waitPhysicsMs > 0) {
      await Promise.race([rapierPromise, new Promise((r) => setTimeout(r, payload.waitPhysicsMs))]);
    }
    const simParams = {
      ...payload,
      fragments: frags.map((f) => ({ points: f.pos, center: f.center, size: f.size })),
    };
    let baked, engine;
    if (RAPIER && payload.physics !== 'fallback') {
      try { baked = bakeRapier(RAPIER, simParams); engine = 'rapier'; }
      catch (err) { console.warn('Rapier bake failed', err); }
    }
    if (!baked) { baked = bakeFallback(simParams); engine = 'fallback'; }
    const t2 = performance.now();
    const transfer = [baked.bake.buffer];
    for (const f of frags) { transfer.push(f.pos.buffer, f.nrm.buffer); if (f.idx) transfer.push(f.idx.buffer); }
    self.postMessage({
      id, ok: true,
      result: {
        fragments: frags.map(({ pos, nrm, idx, groups, center }) => ({ pos, nrm, idx, groups, center })),
        bake: baked.bake, frames: baked.frames, fps: baked.fps, count: baked.count,
        engine, ms: { fracture: t1 - t0, physics: t2 - t1 },
      },
    }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.stack || err) });
  }
};
