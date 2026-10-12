import { BufferGeometry, BufferAttribute, Mesh, Group, Quaternion, Vector3 } from 'three';

/**
 * Talks to the destruction worker and caches results per capture, so rewinding within a
 * session replays exactly the same shards.
 */
export class DestructionManager {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.cache = new Map(); // key -> Promise<result>
    this.maxCache = 40;
    this.worker = null;
    this.failed = false;
  }

  start({ physics = true } = {}) {
    if (this.worker || this.failed) return;
    try {
      this.worker = new Worker(new URL('./destruction.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const { id, ok, result, error } = e.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (ok) p.resolve(result); else p.reject(new Error(error));
      };
      this.worker.onerror = (e) => {
        console.warn('destruction worker error', e.message);
        this.failed = true;
        for (const p of this.pending.values()) p.reject(new Error('worker failed'));
        this.pending.clear();
      };
      this.request('warm', { physics });
    } catch (e) {
      console.warn('destruction worker unavailable', e);
      this.failed = true;
    }
  }

  request(type, payload) {
    if (!this.worker) return Promise.reject(new Error('no worker'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  /** Returns a promise of {fragments, bake, frames, fps, count}; cached by key. */
  destroy(key, payload) {
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, v); // LRU touch
      return v;
    }
    if (!this.worker) this.start();
    const p = this.request('destroy', payload).catch((e) => { this.cache.delete(key); throw e; });
    this.cache.set(key, p);
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    return p;
  }
}

const _q0 = new Quaternion(), _q1 = new Quaternion(), _v0 = new Vector3(), _v1 = new Vector3();

/** Renders a baked destruction: one mesh per fragment, posed from keyframes at time t. */
export class ShardSet {
  constructor(result, outerMat, innerMat, { life }) {
    this.group = new Group();
    this.result = result;
    this.life = life;
    this.inner = innerMat;
    this.meshes = result.fragments.map((f) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(f.pos, 3));
      g.setAttribute('normal', new BufferAttribute(f.nrm, 3));
      if (f.idx) g.setIndex(new BufferAttribute(f.idx, 1));
      for (const gr of f.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
      g.computeBoundingSphere();
      const m = new Mesh(g, [outerMat, innerMat]);
      m.castShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.group.visible = false;
  }

  /** t: seconds since impact (negative = not yet shattered). */
  apply(t) {
    const r = this.result;
    if (t < 0 || t > this.life) { this.group.visible = false; return; }
    this.group.visible = true;
    const f = Math.min(r.frames - 1, t * r.fps);
    const i0 = Math.floor(f), i1 = Math.min(r.frames - 1, i0 + 1), a = f - i0;
    const n = r.count, b = r.bake;
    // Shrink away at the end of the debris lifetime.
    const fade = Math.min(1, Math.max(0, (this.life - t) / 0.7));
    const s = fade < 1 ? Math.max(0.001, fade * fade * (3 - 2 * fade)) : 1;
    for (let k = 0; k < n; k++) {
      const o0 = (i0 * n + k) * 7, o1 = (i1 * n + k) * 7;
      _v0.set(b[o0], b[o0 + 1], b[o0 + 2]);
      _v1.set(b[o1], b[o1 + 1], b[o1 + 2]);
      _q0.set(b[o0 + 3], b[o0 + 4], b[o0 + 5], b[o0 + 6]);
      _q1.set(b[o1 + 3], b[o1 + 4], b[o1 + 5], b[o1 + 6]);
      const m = this.meshes[k];
      m.position.lerpVectors(_v0, _v1, a);
      m.quaternion.slerpQuaternions(_q0, _q1, a);
      m.scale.setScalar(s);
    }
    // Cracks glow hot at the moment of impact and cool down.
    this.inner.emissiveIntensity = 1.6 * Math.exp(-t * 2.2) + 0.08;
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this.group.removeFromParent();
  }
}
