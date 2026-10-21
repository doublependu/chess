// How well the piece outlines read, for the `outline` playtest (window.__test.outlineStats). Loaded on demand.
//
// Each frame is drawn twice more, flat: the bodies in an id colour per piece, then the outline hulls alone in
// white. A pixel next to a body that the hull covers but the body doesn't is outline the player can see.
//   coverage  share of the pixels just outside each body's silhouette that are outline (a broken outline < 1)
//   width     outline pixels per silhouette pixel, about the outline's width in pixels
//   flicker   outline pixels that change from one frame to the next, per outline pixel
import { MeshBasicMaterial, Color, SRGBColorSpace } from 'three';
import { idleMotion } from '../render/quality.js';

const WHITE = new Color(1, 1, 1);

// Ids in steps of 16 per channel survive the sRGB round trip and 8-bit rounding.
const idColor = (i) => new Color().setRGB(((i % 15) + 1) * 16 / 255, (Math.floor(i / 15) + 1) * 16 / 255, 0, SRGBColorSpace);
const decode = (r, g) => (r < 8 || g < 8 ? 0 : (Math.round(g / 16) - 1) * 15 + Math.round(r / 16));

function read(gl, w, h, out) {
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

export function outlineStats(stage, { t0 = 10, frames = 30, step = 1 / 30, scale = 1 } = {}) {
  const { renderer, scene, governor } = stage;
  const camera = stage.rig.camera;
  const gl = renderer.getContext();
  const saved = { enabled: governor.enabled, scale: governor.scale, clock: stage.clock, fog: scene.fog, clear: renderer.getClearColor(new Color()) };
  governor.enabled = false;
  governor.scale = scale;
  stage.applyPixelRatio();

  const views = stage.views.views.filter((v) => v.alive && v.root.visible && v.outline);
  const roots = new Set(views.map((v) => v.root));
  const hidden = scene.children.filter((o) => o.visible && !roots.has(o) && !o.isLight);
  const ids = views.map((v, i) => new MeshBasicMaterial({ color: idColor(i), fog: false }));
  const outlineMat = stage.factory.outlineMat;
  const outlineColor = outlineMat.color.clone();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const bodyBuf = new Uint8Array(w * h * 4), hullBuf = new Uint8Array(w * h * 4);
  const per = views.map(() => ({ edge: 0, covered: 0, line: 0 }));
  const pixelRatio = stage.pixelRatio;
  let prev = null, toggles = 0, lineTotal = 0;

  for (const o of hidden) o.visible = false;
  for (const v of views) if (v.blob) v.blob.visible = false;
  scene.fog = null;
  renderer.setClearColor(0x000000, 1);
  const materials = views.map((v) => v.mesh.material);
  try {
    for (let k = 0; k < frames; k++) {
      stage.clock = t0 + k * step;
      stage.update(0);
      views.forEach((v, i) => { v.mesh.material = [ids[i], ids[i]]; v.mesh.visible = true; v.outline.visible = false; });
      renderer.render(scene, camera);
      read(gl, w, h, bodyBuf);
      views.forEach((v) => { v.mesh.visible = false; v.outline.visible = true; });
      outlineMat.color.copy(WHITE);
      renderer.render(scene, camera);
      read(gl, w, h, hullBuf);
      outlineMat.color.copy(outlineColor);

      const body = new Int16Array(w * h);
      for (let p = 0; p < w * h; p++) body[p] = decode(bodyBuf[p * 4], bodyBuf[p * 4 + 1]);
      const line = new Uint8Array(w * h);
      for (let p = 0; p < w * h; p++) line[p] = !body[p] && hullBuf[p * 4] > 127 ? 1 : 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (body[p]) continue;
          const q = body[p - 1] || body[p + 1] || body[p - w] || body[p + w];
          if (q && per[q - 1]) { per[q - 1].edge++; if (line[p]) per[q - 1].covered++; }
          if (line[p]) {
            lineTotal++;
            // A line pixel belongs to the nearest body within 3 px, for the width per piece.
            for (let r = 1; r <= 3; r++) {
              const n = body[p - r] || body[p + r] || body[p - r * w] || body[p + r * w];
              if (n && per[n - 1]) { per[n - 1].line++; break; }
            }
          }
        }
      }
      if (prev) for (let p = 0; p < w * h; p++) toggles += prev[p] ^ line[p];
      prev = line;
    }
  } finally {
    views.forEach((v, i) => { v.mesh.material = materials[i]; v.mesh.visible = true; v.outline.visible = true; if (v.blob) v.blob.visible = true; });
    outlineMat.color.copy(outlineColor);
    for (const o of hidden) o.visible = true;
    scene.fog = saved.fog;
    renderer.setClearColor(saved.clear, 1);
    ids.forEach((m) => m.dispose());
    stage.clock = saved.clock;
    governor.enabled = saved.enabled;
    governor.scale = saved.scale;
    stage.applyPixelRatio();
    stage.requestRender();
  }

  const pieces = views.map((v, i) => ({
    square: v.square, type: v.type, color: v.color,
    coverage: per[i].edge ? +(per[i].covered / per[i].edge).toFixed(3) : null,
    width: per[i].edge ? +(per[i].line / per[i].edge).toFixed(2) : null,
  })).filter((p) => p.coverage !== null);
  const sorted = pieces.map((p) => p.coverage).sort((a, b) => a - b);
  const sum = (f) => per.reduce((a, x) => a + x[f], 0);
  return {
    size: [w, h], pixelRatio, tier: stage.tierName, frames,
    idle: idleMotion(stage.settings.idleMotion, { coarse: stage.info.coarse, tier: stage.tierName, reducedMotion: stage.settings.reducedMotion }),
    coverage: +(sum('covered') / Math.max(1, sum('edge'))).toFixed(3),
    minCoverage: sorted[0] ?? null,
    medianCoverage: sorted[Math.floor(sorted.length / 2)] ?? null,
    width: +(sum('line') / Math.max(1, sum('edge'))).toFixed(2),
    flicker: frames > 1 ? +(toggles / Math.max(1, lineTotal - lineTotal / frames)).toFixed(3) : null,
    worst: pieces.slice().sort((a, b) => a.coverage - b.coverage).slice(0, 4),
  };
}
