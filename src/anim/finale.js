// Checkmate finale: the mated king trembles, rises in a glow and bursts apart.
import { Vector3, Color } from 'three';
import { Clip, smooth, seg, easeIn } from './timeline.js';
import { Burst, Shockwave, Streaks } from '../render/fx/particles.js';
import { ShardSet } from '../destruction/manager.js';
import { gust, gustDir } from '../destruction/wind.js';
import { createPieceMaterial, createInnerMaterial, TEAM_GLOW } from '../render/materials.js';
import { PIECE_HEIGHT } from '../render/pieces/geometry.js';

export function finaleClip(stage, king, { audio, seed, key }) {
  const C = king.root.position.clone().setY(0);
  const yaw = king.defaultFacing();
  const lift = 0.45;
  const Thit = 1.05;
  const life = Math.max(3.5, stage.tier.debrisLife);
  const glow = TEAM_GLOW[king.color].clone().lerp(new Color('#ff5533'), 0.5);
  const gdir = gustDir(C.x, C.z);
  const statics = stage.views.views
    .filter((v) => v.alive && v !== king && v.root.visible)
    .map((v) => ({ x: v.root.position.x, z: v.root.position.z, h: v.height, r: 0.26 }));
  let result = null, failed = false, shards = null, outer = null, inner = null, fx = [];
  const prepared = stage.destruction.destroy(key, {
    pieceType: 6, segments: Math.min(24, stage.tier.segments), fragments: Math.round(stage.tier.fragments * 1.4), seed,
    origin: [C.x, lift, C.z], yaw, impactLocal: [0, PIECE_HEIGHT[6] * 0.5, 0], impactDir: [0, 0, 0], stomp: true,
    power: 1.6, statics, duration: life + 0.1, gustDir: gdir, waitPhysicsMs: 600,
  }).then((r) => { result = r; }).catch(() => { failed = true; });
  const make = () => {
    if (shards || !result) return;
    outer = createPieceMaterial(king.color);
    inner = createInnerMaterial(king.color);
    shards = new ShardSet(result, outer, inner, { life });
    stage.scene.add(shards.group);
  };
  const blocking = Thit + 1.1;
  const clip = new Clip({
    name: 'finale', duration: Thit + life, blocking,
    gates: [{ at: Thit, ready: () => !!result || failed, timeoutMs: 1500 }],
    events: [{ at: Thit, fn: () => { audio?.impact(1.5); audio?.shatter(6); } }, { at: Thit + 0.6, fn: () => audio?.wind(1.2) }],
    begin: () => {
      king.inClip++;
      const n = stage.tier.particles;
      const at = C.clone().setY(lift + 0.6);
      fx = [
        new Burst({ origin: at, seed, count: 80 * n, speed: 6.5, up: 3.5, gravity: -7, life: 0.9, size: 0.1, color: '#ffcf7a', additive: true, drag: 2 }),
        new Burst({ origin: C.clone().setY(0.1), seed: seed + 1, count: 40 * n, speed: 3.2, up: 1, gravity: -1.5, life: 1.5, size: 0.35, color: '#d9c4b0', drag: 2.4 }),
        new Shockwave(C, '#ffe0a0', 4.2, 0.7),
        new Streaks({ count: 60 * n, seed: seed + 2, dir: gdir, start: 0.45, span: 2.4 }),
      ];
      for (const f of fx) stage.scene.add(f.object);
      make();
    },
    dispose: () => {
      king.inClip--; king.setFlash(0);
      for (const f of fx) f.dispose();
      shards?.dispose(); outer?.dispose(); inner?.dispose();
    },
    apply: (t) => {
      make();
      const te = t - Thit;
      const alive = te < 0 || (failed && te < 0.3);
      king.root.visible = alive;
      if (alive) {
        const r = smooth(seg(t, 0.35, Thit));
        king.root.position.copy(C);
        king.root.rotation.set(0, yaw, 0);
        king.body.position.set(Math.sin(t * 47) * 0.03 * seg(t, 0, 0.4), lift * r, 0);
        king.body.rotation.set(Math.sin(t * 31) * 0.05, r * 2.5, Math.sin(t * 37) * 0.05);
        const s = 1 + 0.12 * easeIn(seg(t, 0.6, Thit));
        king.body.scale.set(s, s, s);
        king.setFlash(1.6 * smooth(seg(t, 0.2, Thit)), glow);
      }
      for (const f of fx) f.setTime(te);
      shards?.apply(te);
      clip.wind = gust(te);
      clip.shake = te >= 0 ? Math.max(0, 1 - te / 0.6) * 1.4 : 0.15 * seg(t, 0.3, Thit);
    },
  });
  clip.prepared = prepared;
  clip.ready = () => !!result || failed;
  clip.king = king;
  clip.seed = seed;
  clip.key = key;
  return clip;
}

export { Vector3 };
