import {
  WebGLRenderer, Scene, Raycaster, Vector2, Vector3, Plane, PCFShadowMap, SRGBColorSpace, Color, Group, Mesh, BoxGeometry,
} from 'three';
import { CameraRig } from './camera.js';
import { BoardView } from './board.js';
import { Environment } from './environment/index.js';
import { PieceFactory, PieceView, PICK_LAYER } from './pieces/pieceView.js';
import { globalUniforms, outlineUniforms, createPieceMaterial, createInnerMaterial } from './materials.js';
import { Governor, TIERS, idleMotion } from './quality.js';
import { xzToSquare } from './coords.js';
import { Animator } from '../anim/timeline.js';
import { pixelScale, Burst, Shockwave, Streaks } from './fx/particles.js';
import { PREVAILING } from '../destruction/wind.js';

/** Keeps track of which view stands on which square, and how to undo each move. */
export class ViewBoard {
  constructor(stage) {
    this.stage = stage;
    this.bySquare = new Map();
    this.views = [];
    this.history = [];
    this.nextId = 1;
  }

  clear() {
    for (const v of this.views) { v.root.removeFromParent(); v.dispose(); }
    this.views = [];
    this.bySquare.clear();
    this.history = [];
  }

  create(type, color, square) {
    const v = new PieceView(this.stage.factory, type, color, square, this.nextId++);
    this.stage.scene.add(v.root);
    this.views.push(v);
    return v;
  }

  reset(pieces) {
    this.clear();
    for (const p of pieces) this.bySquare.set(p.square, this.create(p.type, p.color, p.square));
  }

  /** Updates the logical mapping for a move; returns the views involved (for the clip). */
  applyMove(rec) {
    const mover = this.bySquare.get(rec.from);
    if (!mover) throw new Error('No view on ' + rec.from);
    const inv = { mover, captured: null, rook: null, promoted: null };
    this.bySquare.delete(rec.from);
    if (rec.captured) {
      inv.captured = this.bySquare.get(rec.captured.square) || null;
      this.bySquare.delete(rec.captured.square);
      if (inv.captured) inv.captured.alive = false;
    }
    if (rec.castle) {
      inv.rook = this.bySquare.get(rec.castle.rookFrom);
      this.bySquare.delete(rec.castle.rookFrom);
      this.bySquare.set(rec.castle.rookTo, inv.rook);
      inv.rook.square = rec.castle.rookTo;
    }
    if (rec.promotion) {
      inv.promoted = this.create(rec.promotion, rec.color, rec.to);
      inv.promoted.root.visible = false;
      mover.alive = false;
      this.bySquare.set(rec.to, inv.promoted);
    } else {
      this.bySquare.set(rec.to, mover);
    }
    mover.square = rec.to;
    this.history.push({ rec, inv });
    return inv;
  }

  /** Reverts the last move's mapping; returns the views involved. */
  undoMove() {
    const h = this.history.pop();
    if (!h) return null;
    const { rec, inv } = h;
    this.bySquare.delete(rec.to);
    inv.mover.alive = true;
    inv.mover.square = rec.from;
    this.bySquare.set(rec.from, inv.mover);
    if (rec.castle && inv.rook) {
      this.bySquare.delete(rec.castle.rookTo);
      this.bySquare.set(rec.castle.rookFrom, inv.rook);
      inv.rook.square = rec.castle.rookFrom;
    }
    if (inv.captured) {
      inv.captured.alive = true;
      inv.captured.square = rec.captured.square;
      this.bySquare.set(rec.captured.square, inv.captured);
    }
    return { rec, inv };
  }

  /** Removes a view created for a promotion once its move has been undone. */
  discard(view) {
    const i = this.views.indexOf(view);
    if (i >= 0) this.views.splice(i, 1);
    view.root.removeFromParent();
    view.dispose();
  }

  peek() { return this.history[this.history.length - 1] || null; }

  /** Snaps every view to its logical square (guards against any animation drift). */
  syncAll() {
    const onBoard = new Set(this.bySquare.values());
    for (const v of this.views) {
      if (onBoard.has(v)) {
        v.alive = true;
        for (const [sq, vv] of this.bySquare) if (vv === v) { v.placeAt(sq); break; }
        v.root.visible = true;
      } else {
        v.alive = false;
        v.root.visible = false;
      }
    }
  }

  at(square) { return this.bySquare.get(square) || null; }
}

export class Stage {
  constructor(canvas, { tierName, info, settings }) {
    this.canvas = canvas;
    this.info = info;
    this.settings = settings;
    this.tierName = tierName;
    this.tier = TIERS[tierName];
    this.renderer = new WebGLRenderer({
      canvas, antialias: this.tier.msaa && !(info.coarse && tierName !== 'high'), powerPreference: 'high-performance',
      stencil: false, alpha: false, preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setClearColor(new Color('#c98a86'));
    this.scene = new Scene();
    this.rig = new CameraRig();
    this.rig.reducedMotion = settings.reducedMotion;
    this.animator = new Animator();
    this.raycaster = new Raycaster();
    this.raycaster.layers.set(PICK_LAYER);
    this.time = 0;
    this.lastFrame = 0;
    this.lastRender = 0;
    this.running = false;
    this.frozen = false; // idle animation stopped (rewind "time stop")
    this.clock = null; // tests: every frame at this time (debug/testHooks.js)
    this.selected = null;
    this.checkSquare = null;
    this.sideToMove = 0;
    this.listeners = new Set();
    this.governor = new Governor({
      onScale: () => this.applyPixelRatio(),
      onTierDrop: (why) => this.onTierDrop?.(why),
    });
    globalUniforms.uWindDir.value = PREVAILING;
    this.buildWorld();
    this.views = new ViewBoard(this);
    this.setupResize();
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; this.onContextLost?.(); });
    canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.onContextRestored?.(); });
  }

  buildWorld() {
    const t = this.tier;
    this.renderer.shadowMap.enabled = t.shadows !== 'blob';
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.env = new Environment(this.scene, t);
    this.board = new BoardView({ textureSize: t.boardTex, receiveShadow: t.shadows !== 'blob' });
    this.board.setOrientation(this.side || 0);
    this.scene.add(this.board.group);
    this.factory = new PieceFactory({ segments: t.segments, blobShadows: t.shadows === 'blob', outlines: true });
    this.governor.setLimits(t.pixelRatioMin / t.pixelRatioMax);
    this.setupPost();
  }

  /**
   * Compiles the shaders first used at a capture (shards, crack glow, particles, shadow depth)
   * by rendering them once hidden inside the board slab, so the first impact doesn't stall.
   */
  warmup() {
    const g = new Group();
    const geo = new BoxGeometry(0.2, 0.2, 0.2);
    geo.clearGroups(); geo.addGroup(0, 18, 0); geo.addGroup(18, 18, 1);
    const mats = [createPieceMaterial(0), createInnerMaterial(0)];
    const shard = new Mesh(geo, mats);
    shard.castShadow = true;
    const at = new Vector3(0, -0.3, 0);
    const fx = [
      new Burst({ origin: at, count: 4, additive: true }), new Burst({ origin: at, count: 4 }),
      new Shockwave(at), new Streaks({ count: 2 }),
    ];
    shard.position.copy(at);
    g.add(shard, ...fx.map((f) => f.object));
    fx.forEach((f) => f.setTime(0.05));
    this.scene.add(g);
    const done = () => {
      g.removeFromParent();
      geo.dispose(); mats.forEach((m) => m.dispose()); fx.forEach((f) => f.dispose());
    };
    // Two rendered frames (main + shadow passes) then remove.
    let frames = 0;
    const tick = () => { if (++frames >= 2) { this.listeners.delete(tick); done(); } };
    this.listeners.add(tick);
    this.requestRender();
  }

  /** Bloom + vignette on the high tier, loaded on demand (not on the critical path). */
  setupPost() {
    const want = this.tier.post && !this.settings.noPost;
    if (!want) { this.post?.dispose(); this.post = null; return; }
    if (this.post || this.postLoading) return;
    this.postLoading = import('./post.js').then(({ createPost }) => {
      this.postLoading = null;
      if (!this.tier.post) return;
      this.post = createPost(this.renderer, this.scene, this.rig.camera);
      if (this.width) this.post.setSize(this.width, this.height, this.pixelRatio);
    }).catch((e) => { this.postLoading = null; console.warn('post-processing unavailable', e); });
  }

  setSide(color, instant = false) {
    this.side = color;
    this.rig.setSide(color, instant);
    this.board.setOrientation(color);
  }

  /** Switches quality tier at runtime (rebuilds environment and piece geometry). */
  setTier(name) {
    if (name === this.tierName) return;
    this.tierName = name;
    this.tier = TIERS[name];
    this.env.group.removeFromParent();
    this.scene.remove(this.env.hemi, this.env.sun, this.env.sun.target);
    this.board.group.removeFromParent();
    const oldFactory = this.factory;
    this.buildWorld();
    for (const v of this.views.views) v.rebuild(this.factory);
    oldFactory.dispose();
    this.governor.reset();
    this.applyPixelRatio();
    this.renderer.compile(this.scene, this.rig.camera);
    this.onRebuilt?.();
  }

  setupResize() {
    const app = this.canvas.parentElement;
    const measure = () => {
      const w = app.clientWidth, h = app.clientHeight;
      if (w === this.width && h === this.height) return;
      this.width = w; this.height = h;
      this.applyPixelRatio();
      this.renderer.setSize(w, h, false);
      this.rig.setSize(w, h, this.computeInsets?.() || this.rig.insets);
      this.requestRender();
    };
    this.measure = () => { this.width = 0; measure(); };
    const schedule = () => {
      measure();
      // iOS sometimes reports stale sizes for a frame or two after rotation.
      requestAnimationFrame(() => { measure(); requestAnimationFrame(measure); });
      setTimeout(measure, 350);
    };
    new ResizeObserver(schedule).observe(app);
    window.visualViewport?.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    screen.orientation?.addEventListener?.('change', schedule);
    measure();
  }

  refreshInsets() {
    if (!this.width) return;
    this.rig.setSize(this.width, this.height, this.computeInsets?.() || this.rig.insets);
  }

  applyPixelRatio() {
    const t = this.tier;
    const base = Math.min(window.devicePixelRatio || 1, t.pixelRatioMax);
    const pr = Math.max(Math.min(t.pixelRatioMin, base), base * this.governor.scale);
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    if (this.width) this.renderer.setSize(this.width, this.height, false);
    if (this.post && this.width) this.post.setSize(this.width, this.height, pr);
    pixelScale.value = (this.height || 800) * pr * 0.9;
    // MSAA smooths a thin outline; without it the outline needs a pixel and a half to stay unbroken.
    outlineUniforms.uMinPx.value = this.renderer.getContextAttributes()?.antialias ? 1 : 1.5;
    outlineUniforms.uWorldPerPx.value = (2 * Math.tan((this.rig.camera.fov * Math.PI) / 360)) / ((this.height || 800) * pr);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      this.frame(now);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  requestRender() { this.needsRender = true; }

  frame(now) {
    const dtMs = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    const animating = this.animator.active || this.rig.intro > 0 || this.interacting;
    const cap = animating ? 1000 / 60 : 1000 / this.tier.fpsIdle;
    if (now - this.lastRender < cap - 3 && !this.needsRender) return;
    const dt = Math.min(0.1, (now - (this.lastRender || now)) / 1000);
    this.lastRender = now;
    this.needsRender = false;
    if (this.contextLost) return;
    const c0 = performance.now();
    this.update(dt);
    const c1 = performance.now();
    if (this.post) this.post.render(); else this.renderer.render(this.scene, this.rig.camera);
    const c2 = performance.now();
    if (c2 - c0 > 30 && this.slowLog) this.slowLog.push({ t: Math.round(c0), update: +(c1 - c0).toFixed(1), render: +(c2 - c1).toFixed(1), calls: this.renderer.info.render.calls, programs: this.renderer.info.programs?.length });
    this.cpuUpdate = (this.cpuUpdate || 0) * 0.9 + (c1 - c0) * 0.1;
    this.cpuRender = (this.cpuRender || 0) * 0.9 + (c2 - c1) * 0.1;
    this.governor.frame(now, dt * 1000, 1000 / 60);
    for (const fn of this.listeners) fn(dt);
  }

  update(dt) {
    this.time = this.clock ?? this.time + dt;
    globalUniforms.uTime.value = this.time;
    this.animator.update(dt);
    // Wind: the strongest active gust plus a gentle breeze.
    const target = this.animator.wind || 0;
    globalUniforms.uWind.value += (target - globalUniforms.uWind.value) * Math.min(1, dt * 8);
    this.rig.shake = this.animator.shake || 0;
    this.updateIdle(dt);
    this.env.update(this.time);
    this.board.update(this.time);
    this.rig.update(dt, this.time);
  }

  updateIdle(dt) {
    const m = IDLE[idleMotion(this.settings.idleMotion, { coarse: this.info.coarse, tier: this.tierName, reducedMotion: this.settings.reducedMotion })];
    const k = 1 - Math.exp(-dt * 10);
    for (const v of this.views.views) {
      if (!v.root.visible) continue;
      const amp = this.frozen ? 0 : v.color === this.sideToMove ? m.move : m.wait;
      const t = this.time * (this.frozen ? 0 : 1) + v.phase;
      const breathe = 1 + Math.sin(t * 2.1) * m.breathe * amp;
      const lift = v === this.selected ? 0.22 + Math.sin(this.time * 4.2) * 0.03 : 0;
      v.lift = (v.lift || 0) + (lift - (v.lift || 0)) * k;
      v.idleG.scale.set(1 / Math.sqrt(breathe), breathe, 1 / Math.sqrt(breathe));
      v.idleG.position.y = (Math.sin(t * m.rate) * 0.5 + 0.5) * m.bob * amp + v.lift;
      v.idleG.rotation.y = (v.type === 2 ? Math.sin(t * 0.6) * m.knight : Math.sin(t * 0.4) * m.sway) * amp;
      const inCheck = this.checkSquare && v.square === this.checkSquare && v.type === 6 && v.alive;
      v.idleG.rotation.z = inCheck && !this.frozen ? Math.sin(this.time * 38) * 0.035 : 0;
      if (!v.inClip) {
        if (inCheck) v.setFlash(0.35 + Math.sin(this.time * 6) * 0.25, CHECK_RED);
        else if (v === this.selected) v.setFlash(0.12, SELECT_GOLD);
        else v.setFlash(0);
      }
    }
  }

  /** Square under a screen point (pieces first, then the board plane). */
  pickSquare(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    // Precise hit on the front-most visible piece surface first…
    this.raycaster.layers.enableAll();
    const live = this.views.views.filter((v) => v.alive && v.root.visible);
    const hits = this.raycaster.intersectObjects(live.map((v) => v.mesh), false);
    this.raycaster.layers.set(PICK_LAYER);
    if (hits.length) {
      const view = live.find((v) => v.mesh === hits[0].object);
      if (view) return view.square;
    }
    // …otherwise the square under the finger.
    return this.boardPoint(clientX, clientY, 0, (p) => xzToSquare(p.x, p.z));
  }

  pickSquareOnBoard(clientX, clientY) {
    return this.boardPoint(clientX, clientY, 0, (p) => xzToSquare(p.x, p.z));
  }

  boardPoint(clientX, clientY, y = 0, map = (p) => p) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const p = new Vector3();
    if (!this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -y), p)) return null;
    return map(p);
  }

  /** Screen position (CSS px) of a square centre — used by tests and the promotion picker. */
  squareToScreen(square, y = null) {
    if (y === null) { const v = this.views.at(square); y = v && v.root.visible ? v.height * 0.6 : 0.02; }
    const { x, z } = { x: square.charCodeAt(0) - 97 - 3.5, z: 3.5 - (square.charCodeAt(1) - 49) };
    const v = new Vector3(x, y, z).project(this.rig.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }
}

// Idle motion (`idleMotion` in quality.js). `move`/`wait`: how much the side to move and the other side do it.
// Calm: only the side to move bobs, slowly and at half height, with no breathing and a small turn of the knight.
const IDLE = {
  full: { move: 1.25, wait: 0.85, breathe: 0.02, bob: 0.025, rate: 1.3, sway: 0.05, knight: 0.28 },
  calm: { move: 1, wait: 0, breathe: 0, bob: 0.0125, rate: 0.9, sway: 0, knight: 0.08 },
  off: { move: 0, wait: 0, breathe: 0, bob: 0, rate: 0, sway: 0, knight: 0 },
};

const CHECK_RED = new Color('#ff3b30');
const SELECT_GOLD = new Color('#ffcf6b');
