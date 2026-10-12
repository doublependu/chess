// Procedural chess pieces. Every part is a closed, welded, consistently oriented mesh
// (manifold), which the fracture library requires. Pure three.js: safe to use in workers.
import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';

export const PIECE_HEIGHT = [0, 0.73, 0.98, 1.055, 0.89, 1.21, 1.36];
export const PIECE_RADIUS = [0, 0.31, 0.345, 0.335, 0.35, 0.365, 0.375];

// ---------- primitive builders (return {positions: number[], indices: number[]}) ----------

function arc(out, cx, cy, r, a0, a1, steps) {
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + (a1 - a0) * (i / steps)) * Math.PI) / 180;
    out.push([Math.max(0, cx + r * Math.cos(a)), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Closed solid of revolution. profile: [[r, y], ...] from bottom pole (r=0) to top pole (r=0). */
export function lathe(profile, segments, yaw = 0) {
  const pos = [], idx = [];
  const n = profile.length;
  pos.push(0, profile[0][1], 0);
  const ring = (i) => 1 + (i - 1) * segments;
  for (let i = 1; i < n - 1; i++) {
    const [r, y] = profile[i];
    for (let s = 0; s < segments; s++) {
      const t = yaw + (s / segments) * Math.PI * 2;
      pos.push(r * Math.sin(t), y, r * Math.cos(t));
    }
  }
  const top = pos.length / 3;
  pos.push(0, profile[n - 1][1], 0);
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    idx.push(0, ring(1) + s1, ring(1) + s);
  }
  for (let i = 1; i < n - 2; i++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = ring(i) + s, b = ring(i) + s1, c = ring(i + 1) + s1, d = ring(i + 1) + s;
      idx.push(a, b, c, a, c, d);
    }
  }
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    idx.push(ring(n - 2) + s, ring(n - 2) + s1, top);
  }
  return { positions: pos, indices: idx };
}

export function sphere(cx, cy, cz, r, segments = 10) {
  const prof = arc([], 0, 0, r, -90, 90, Math.max(4, segments >> 1));
  prof[0][0] = 0; prof[prof.length - 1][0] = 0;
  const m = lathe(prof, segments);
  for (let i = 0; i < m.positions.length; i += 3) {
    m.positions[i] += cx; m.positions[i + 1] += cy; m.positions[i + 2] += cz;
  }
  return m;
}

/** Axis-aligned box (8 shared vertices), optionally rotated around Y by `yaw` about the origin. */
export function box(cx, cy, cz, sx, sy, sz, yaw = 0) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pos = [];
  for (const [x, y, z] of [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz], [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]) {
    const X = cx + x, Z = cz + z;
    pos.push(X * c + Z * s, cy + y, -X * s + Z * c);
  }
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: pos, indices: idx };
}

/** Extrudes a CCW 2D contour (x, y) along z with a single chamfer ring on both sides. */
export function prism(contour, depth, bevel) {
  const n = contour.length;
  const P = contour.map(([x, y]) => new Vector2(x, y));
  // Inset contour along averaged edge normals (outward normal of CCW edge d is (d.y, -d.x)).
  const Q = P.map((p, i) => {
    const a = P[(i - 1 + n) % n], b = P[(i + 1) % n];
    const e1 = new Vector2().subVectors(p, a).normalize();
    const e2 = new Vector2().subVectors(b, p).normalize();
    const n1 = new Vector2(e1.y, -e1.x), n2 = new Vector2(e2.y, -e2.x);
    const nrm = n1.add(n2).normalize();
    return new Vector2(p.x - nrm.x * bevel, p.y - nrm.y * bevel);
  });
  const h = depth / 2;
  const rings = [[Q, -h], [P, -h + bevel], [P, h - bevel], [Q, h]];
  const pos = [];
  for (const [pts, z] of rings) for (const p of pts) pos.push(p.x, p.y, z);
  const idx = [];
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const A = k * n + i, B = k * n + i1, C = (k + 1) * n + i1, D = (k + 1) * n + i;
      idx.push(A, B, C, A, C, D);
    }
  }
  const tris = ShapeUtils.triangulateShape(Q, []);
  for (const [a, b, c] of tris) {
    // Front cap (z = +h) must face +z, back cap (z = -h) must face -z.
    const ax = Q[a].x, ay = Q[a].y, bx = Q[b].x, by = Q[b].y, cx = Q[c].x, cy = Q[c].y;
    const ccw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0;
    const f = 3 * n;
    if (ccw) { idx.push(f + a, f + b, f + c); idx.push(c, b, a); }
    else { idx.push(f + c, f + b, f + a); idx.push(a, b, c); }
  }
  return { positions: pos, indices: idx };
}

function toGeometry(m) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(m.positions, 3));
  g.setIndex(m.indices);
  g.computeVertexNormals();
  return g;
}

// ---------- piece definitions ----------

function baseProfile(r, top) {
  // Wide, chunky foot shared by all pieces (scaled by r).
  const k = r / 0.33;
  return [[0, 0], [0.33 * k, 0], [0.345 * k, 0.025], [0.34 * k, 0.065], [0.30 * k, 0.09], [0.262 * k, 0.105], [0.257 * k, 0.13], [top * k, 0.16]];
}

const PROFILES = {
  1: () => [
    ...baseProfile(0.30, 0.2),
    [0.155, 0.2], [0.125, 0.3], [0.11, 0.38], [0.175, 0.4], [0.18, 0.43], [0.12, 0.455],
    ...arc([], 0, 0.575, 0.155, -50, 90, 10).slice(0, -1), [0, 0.73],
  ],
  3: () => [
    ...baseProfile(0.32, 0.195),
    [0.15, 0.22], [0.115, 0.4], [0.105, 0.52], [0.18, 0.545], [0.185, 0.58], [0.12, 0.605], [0.11, 0.62],
    [0.135, 0.655], [0.165, 0.71], [0.175, 0.77], [0.165, 0.84], [0.135, 0.9], [0.09, 0.95], [0.045, 0.98],
    [0.03, 0.99], [0.055, 1.005], [0.06, 1.025], [0.045, 1.045], [0, 1.055],
  ],
  4: () => [
    ...baseProfile(0.335, 0.22),
    [0.2, 0.22], [0.19, 0.5], [0.195, 0.58], [0.24, 0.62], [0.27, 0.66], [0.275, 0.7],
    [0.275, 0.8], [0.205, 0.8], [0.205, 0.73], [0, 0.73],
  ],
  5: () => [
    ...baseProfile(0.35, 0.21),
    [0.16, 0.25], [0.125, 0.45], [0.115, 0.62], [0.195, 0.65], [0.2, 0.685], [0.13, 0.71], [0.125, 0.73],
    [0.15, 0.8], [0.21, 0.93], [0.235, 0.99], [0.225, 1.01], [0.16, 1.0], [0.12, 1.02], [0.1, 1.06], [0.07, 1.1],
    [0.06, 1.12], [0.075, 1.15], [0.065, 1.185], [0.035, 1.205], [0, 1.21],
  ],
  6: () => [
    ...baseProfile(0.36, 0.22),
    [0.165, 0.27], [0.13, 0.5], [0.12, 0.7], [0.205, 0.73], [0.21, 0.77], [0.135, 0.8], [0.13, 0.82],
    [0.16, 0.9], [0.215, 1.03], [0.22, 1.07], [0.17, 1.085], [0.15, 1.1], [0.12, 1.12], [0, 1.12],
  ],
  2: () => [...baseProfile(0.33, 0.235), [0, 0.16]],
};

// Horse head silhouette (x = forward, y = up), counter-clockwise.
const KNIGHT_HEAD = [
  [-0.2, 0.15], [0.2, 0.15], [0.205, 0.3], [0.15, 0.42], [0.11, 0.5], [0.2, 0.555], [0.3, 0.59], [0.355, 0.64],
  [0.36, 0.69], [0.33, 0.735], [0.25, 0.78], [0.16, 0.84], [0.105, 0.9], [0.075, 0.975], [0.03, 0.93],
  [-0.05, 0.925], [-0.13, 0.86], [-0.195, 0.72], [-0.235, 0.54], [-0.255, 0.36], [-0.24, 0.23],
];

/**
 * Returns the parts of a piece. `solid` parts are closed manifolds used for fracture;
 * `decor` parts (eyes, slits) are only rendered.
 */
export function buildPieceParts(type, { segments = 24 } = {}) {
  const solid = [], decor = [];
  solid.push(lathe(PROFILES[type](), segments));
  if (type === 2) {
    solid.push(prism(KNIGHT_HEAD, 0.24, 0.035));
    decor.push(sphere(0.2, 0.75, 0.115, 0.026, 8), sphere(0.2, 0.75, -0.115, 0.026, 8));
  } else if (type === 4) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      solid.push(box(0, 0.845, 0.24, 0.125, 0.09, 0.07, a));
    }
  } else if (type === 5) {
    const seg = Math.max(6, segments >> 2);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      solid.push(sphere(0.215 * Math.sin(a), 1.035, 0.215 * Math.cos(a), 0.034, seg));
    }
  } else if (type === 6) {
    solid.push(box(0, 1.235, 0, 0.075, 0.25, 0.075));
    solid.push(box(0, 1.27, 0, 0.21, 0.07, 0.074));
  } else if (type === 3) {
    decor.push(box(0.0, 0.83, 0.168, 0.026, 0.13, 0.03, 0));
  }
  return { solid: solid.map(toGeometry), decor: decor.map(toGeometry) };
}

/** Rotates decor so that a bishop's slit is diagonal (purely cosmetic). */
export function decorTilt(type) {
  return type === 3 ? 0.6 : 0;
}

// ---------- validation helpers (used by tests) ----------

/** Every edge must be shared by exactly two triangles with opposite directions. */
export function isManifold(geometry) {
  const idx = geometry.index.array;
  const pos = geometry.attributes.position.array;
  const edges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) return false;
    // zero-area check
    const [a, b, c] = tri.map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-14) return false;
    for (let e = 0; e < 3; e++) {
      const u = tri[e], v = tri[(e + 1) % 3];
      const key = u + ',' + v;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    if (count !== 1) return false;
    const [u, v] = key.split(',');
    if (edges.get(v + ',' + u) !== 1) return false;
  }
  return true;
}

export function signedVolume(geometry) {
  const idx = geometry.index.array;
  const p = geometry.attributes.position.array;
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return vol;
}
