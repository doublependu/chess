// Move, attack, destruction, castling and promotion clips. Every clip is a pure function of
// time (see timeline.js) so the rewind can play it backwards exactly.
import { Vector3, Color } from 'three';
import { Clip, parallel, smooth, easeInOut, easeOutBack, easeOut, seg, bump, remap, lerp, clamp01 } from './timeline.js';
import { squareToVec } from '../render/coords.js';
import { Burst, Shockwave, Streaks } from '../render/fx/particles.js';
import { ShardSet } from '../destruction/manager.js';
import { gust, gustDir } from '../destruction/wind.js';
import { createPieceMaterial, createInnerMaterial, TEAM_GLOW } from '../render/materials.js';
import { PIECE_HEIGHT, PIECE_RADIUS } from '../render/pieces/geometry.js';

const TAU = Math.PI * 2;
const WHITE = new Color('#ffffff');
const _p = new Vector3();

// Attack styles per attacker type.
const ATTACK = {
  1: { name: 'headbutt', arc: 0.35, lunge: 0.28, lean: 0.55, spin: 0, approach: 0.42, power: 0.9 },
  2: { name: 'stomp', arc: 1.7, lunge: 0, lean: 0, spin: 0, approach: 0.62, stomp: true, power: 1.1 },
  3: { name: 'slash', arc: 0.18, lunge: 0.38, lean: 0.25, slash: 0.65, spin: 1, approach: 0.5, power: 1 },
  4: { name: 'slam', arc: 1.0, lunge: 0.12, lean: 0.15, spin: 0, approach: 0.55, slam: true, power: 1.25 },
  5: { name: 'spin dash', arc: 0.25, lunge: 0.42, lean: 0.4, spin: 2, approach: 0.55, power: 1.3 },
  6: { name: 'royal stomp', arc: 0.7, lunge: 0.15, lean: 0.2, spin: 0, approach: 0.6, slam: true, power: 1.2 },
};

function lerpAngle(a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

/** Sets every transform the clips control (root position/yaw, body hop/tilt/spin/squash). */
function pose(view, pos, yaw, o = {}) {
  view.root.position.copy(pos);
  view.root.rotation.set(0, yaw, 0);
  view.body.position.set(0, o.hop || 0, 0);
  // Lean toward a world direction: convert to the piece's local frame.
  const lean = o.lean || 0;
  let rx = 0, rz = 0;
  if (lean && o.dir) {
    const c = Math.cos(-yaw), s = Math.sin(-yaw);
    const lx = o.dir.x * c + o.dir.z * s, lz = -o.dir.x * s + o.dir.z * c;
    rx = lz * lean; rz = -lx * lean;
  }
  view.body.rotation.set(rx + (o.tiltX || 0), o.spin || 0, rz + (o.tiltZ || 0));
  const sy = o.sy || 1;
  const sx = 1 / Math.sqrt(sy);
  view.body.scale.set(sx, sy, sx);
}

const knightYaw = (dir) => Math.atan2(-dir.z, dir.x);

function moveDuration(dist, knight) {
  return knight ? 0.8 : Math.min(0.95, Math.max(0.42, 0.36 + dist * 0.075));
}

/** Plain move (no capture). Knights leap in an arc; others glide with a small hop. */
export function moveClip(stage, view, from, to, { audio, sound = true } = {}) {
  const A = squareToVec(from), B = squareToVec(to);
  const dist = A.distanceTo(B);
  const knight = view.type === 2;
  const dur = moveDuration(dist, knight);
  const arc = knight ? 1.05 + dist * 0.12 : 0.1 + dist * 0.02;
  const dir = new Vector3().subVectors(B, A).setY(0).normalize();
  const t0 = 0.12, t1 = dur - 0.14;
  const startYaw = view.defaultFacing(from);
  const baseYaw = view.defaultFacing(to);
  const flyYaw = knight ? knightYaw(dir) : baseYaw;
  let dust = null;
  const clip = new Clip({
    name: 'move', duration: dur + 0.25, blocking: dur,
    events: sound ? [{ at: 0.02, fn: () => audio?.whoosh(knight ? 0.5 : 0.25) }, { at: t1 + 0.05, fn: () => audio?.thud(knight ? 1 : 0.5) }] : [],
    begin: () => {
      dust = new Burst({ origin: B.clone().setY(0.05), seed: view.id * 31 + 7, count: (knight ? 26 : 10) * stage.tier.particles, speed: knight ? 2.2 : 1.2, up: 0.7, gravity: -3, life: 0.55, size: 0.16, color: '#e8d7c0' });
      stage.scene.add(dust.object);
    },
    dispose: () => dust?.dispose(),
    apply: (t) => {
      dust?.setTime(t - t1);
      if (t > dur) return; // released: the board state is final
      const u = seg(t, t0, t1);
      const e = knight ? smooth(u) : easeInOut(u);
      _p.lerpVectors(A, B, e);
      const hop = arc * 4 * u * (1 - u);
      let sy = 1;
      sy -= 0.14 * smooth(seg(t, 0, t0)) * (1 - seg(t, t0, t0 + 0.08)); // anticipation
      sy += (knight ? 0.18 : 0.08) * bump(u, 0, 0.6); // stretch in flight
      sy -= (knight ? 0.2 : 0.12) * bump(t, t1 - 0.02, dur); // landing squash
      const yaw = knight ? lerpAngle(lerpAngle(startYaw, flyYaw, smooth(seg(t, 0, 0.2))), baseYaw, smooth(seg(t, t1, dur))) : baseYaw;
      pose(view, _p, yaw, {
        hop, sy, dir,
        lean: knight ? 0 : 0.2 * bump(u, 0, 1) - 0.1 * bump(t, t1, dur),
        tiltZ: knight ? -0.35 * Math.sin(u * Math.PI) * (u < 0.5 ? 1 : -0.6) : 0,
      });
    },
  });
  return clip;
}

/** Castling: the king slides two squares, the rook hops over him. */
export function castleClip(stage, rec, inv, opts) {
  const king = moveClip(stage, inv.mover, rec.from, rec.to, opts);
  const A = squareToVec(rec.castle.rookFrom), B = squareToVec(rec.castle.rookTo);
  const rook = inv.rook;
  const dur = 0.72;
  const rookClip = new Clip({
    name: 'rook-hop', duration: dur, blocking: dur,
    apply: (t) => {
      const u = seg(t, 0.08, dur - 0.1);
      _p.lerpVectors(A, B, easeInOut(u));
      pose(rook, _p, rook.defaultFacing(), {
        hop: 1.15 * 4 * u * (1 - u),
        sy: 1 - 0.15 * bump(t, 0, 0.12) + 0.12 * bump(u, 0, 0.6) - 0.15 * bump(t, dur - 0.12, dur),
        spin: TAU * easeInOut(u),
      });
    },
  });
  return parallel([{ clip: king }, { clip: rookClip, start: 0.1 }], { name: 'castle' });
}

/** Pawn promotion: spin up in a burst of light and become the new piece. */
export function promoteClip(stage, pawn, promoted, square, { audio } = {}) {
  const P = squareToVec(square);
  const dur = 0.75;
  const swap = 0.32;
  let sparkle = null;
  const glow = TEAM_GLOW[pawn.color];
  return new Clip({
    name: 'promote', duration: dur + 0.4, blocking: dur,
    events: [{ at: swap, fn: () => audio?.chime() }],
    begin: () => {
      pawn.inClip++; promoted.inClip++;
      sparkle = new Burst({ origin: P.clone().setY(0.6), seed: promoted.id * 7, count: 40 * stage.tier.particles, speed: 2.4, up: 2.2, gravity: -2, life: 0.8, size: 0.13, color: '#ffe9a8', additive: true });
      stage.scene.add(sparkle.object);
    },
    dispose: () => { pawn.inClip--; promoted.inClip--; sparkle?.dispose(); },
    apply: (t) => {
      sparkle?.setTime(t - swap);
      if (t > dur) return;
      const before = t < swap;
      pawn.root.visible = before;
      promoted.root.visible = !before;
      if (before) {
        const u = seg(t, 0, swap);
        pose(pawn, P, pawn.defaultFacing(), { hop: 0.35 * smooth(u), spin: TAU * 1.5 * u * u, sy: 1 + 0.15 * u });
        pawn.setFlash(1.4 * u, glow);
      } else {
        const u = seg(t, swap, dur);
        const s = Math.max(0.01, easeOutBack(u, 2.2));
        pose(promoted, P, promoted.defaultFacing(), { hop: 0.35 * (1 - smooth(u)), spin: -TAU * 0.5 * (1 - easeOut(u)) });
        promoted.body.scale.set(s, s, s);
        promoted.setFlash(1.4 * (1 - u), glow);
      }
    },
  });
}

/**
 * A capture: anticipation → approach → strike → hit-stop + slow-mo → shatter → wind gust.
 * Shards come from the destruction worker; a gate holds the strike until they are ready.
 */
export function captureClip(stage, rec, inv, { audio, gameSeed = 0, reverse = false } = {}) {
  const attacker = inv.mover, victim = inv.captured;
  const P = ATTACK[attacker.type] || ATTACK[1];
  const A = squareToVec(rec.from), B = squareToVec(rec.to), C = squareToVec(rec.captured.square);
  const dir = new Vector3().subVectors(C, A).setY(0).normalize();
  const dist = A.distanceTo(C);
  const S = P.stomp ? C.clone() : C.clone().addScaledVector(dir, -0.62);
  const L = S.clone().addScaledVector(dir, P.lunge || 0);
  const Tant = 0.14;
  const Tapp = Tant + P.approach + Math.min(0.25, dist * 0.035);
  const Thit = Tapp + (P.stomp ? 0 : 0.11);
  const HS = 0.09, SLOW = 0.42, SLOW_E = 0.15;
  const Tset = Thit + SLOW_E + 0.42; // effect time when the attacker has settled on its square
  const map = remap([[0, 0], [Thit, Thit], [Thit + HS, Thit], [Thit + HS + SLOW, Thit + SLOW_E]]);
  const toClip = (e) => Thit + HS + SLOW + (e - Thit - SLOW_E);
  const life = stage.tier.debrisLife;
  const blocking = toClip(Tset);
  const duration = toClip(Thit + Math.max(life, 3.6));
  const startYaw = attacker.defaultFacing(rec.from);
  const baseYaw = attacker.defaultFacing(rec.to);
  const flyYaw = attacker.type === 2 ? knightYaw(dir) : baseYaw;
  const victimYaw = victim ? victim.defaultFacing() : 0;
  const victimH = PIECE_HEIGHT[rec.captured.type];
  const impactWorld = P.stomp ? C.clone().setY(victimH * 0.95) : C.clone().addScaledVector(dir, -PIECE_RADIUS[rec.captured.type] * 0.8).setY(victimH * 0.45);
  const gdir = gustDir(C.x, C.z);
  const tier = stage.tier;

  // ---- destruction request (fracture + physics bake in the worker) ----
  let shards = null, failed = false, shardResult = null;
  const statics = [];
  for (const v of stage.views.views) {
    if (!v.alive || v === attacker || v === victim || !v.root.visible) continue;
    statics.push({ x: v.root.position.x, z: v.root.position.z, h: v.height, r: 0.26 });
  }
  if (!P.stomp) statics.push({ x: L.x, z: L.z, h: attacker.height, r: 0.22 });
  const local = impactWorld.clone().sub(C);
  const cy = Math.cos(-victimYaw), sy = Math.sin(-victimYaw);
  const impactLocal = [local.x * cy + local.z * sy, local.y, -local.x * sy + local.z * cy];
  const payload = {
    pieceType: rec.captured.type, segments: Math.min(24, tier.segments), fragments: tier.fragments, seed: rec.seed,
    origin: [C.x, 0, C.z], yaw: victimYaw, impactLocal, impactDir: [dir.x, 0, dir.z], stomp: !!P.stomp,
    power: P.power, statics, duration: life + 0.1, gustDir: gdir, waitPhysicsMs: 400,
  };
  const key = `${gameSeed}:${rec.ply}:${tier.name}`;
  const prepared = stage.destruction.destroy(key, payload)
    .then((r) => { shardResult = r; stage.lastDestruction = { engine: r.engine, ms: r.ms, count: r.count }; })
    .catch((e) => { console.warn('destruction failed', e); failed = true; });

  let fx = [];
  let outerMat = null, innerMat = null;
  const makeShards = () => {
    if (shards || !shardResult) return;
    outerMat = createPieceMaterial(rec.captured.color);
    innerMat = createInnerMaterial(rec.captured.color);
    shards = new ShardSet(shardResult, outerMat, innerMat, { life });
    stage.scene.add(shards.group);
  };

  let releasedAttacker = false;
  const clip = new Clip({
    name: 'capture', duration, blocking,
    gates: [{ at: Thit, ready: () => !!shardResult || failed, timeoutMs: 1200 }],
    events: [
      { at: 0.02, fn: () => audio?.whoosh(0.6) },
      { at: Thit, fn: () => audio?.impact(P.power) },
      { at: Thit + HS + 0.05, fn: () => audio?.shatter(rec.captured.type) },
      { at: toClip(Thit + 0.5), fn: () => audio?.wind(1) },
      { at: blocking - 0.1, fn: () => audio?.thud(0.6) },
    ],
    begin: () => {
      if (victim) victim.inClip++;
      const n = tier.particles;
      const sparks = new Burst({ origin: impactWorld, seed: rec.seed, count: 46 * n, speed: 5.5, up: 3, gravity: -9, life: 0.65, size: 0.09, color: '#ffd38a', additive: true, drag: 2.2 });
      const dust = new Burst({ origin: C.clone().setY(0.1), seed: rec.seed + 1, count: 34 * n, speed: 2.8, up: 0.9, gravity: -1.5, life: 1.3, size: 0.32, color: '#d9c4b0', drag: 2.6 });
      const ring = new Shockwave(C, '#fff1c9', P.slam || P.stomp ? 3.2 : 2.2, 0.55);
      const streaks = new Streaks({ count: 46 * n, seed: rec.seed + 2, dir: gdir, start: 0.45, span: 2.2 });
      fx = [[sparks, 0], [dust, 0], [ring, 0], [streaks, 0]];
      for (const [f] of fx) stage.scene.add(f.object);
      makeShards();
    },
    dispose: () => {
      if (victim) { victim.inClip--; victim.setFlash(0); }
      for (const [f] of fx) f.dispose();
      shards?.dispose();
      outerMat?.dispose(); innerMat?.dispose();
    },
    apply: (t) => {
      const e = map(t);
      const te = e - Thit; // time since impact
      makeShards();
      // ---- attacker ----
      if (t <= blocking) {
        releasedAttacker = false;
        let pos, hop = 0, sy = 1, lean = 0, spin = 0, tiltZ = 0, yaw = attacker.type === 2 ? startYaw : baseYaw;
        if (e < Tapp) {
          const u = seg(e, Tant, Tapp);
          const k = P.stomp ? smooth(u) : easeInOut(u);
          pos = _p.lerpVectors(A, S, k);
          hop = P.arc * 4 * u * (1 - u);
          if ((P.slam) && u > 0.5) hop = P.arc * (1 - Math.pow((u - 0.5) * 2, 2.2));
          sy = 1 - 0.18 * smooth(seg(e, 0, Tant)) * (1 - seg(e, Tant, Tant + 0.08)) + 0.14 * bump(u, 0, 0.7);
          lean = P.lean * 0.6 * bump(u, 0, 1);
          spin = TAU * (P.spin || 0) * easeInOut(u);
          if (attacker.type === 2) yaw = lerpAngle(startYaw, flyYaw, smooth(seg(e, 0, Tant + 0.1)));
        } else if (e < Thit) {
          const u = seg(e, Tapp, Thit);
          pos = _p.lerpVectors(S, L, easeOut(u));
          sy = 1 + 0.16 * u;
          lean = P.lean * (0.6 + 0.6 * u);
          tiltZ = (P.slash || 0) * u;
          spin = TAU * (P.spin || 0);
          if (attacker.type === 2) yaw = flyYaw;
        } else {
          // recoil during slow-mo, then settle onto the target square
          const r = seg(e, Thit, Thit + SLOW_E);
          const u = seg(e, Thit + SLOW_E, Tset);
          const recoil = L.clone().addScaledVector(dir, -0.12 * Math.sin(r * Math.PI));
          pos = _p.lerpVectors(recoil, B, easeInOut(u));
          hop = (P.stomp ? 0.45 : 0.18) * Math.sin(u * Math.PI);
          sy = 1 - (P.slam || P.stomp ? 0.3 : 0.18) * (1 - r) * (1 - u) - 0.1 * bump(u, 0.75, 1);
          lean = P.lean * (1 - r) * (1 - u);
          tiltZ = (P.slash || 0) * (1 - easeOut(u));
          spin = TAU * (P.spin || 0);
          if (attacker.type === 2) yaw = lerpAngle(flyYaw, baseYaw, smooth(u));
        }
        pose(attacker, pos, yaw, { hop, sy, dir, lean, spin, tiltZ });
      } else if (!releasedAttacker) {
        releasedAttacker = true;
        pose(attacker, B, baseYaw, {});
      }
      // ---- victim ----
      if (victim) {
        const alive = e < Thit || (failed && te < 0.25);
        victim.root.visible = alive;
        if (alive) {
          const fl = bump(e, Thit - 0.3, Thit + 0.02);
          const shrink = failed && te > 0 ? 1 - te / 0.25 : 1;
          pose(victim, C, victimYaw, { dir, lean: 0.22 * fl, sy: (1 - 0.12 * fl) * shrink, hop: 0.06 * fl });
          if (shrink < 1) victim.body.scale.multiplyScalar(Math.max(0.01, shrink));
          victim.setFlash(1.3 * smooth(seg(e, Thit - 0.08, Thit)), WHITE);
        }
      }
      // ---- effects ----
      for (const [f] of fx) f.setTime(te);
      shards?.apply(te);
      clip.wind = gust(te);
      clip.shake = te >= 0 ? Math.max(0, 1 - te / 0.45) * (P.slam || P.stomp ? 1.2 : 0.85) : 0;
    },
  });
  clip.prepared = prepared;
  clip.ready = () => !!shardResult || failed;
  return clip;
}

/** Builds the clip for a move record, given the views involved (from ViewBoard.applyMove). */
export function buildMoveClip(stage, rec, inv, opts = {}) {
  let base;
  if (rec.castle) base = castleClip(stage, rec, inv, opts);
  else if (rec.captured && inv.captured) base = captureClip(stage, rec, inv, opts);
  else base = moveClip(stage, inv.mover, rec.from, rec.to, opts);
  if (rec.promotion && inv.promoted) {
    const morph = promoteClip(stage, inv.mover, inv.promoted, rec.to, opts);
    const c = parallel([{ clip: base }, { clip: morph, start: base.blocking }], { name: 'promotion', blocking: base.blocking + morph.blocking });
    c.prepared = base.prepared;
    c.ready = base.ready;
    // Before the morph starts, the promoted piece must stay hidden.
    const apply = c.applyFn;
    c.applyFn = (t) => { if (t < base.blocking) { inv.promoted.root.visible = false; } apply(t); };
    return c;
  }
  return base;
}

export { lerp, clamp01 };
