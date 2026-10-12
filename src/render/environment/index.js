import {
  Group, Mesh, SphereGeometry, ShaderMaterial, BackSide, Vector3, Color, PlaneGeometry, BufferGeometry,
  Float32BufferAttribute, MeshLambertMaterial, CylinderGeometry, BoxGeometry, IcosahedronGeometry,
  InstancedMesh, Object3D, Sprite, SpriteMaterial, CanvasTexture, SRGBColorSpace, Points, AdditiveBlending,
  HemisphereLight, DirectionalLight, Fog, DoubleSide, MeshBasicMaterial, CircleGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { globalUniforms, patchWarp, WARP_GLSL } from '../materials.js';

export const SUN_DIR = new Vector3(-0.62, 0.2, -0.76).normalize();
export const HORIZON = new Color('#f6b98a');
export const PREVAILING_WIND = new Vector3(1, 0, -0.35).normalize();

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Cheap 2D value noise for geometry displacement (CPU side).
function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Wind sway for vertex shaders (needs uTime, uWind, uWindDir). `h` = 0 at the root, 1 at the tip. */
const WIND_VERTEX = /* glsl */`
  vec3 wdir = normalize(vec3(uWindDir[0], 0.0, uWindDir[2]));
  float ph = dot(wpos.xz, vec2(0.37, 0.53));
  float sway = sin(uTime * 1.7 + ph) * 0.5 + sin(uTime * 2.9 + ph * 1.7) * 0.25;
  vec3 windOffset = (wdir * (0.25 + uWind * 2.2) + vec3(wdir.z, 0.0, -wdir.x) * sway * (0.35 + uWind)) * h;
`;

function windPatch(material, key, heightExpr, worldPosExpr = '(modelMatrix * vec4(position, 1.0)).xyz', amp = 0.12) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = globalUniforms.uTime;
    shader.uniforms.uWind = globalUniforms.uWind;
    shader.uniforms.uWindDir = globalUniforms.uWindDir;
    shader.uniforms.uTimeWarp = globalUniforms.uTimeWarp;
    shader.vertexShader = 'uniform float uTime;\nuniform float uWind;\nuniform float uWindDir[3];\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         vec3 wpos = ${worldPosExpr};
         float h = ${heightExpr};
         ${WIND_VERTEX}
         transformed += windOffset * ${amp.toFixed(3)};
       }`,
    );
    shader.fragmentShader = WARP_GLSL.decl + '\n' + shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n' + WARP_GLSL.apply);
  };
  material.customProgramCacheKey = () => 'wind-' + key;
  return material;
}

// ---------------------------------------------------------------------------

function makeSky() {
  const mat = new ShaderMaterial({
    side: BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new Color('#251d57') }, uMid: { value: new Color('#9a5b8c') }, uHorizon: { value: HORIZON.clone() },
      uBelow: { value: new Color('#e8a98f') }, uSunDir: { value: SUN_DIR }, uSun: { value: new Color('#ffe2b0') },
      uTimeWarp: globalUniforms.uTimeWarp,
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uMid, uHorizon, uBelow, uSunDir, uSun;
      ${WARP_GLSL.decl}
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.32, h));
        col = mix(col, uTop, smoothstep(0.28, 0.9, h));
        col = mix(col, uBelow, smoothstep(0.0, -0.25, h));
        float s = max(dot(d, uSunDir), 0.0);
        col += uSun * (pow(s, 600.0) * 3.0 + pow(s, 40.0) * 0.35 + pow(s, 5.0) * 0.16);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        ${WARP_GLSL.apply}
      }`,
  });
  const m = new Mesh(new SphereGeometry(500, 32, 16), mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

function makeCloudSea(octaves) {
  const mat = new ShaderMaterial({
    transparent: false, depthWrite: true, fog: false,
    uniforms: {
      uTime: globalUniforms.uTime, uHorizon: { value: HORIZON.clone() }, uLit: { value: new Color('#ffd9c0') },
      uShade: { value: new Color('#b77a9a') }, uSunDir: { value: SUN_DIR }, uTimeWarp: globalUniforms.uTimeWarp,
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uHorizon, uLit, uShade, uSunDir;
      ${WARP_GLSL.decl}
      varying vec3 vWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
      float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < ${octaves}; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec2 p = vWorld.xz * 0.035 + vec2(uTime * 0.012, uTime * 0.004);
        float n = fbm(p);
        float n2 = fbm(p * 1.9 + 3.1);
        float puff = smoothstep(0.3, 0.75, n * 0.75 + n2 * 0.35);
        vec3 col = mix(uShade, uLit, puff);
        float d = length(vWorld.xz - cameraPosition.xz);
        col = mix(col, uHorizon, smoothstep(60.0, 260.0, d));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        ${WARP_GLSL.apply}
      }`,
  });
  const m = new Mesh(new PlaneGeometry(1000, 1000, 1, 1).rotateX(-Math.PI / 2), mat);
  m.position.y = -18;
  return m;
}

/** Floating rock island: grassy top disc, jagged cliffs tapering to a point. */
function makeIslandGeometry(radius, depth, seed, rings = 7, segs = 48) {
  const r = rng(seed);
  const pos = [], col = [], idx = [];
  const grassA = new Color('#86ad5b'), grassB = new Color('#a9c56c'), edge = new Color('#9a7a58');
  const rockA = new Color('#7d5b6d'), rockB = new Color('#4b3552');
  const phase = r() * 10;
  // centre of top
  pos.push(0, 0, 0); col.push(grassB.r, grassB.g, grassB.b);
  const ringR = [];
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    const rr = k === 0 ? radius : radius * Math.pow(1 - t, 0.85) * (0.92 + r() * 0.1);
    const y = k === 0 ? 0 : -0.25 - depth * Math.pow(t, 1.15);
    ringR.push([rr, y]);
  }
  for (let k = 0; k <= rings; k++) {
    const [rr, y] = ringR[k];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const n = noise2(Math.cos(a) * 2.2 + phase, Math.sin(a) * 2.2 + k * 0.7);
      const rad = rr * (k === 0 ? 0.95 + n * 0.1 : 0.8 + n * 0.4);
      const yy = y + (k === 0 ? 0 : (n - 0.5) * 0.9);
      pos.push(Math.cos(a) * rad, yy, Math.sin(a) * rad);
      const c = k === 0 ? edge.clone().lerp(grassA, 0.35) : rockA.clone().lerp(rockB, Math.min(1, k / rings + (n - 0.5) * 0.4));
      col.push(c.r, c.g, c.b);
    }
  }
  const tip = pos.length / 3;
  pos.push(0, ringR[rings][1] - depth * 0.25, 0);
  col.push(rockB.r, rockB.g, rockB.b);
  const ring = (k) => 1 + k * segs;
  for (let s = 0; s < segs; s++) {
    const s1 = (s + 1) % segs;
    idx.push(0, ring(0) + s1, ring(0) + s);
  }
  for (let k = 0; k < rings; k++) {
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      const a = ring(k) + s, b = ring(k) + s1, c = ring(k + 1) + s1, d = ring(k + 1) + s;
      idx.push(a, b, c, a, c, d);
    }
  }
  for (let s = 0; s < segs; s++) {
    const s1 = (s + 1) % segs;
    idx.push(ring(rings) + s, ring(rings) + s1, tip);
  }
  let g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g = g.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

function makePlatform() {
  const top = new CylinderGeometry(6.9, 7.2, 0.38, 8, 1);
  top.rotateY(Math.PI / 8);
  top.translate(0, -0.33, 0);
  const steps = new CylinderGeometry(7.5, 7.9, 0.25, 8, 1);
  steps.rotateY(Math.PI / 8);
  steps.translate(0, -0.55, 0);
  const g = mergeGeometries([top, steps]);
  const m = new Mesh(g, patchWarp(new MeshLambertMaterial({ color: '#b9a3a0', flatShading: true }), 'plat'));
  m.receiveShadow = true;
  return m;
}

function makePillars(seed, castShadow) {
  const r = rng(seed);
  const parts = [];
  const count = 10;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.2;
    const rad = 8.6 + r() * 0.6;
    const broken = r() < 0.45;
    const h = broken ? 1.0 + r() * 1.4 : 3.2 + r() * 0.8;
    const col = new CylinderGeometry(0.36, 0.42, h, 8, 1);
    col.translate(0, h / 2 - 0.5, 0);
    if (broken) col.rotateZ((r() - 0.5) * 0.25);
    const base = new BoxGeometry(1.1, 0.3, 1.1).translate(0, -0.42, 0);
    const list = [col, base];
    if (!broken) list.push(new BoxGeometry(1.05, 0.28, 1.05).translate(0, h - 0.4, 0));
    for (const g of list) {
      g.rotateY(r() * 0.3);
      g.translate(Math.cos(a) * rad, 0, Math.sin(a) * rad);
      parts.push(g.index ? g.toNonIndexed() : g);
    }
    if (broken && r() < 0.8) {
      // a fallen chunk lying on the ground
      const ch = new CylinderGeometry(0.36, 0.36, 0.9, 8, 1).rotateZ(Math.PI / 2).rotateY(r() * 3)
        .translate(Math.cos(a + 0.12) * (rad + 0.9), -0.2, Math.sin(a + 0.12) * (rad + 0.9));
      parts.push(ch.toNonIndexed());
    }
  }
  const g = mergeGeometries(parts.map((p) => { if (p.attributes.uv) p.deleteAttribute('uv'); return p; }));
  g.computeVertexNormals();
  const m = new Mesh(g, patchWarp(new MeshLambertMaterial({ color: '#d2bfb6', flatShading: true }), 'pillar'));
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}

function makeBanner(color, trim, x, z, yaw) {
  const g = new Group();
  const pole = new Mesh(new CylinderGeometry(0.06, 0.08, 5.2, 6).translate(0, 2.1, 0), patchWarp(new MeshLambertMaterial({ color: '#4a3326' }), 'pole'));
  const finial = new Mesh(new IcosahedronGeometry(0.16, 0).translate(0, 4.75, 0), patchWarp(new MeshLambertMaterial({ color: '#f2c46d', emissive: '#6a4510' }), 'finial'));
  const cloth = new PlaneGeometry(1.25, 2.6, 6, 12);
  cloth.translate(0.66, 3.2, 0);
  // Swallow-tail cut on the bottom edge
  const p = cloth.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), xx = p.getX(i);
    if (y < 2.0) p.setY(i, y + Math.max(0, 0.45 - Math.abs(xx - 0.66) * 0.9) * (2.0 - y) * 0.7);
  }
  const cols = [];
  const c1 = new Color(color), c2 = new Color(trim);
  for (let i = 0; i < p.count; i++) {
    const xx = p.getX(i), y = p.getY(i);
    const edge = xx > 1.18 || y > 4.42 || (Math.abs(xx - 0.66) < 0.08 && y > 2.6 && y < 4.0);
    const c = edge ? c2 : c1;
    cols.push(c.r, c.g, c.b);
  }
  cloth.setAttribute('color', new Float32BufferAttribute(cols, 3));
  const mat = windPatch(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }), 'banner',
    'clamp(position.x / 1.3, 0.0, 1.0)', '(modelMatrix * vec4(position, 1.0)).xyz', 0.55);
  const clothMesh = new Mesh(cloth, mat);
  g.add(pole, finial, clothMesh);
  g.position.set(x, -0.4, z);
  g.rotation.y = yaw;
  return g;
}

function makeTrees(count, seed, castShadow) {
  const r = rng(seed);
  const trunks = [], leaves = [];
  const leafColors = ['#7aa35a', '#93b766', '#c98f6a', '#d9a06d', '#a7c26c'];
  for (let i = 0; i < count; i++) {
    const a = Math.PI * (0.62 + r() * 0.95) + (i % 2 ? Math.PI * 0.9 : 0);
    const rad = 9.2 + r() * 1.1;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    const s = 0.8 + r() * 0.6;
    const h = 1.6 * s;
    trunks.push(new CylinderGeometry(0.1 * s, 0.17 * s, h, 6).translate(x, h / 2 - 0.55, z).toNonIndexed());
    const col = new Color(leafColors[Math.floor(r() * leafColors.length)]);
    for (let k = 0; k < 3; k++) {
      const leaf = new IcosahedronGeometry((0.65 + r() * 0.35) * s, 0);
      leaf.translate(x + (r() - 0.5) * 0.7 * s, h - 0.35 + k * 0.32 * s, z + (r() - 0.5) * 0.7 * s);
      const c = col.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08);
      const cc = new Float32Array(leaf.attributes.position.count * 3);
      for (let j = 0; j < cc.length; j += 3) { cc[j] = c.r; cc[j + 1] = c.g; cc[j + 2] = c.b; }
      leaf.setAttribute('color', new Float32BufferAttribute(cc, 3));
      leaves.push(leaf);
    }
  }
  const g = new Group();
  if (!count) return g;
  trunks.forEach((t) => t.deleteAttribute('uv'));
  leaves.forEach((t) => t.deleteAttribute('uv'));
  const trunk = new Mesh(mergeGeometries(trunks), patchWarp(new MeshLambertMaterial({ color: '#5b3d2e', flatShading: true }), 'trunk'));
  const leafMat = windPatch(new MeshLambertMaterial({ vertexColors: true, flatShading: true }), 'leaf',
    'clamp((position.y + 0.2) / 2.5, 0.0, 1.0)', 'position', 0.18);
  const leaf = new Mesh(mergeGeometries(leaves), leafMat);
  trunk.castShadow = leaf.castShadow = castShadow;
  g.add(trunk, leaf);
  return g;
}

function makeGrass(count, seed) {
  if (!count) return null;
  const r = rng(seed);
  // A tuft = three crossed tapered blades.
  const blade = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const c = Math.cos(a) * 0.05, s = Math.sin(a) * 0.05;
    blade.push(-c, 0, -s, c, 0, s, 0, 0.32, 0);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(blade, 3));
  geo.computeVertexNormals();
  const mat = windPatch(new MeshLambertMaterial({ side: DoubleSide }), 'grass',
    'clamp(position.y / 0.32, 0.0, 1.0)', '(instanceMatrix * vec4(position, 1.0)).xyz', 0.32);
  const mesh = new InstancedMesh(geo, mat, count);
  const d = new Object3D();
  const cA = new Color('#9cc46a'), cB = new Color('#d6c674');
  for (let i = 0; i < count; i++) {
    let x, z, rr;
    do { x = (r() * 2 - 1) * 10.6; z = (r() * 2 - 1) * 10.6; rr = Math.hypot(x, z); } while (rr < 7.7 || rr > 10.2);
    d.position.set(x, -0.04 - r() * 0.05, z);
    const s = 0.7 + r() * 0.9;
    d.scale.set(s, s * (0.8 + r() * 0.6), s);
    d.updateMatrix();
    mesh.setMatrixAt(i, d.matrix);
    mesh.setColorAt(i, cA.clone().lerp(cB, r() * 0.6));
  }
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function cloudTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  const blobs = [[40, 40, 22], [64, 32, 28], [90, 40, 20], [56, 44, 18], [76, 46, 18]];
  for (const [x, y, rad] of blobs) {
    const grd = g.createRadialGradient(x, y - 4, 2, x, y, rad);
    grd.addColorStop(0, 'rgba(255,240,230,0.95)'); grd.addColorStop(0.6, 'rgba(255,215,205,0.75)'); grd.addColorStop(1, 'rgba(255,200,200,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function makeClouds(count, seed) {
  const r = rng(seed);
  const tex = cloudTexture();
  const g = new Group();
  for (let i = 0; i < count; i++) {
    const mat = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: true, color: new Color().setHSL(0.03, 0.5, 0.86 + r() * 0.1) });
    const s = new Sprite(mat);
    const a = r() * Math.PI * 2;
    const d = 45 + r() * 110;
    s.position.set(Math.cos(a) * d, -14 + r() * 30, Math.sin(a) * d);
    const sc = 18 + r() * 26;
    s.scale.set(sc, sc * 0.5, 1);
    s.userData.speed = 0.4 + r() * 0.8;
    s.userData.base = s.position.clone();
    g.add(s);
  }
  return g;
}

function makeFarIslands(count, seed) {
  const r = rng(seed);
  const g = new Group();
  const mat = patchWarp(new MeshLambertMaterial({ vertexColors: true, flatShading: true }), 'farisland');
  for (let i = 0; i < count; i++) {
    const geo = makeIslandGeometry(3 + r() * 4, 4 + r() * 5, seed + i * 13, 4, 18);
    const m = new Mesh(geo, mat);
    const a = (i / count) * Math.PI * 2 + r() * 0.6;
    const d = 55 + r() * 70;
    m.position.set(Math.cos(a) * d, -6 + r() * 14, Math.sin(a) * d);
    m.rotation.y = r() * 6;
    m.userData.bob = r() * 6;
    g.add(m);
  }
  return g;
}

function makePetals(count, seed) {
  if (!count) return null;
  const r = rng(seed);
  const pos = new Float32Array(count * 3), rnd = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (r() * 2 - 1) * 14; pos[i * 3 + 1] = r() * 7; pos[i * 3 + 2] = (r() * 2 - 1) * 14; rnd[i] = r();
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aRnd', new Float32BufferAttribute(rnd, 1));
  const mat = new ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: globalUniforms.uTime, uWind: globalUniforms.uWind, uWindDir: globalUniforms.uWindDir, uScale: { value: 300 }, uTimeWarp: globalUniforms.uTimeWarp },
    vertexShader: /* glsl */`
      uniform float uTime, uWind, uScale; uniform float uWindDir[3];
      attribute float aRnd; varying float vR;
      void main() {
        vec3 w = normalize(vec3(uWindDir[0], 0.0, uWindDir[2]));
        float t = uTime * (0.4 + aRnd * 0.4);
        vec3 p = position + w * (t * 1.6) + vec3(sin(t * 1.3 + aRnd * 30.0), -t * 0.35, cos(t * 1.1 + aRnd * 20.0)) * 0.8;
        p.xz = mod(p.xz + 14.0, 28.0) - 14.0;
        p.y = mod(p.y, 7.0) - 0.3;
        vR = aRnd;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uScale * (0.05 + aRnd * 0.04) / -mv.z;
      }`,
    fragmentShader: /* glsl */`
      varying float vR; ${WARP_GLSL.decl}
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c * vec2(1.0, 1.8));
        if (d > 0.5) discard;
        gl_FragColor = vec4(mix(vec3(1.0, 0.78, 0.84), vec3(1.0, 0.93, 0.8), vR), 0.9);
        #include <colorspace_fragment>
        ${WARP_GLSL.apply}
      }`,
  });
  const pts = new Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

// ---------------------------------------------------------------------------

export class Environment {
  constructor(scene, tier) {
    this.group = new Group();
    scene.add(this.group);
    this.tier = tier;
    scene.fog = new Fog(HORIZON.clone().lerp(new Color('#c9849a'), 0.3), 70, 260);
    this.group.add(makeSky());
    this.group.add(makeCloudSea(tier.name === 'low' ? 2 : tier.name === 'medium' ? 4 : 5));

    const islandMat = patchWarp(new MeshLambertMaterial({ vertexColors: true, flatShading: true }), 'island');
    const island = new Mesh(makeIslandGeometry(11, 10, 5, 7, tier.name === 'low' ? 32 : 56), islandMat);
    island.position.y = -0.55;
    island.receiveShadow = tier.shadows !== 'blob';
    this.group.add(island);
    this.group.add(makePlatform());
    this.group.add(makePillars(11, tier.shadows === 'soft'));
    this.banners = [
      makeBanner('#efe3cc', '#d9a441', -7.6, -5.4, 0.5),
      makeBanner('#4b3a6b', '#c8a2ff', 7.6, -5.4, -0.5),
    ];
    this.banners.forEach((b) => this.group.add(b));
    this.group.add(makeTrees(tier.trees, 21, tier.shadows === 'soft'));
    const grass = makeGrass(tier.grass, 3);
    if (grass) this.group.add(grass);
    this.clouds = makeClouds(tier.clouds, 9);
    this.group.add(this.clouds);
    this.farIslands = makeFarIslands(tier.islands, 33);
    this.group.add(this.farIslands);
    this.petals = makePetals(tier.petals, 4);
    if (this.petals) this.group.add(this.petals);

    // Lighting: warm low sun from the front-left, violet sky fill.
    this.hemi = new HemisphereLight('#d9c6ff', '#7a5240', 1.35);
    this.sun = new DirectionalLight('#ffd6a8', 2.3);
    this.sun.position.set(-6, 11, 5.5);
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.hemi, this.sun, this.sun.target);
    if (tier.shadows !== 'blob') {
      this.sun.castShadow = true;
      const s = this.sun.shadow;
      s.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
      const ext = tier.shadows === 'soft' ? 11 : 6.2;
      s.camera.left = -ext; s.camera.right = ext; s.camera.top = ext; s.camera.bottom = -ext;
      s.camera.near = 1; s.camera.far = 40;
      s.bias = -0.0015;
      s.normalBias = 0.045;
      s.radius = tier.shadows === 'soft' ? 3 : 1;
    }
    // Sun glow disc in the sky (cheap sprite) for extra warmth
    const glow = new Mesh(new CircleGeometry(30, 32), new MeshBasicMaterial({ color: '#ffe3b5', transparent: true, opacity: 0.18, blending: AdditiveBlending, depthWrite: false, fog: false }));
    glow.position.copy(SUN_DIR).multiplyScalar(420);
    glow.lookAt(0, 0, 0);
    this.group.add(glow);
  }

  update(time) {
    for (const s of this.clouds.children) {
      const b = s.userData.base;
      s.position.x = b.x + Math.sin(time * 0.01 * s.userData.speed) * 12;
      s.position.z = b.z + Math.cos(time * 0.008 * s.userData.speed) * 8;
    }
    for (const m of this.farIslands.children) m.position.y += Math.sin(time * 0.3 + m.userData.bob) * 0.002;
  }
}
