import {
  Group, Mesh, PlaneGeometry, BoxGeometry, MeshLambertMaterial, MeshBasicMaterial, CanvasTexture,
  DataTexture, RGBAFormat, NearestFilter, SRGBColorSpace, InstancedMesh, RingGeometry, CircleGeometry,
  Object3D, Color, LinearFilter, DoubleSide,
} from 'three';
import { patchWarp } from './materials.js';
import { squareToXZ, RIM } from './coords.js';

const HIGHLIGHT = {
  last: [255, 214, 120, 95],
  selected: [255, 196, 80, 150],
  check: [255, 70, 60, 170],
  hover: [255, 255, 255, 60],
  hint: [130, 230, 160, 120],
};

function makeBoardTexture(size, flipLabels = false) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const total = 8 + RIM * 2;
  const px = size / total;
  // Rim
  const rim = g.createLinearGradient(0, 0, size, size);
  rim.addColorStop(0, '#5a3d2e'); rim.addColorStop(1, '#3b2620');
  g.fillStyle = rim;
  g.fillRect(0, 0, size, size);
  // Squares with a little stone grain
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const light = (f + r) % 2 === 1;
      const x = (RIM + f) * px, y = (RIM + 7 - r) * px;
      g.fillStyle = light ? '#dcc196' : '#7d5c86';
      g.fillRect(x, y, px + 0.5, px + 0.5);
      for (let k = 0; k < 18; k++) {
        g.fillStyle = light ? `rgba(160,120,80,${0.04 + rnd() * 0.05})` : `rgba(40,20,60,${0.05 + rnd() * 0.07})`;
        const s = px * (0.08 + rnd() * 0.25);
        g.beginPath();
        g.ellipse(x + rnd() * px, y + rnd() * px, s, s * (0.4 + rnd() * 0.6), rnd() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  // Inner border line
  g.strokeStyle = 'rgba(255, 220, 160, 0.55)';
  g.lineWidth = Math.max(1, px * 0.04);
  g.strokeRect(RIM * px, RIM * px, 8 * px, 8 * px);
  // Coordinates
  g.fillStyle = 'rgba(255, 233, 196, 0.85)';
  g.font = `600 ${Math.round(px * 0.34)}px Georgia, serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Labels stay on their squares; when playing Black they're rotated to read upright.
  const label = (text, x, y) => {
    g.save();
    g.translate(x, y);
    if (flipLabels) g.rotate(Math.PI);
    g.fillText(text, 0, 0);
    g.restore();
  };
  for (let i = 0; i < 8; i++) {
    const file = String.fromCharCode(97 + i);
    label(file, (RIM + i + 0.5) * px, (RIM * 0.5) * px);
    label(file, (RIM + i + 0.5) * px, (total - RIM * 0.5) * px);
    label(String(8 - i), (RIM * 0.5) * px, (RIM + i + 0.5) * px);
    label(String(8 - i), (total - RIM * 0.5) * px, (RIM + i + 0.5) * px);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class BoardView {
  constructor({ textureSize = 1024, receiveShadow = true } = {}) {
    this.group = new Group();
    const total = 8 + RIM * 2;
    // Top surface (squares + rim + labels)
    this.textureSize = textureSize;
    this.textures = [makeBoardTexture(textureSize, false), null];
    this.orientation = 0;
    const top = new Mesh(new PlaneGeometry(total, total), patchWarp(new MeshLambertMaterial({ map: this.textures[0] }), 'board'));
    top.rotation.x = -Math.PI / 2;
    top.receiveShadow = receiveShadow;
    this.top = top;
    this.group.add(top);
    // Slab sides
    const slab = new Mesh(new BoxGeometry(total, 0.5, total), patchWarp(new MeshLambertMaterial({ color: '#46302a' }), 'slab'));
    slab.position.y = -0.262; // top sits 1 cm below the playing surface (no z-fighting)
    slab.receiveShadow = receiveShadow;
    this.slab = slab;
    this.group.add(slab);
    // Highlight overlay: an 8x8 data texture sampled with nearest filtering.
    this.hlData = new Uint8Array(8 * 8 * 4);
    this.hlTex = new DataTexture(this.hlData, 8, 8, RGBAFormat);
    this.hlTex.magFilter = this.hlTex.minFilter = NearestFilter;
    this.hlTex.colorSpace = SRGBColorSpace;
    this.hlTex.needsUpdate = true;
    const hl = new Mesh(new PlaneGeometry(8, 8), patchWarp(new MeshBasicMaterial({ map: this.hlTex, transparent: true, depthWrite: false }), 'hl'));
    hl.rotation.x = -Math.PI / 2;
    hl.position.y = 0.004;
    hl.renderOrder = 1;
    this.group.add(hl);
    this.highlights = new Map();

    // Legal-move markers
    const dummy = new Object3D();
    this._dummy = dummy;
    const markMat = patchWarp(new MeshBasicMaterial({ color: new Color('#ffd27a'), transparent: true, opacity: 0.85, depthWrite: false, side: DoubleSide }), 'mark');
    this.dots = new InstancedMesh(new CircleGeometry(0.15, 20), markMat, 32);
    this.rings = new InstancedMesh(new RingGeometry(0.36, 0.46, 32), markMat, 32);
    for (const m of [this.dots, this.rings]) {
      m.count = 0;
      m.renderOrder = 2;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.markMat = markMat;
  }

  /** 0 = White's view, 1 = Black's view (coordinates rotated to read upright). */
  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    if (!this.textures[color]) this.textures[color] = makeBoardTexture(this.textureSize, color === 1);
    this.top.material.map = this.textures[color];
    this.top.material.needsUpdate = true;
  }

  setHighlights(map) {
    this.hlData.fill(0);
    for (const [square, kind] of map) {
      const { x, z } = squareToXZ(square);
      const f = x + 3.5, r = 3.5 - z; // r: rank index (0 = rank 1)
      // Plane UV: v=0 at the near (+z after rotation) edge → rank 1 at row 0.
      const i = (r * 8 + f) * 4;
      const c = HIGHLIGHT[kind] || HIGHLIGHT.hover;
      // Overlapping highlights: keep the stronger one.
      if (this.hlData[i + 3] < c[3]) { this.hlData[i] = c[0]; this.hlData[i + 1] = c[1]; this.hlData[i + 2] = c[2]; this.hlData[i + 3] = c[3]; }
    }
    this.hlTex.needsUpdate = true;
  }

  setMarkers(quiet, captures) {
    const d = this._dummy;
    d.rotation.set(-Math.PI / 2, 0, 0);
    let i = 0;
    for (const sq of quiet) {
      const { x, z } = squareToXZ(sq);
      d.position.set(x, 0.012, z); d.updateMatrix();
      this.dots.setMatrixAt(i++, d.matrix);
    }
    this.dots.count = i;
    this.dots.instanceMatrix.needsUpdate = true;
    i = 0;
    for (const sq of captures) {
      const { x, z } = squareToXZ(sq);
      d.position.set(x, 0.012, z); d.updateMatrix();
      this.rings.setMatrixAt(i++, d.matrix);
    }
    this.rings.count = i;
    this.rings.instanceMatrix.needsUpdate = true;
  }

  update(time) {
    this.markMat.opacity = 0.65 + Math.sin(time * 4) * 0.2;
  }
}
