// Simulates the shards of a destroyed piece ahead of time and records keyframes.
// Main thread only plays the recording, so playback is smooth everywhere and reversible.
import { gust, GUST } from './wind.js';

export const BAKE_FPS = 30;
const STEP = 1 / 60;
const GRAVITY = 15;
const RAPIER_SECONDS = 2.8;

function mulberry32(a) {
  a >>>= 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Initial world-space state for every fragment (shared by both simulators). */
function initialState(p) {
  const rnd = mulberry32(p.seed ^ 0x51ed);
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  const qy = [0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2)];
  const rotY = ([x, y, z]) => [x * cy + z * sy, y, -x * sy + z * cy];
  const imp = rotY(p.impactLocal);
  const impW = [p.origin[0] + imp[0], p.origin[1] + imp[1], p.origin[2] + imp[2]];
  return p.fragments.map((f) => {
    const c = rotY(f.center);
    const pos = [p.origin[0] + c[0], p.origin[1] + c[1], p.origin[2] + c[2]];
    let rx = pos[0] - impW[0], ry = pos[1] - impW[1], rz = pos[2] - impW[2];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const k = p.power ?? 1;
    let vel;
    if (p.stomp) {
      const hl = Math.hypot(rx, rz) || 1;
      vel = [(rx / hl) * (3 + rnd() * 2.2) * k, (2.2 + rnd() * 2.5) * k, (rz / hl) * (3 + rnd() * 2.2) * k];
    } else {
      vel = [
        (p.impactDir[0] * (3.2 + rnd() * 1.8) + rx * (2 + rnd() * 1.6)) * k,
        (2.0 + ry * 1.5 + rnd() * 2.6) * k,
        (p.impactDir[2] * (3.2 + rnd() * 1.8) + rz * (2 + rnd() * 1.6)) * k,
      ];
    }
    const ang = [(rnd() - 0.5) * 16, (rnd() - 0.5) * 12, (rnd() - 0.5) * 16];
    return { pos, vel, ang, quat: qy.slice(), size: f.size, rnd: rnd() };
  });
}

function windAccel(t, s, vel, dir) {
  const g = gust(t);
  if (g <= 0) return [0, 0, 0];
  const speed = GUST.speed * g;
  const c = 2.4 / Math.sqrt(Math.max(0.05, s.size));
  const turb = Math.sin(t * 9 + s.rnd * 40) * 0.35;
  const wx = dir[0] * speed + dir[2] * speed * turb;
  const wz = dir[2] * speed - dir[0] * speed * turb;
  return [
    (wx - vel[0]) * c,
    (speed * 0.75 - vel[1]) * c * 0.45,
    (wz - vel[2]) * c,
  ];
}

function writeFrame(out, frame, n, states, getPose) {
  let o = frame * n * 7;
  for (let i = 0; i < n; i++) {
    const [p, q] = getPose(i, states[i]);
    out[o++] = p[0]; out[o++] = p[1]; out[o++] = p[2];
    out[o++] = q[0]; out[o++] = q[1]; out[o++] = q[2]; out[o++] = q[3];
  }
}

/** Physics with Rapier: convex hull colliders, CCD, board/platform/island/pieces as static colliders. */
export function bakeRapier(R, p) {
  const n = p.fragments.length;
  const frames = Math.ceil(p.duration * BAKE_FPS) + 1;
  const out = new Float32Array(frames * n * 7);
  const world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = STEP;
  try {
    // Static scene
    world.createCollider(R.ColliderDesc.cuboid(4.62, 0.25, 4.62).setTranslation(0, -0.25, 0).setFriction(0.9).setRestitution(0.25));
    world.createCollider(R.ColliderDesc.cylinder(0.2, 7.1).setTranslation(0, -0.34, 0).setFriction(0.9));
    world.createCollider(R.ColliderDesc.cylinder(0.5, 10.6).setTranslation(0, -1.05, 0).setFriction(0.9));
    for (const s of p.statics) {
      world.createCollider(R.ColliderDesc.cylinder(s.h / 2, s.r).setTranslation(s.x, s.h / 2, s.z).setFriction(0.6).setRestitution(0.2));
    }
    const states = initialState(p);
    const bodies = states.map((s, i) => {
      const desc = R.RigidBodyDesc.dynamic()
        .setTranslation(s.pos[0], s.pos[1], s.pos[2])
        .setRotation({ x: s.quat[0], y: s.quat[1], z: s.quat[2], w: s.quat[3] })
        .setLinvel(s.vel[0], s.vel[1], s.vel[2])
        .setAngvel({ x: s.ang[0], y: s.ang[1], z: s.ang[2] })
        .setCcdEnabled(true)
        .setLinearDamping(0.05)
        .setAngularDamping(0.25)
        .setCanSleep(false);
      const body = world.createRigidBody(desc);
      let cd = R.ColliderDesc.convexHull(p.fragments[i].points);
      if (!cd) cd = R.ColliderDesc.ball(Math.max(0.02, s.size * 0.5));
      cd.setDensity(1).setFriction(0.7).setRestitution(0.3);
      world.createCollider(cd, body);
      return body;
    });
    const pose = (i) => {
      const t = bodies[i].translation(), q = bodies[i].rotation();
      return [[t.x, t.y, t.z], [q.x, q.y, q.z, q.w]];
    };
    writeFrame(out, 0, n, states, pose);
    const steps = (frames - 1) * 2;
    // Contacts matter while shards bounce on the board; once the gust has lifted them the cheap
    // analytic integrator takes over from Rapier's state (keeps bakes fast on low-end phones).
    const rapierSteps = Math.min(steps, Math.round(RAPIER_SECONDS / STEP) & ~1);
    for (let k = 1; k <= rapierSteps; k++) {
      const t = k * STEP;
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        b.resetForces(false);
        const v = b.linvel();
        const a = windAccel(t, states[i], [v.x, v.y, v.z], p.gustDir);
        if (a[0] || a[1] || a[2]) {
          const m = b.mass();
          b.addForce({ x: a[0] * m, y: a[1] * m, z: a[2] * m }, true);
        }
      }
      world.step();
      if (k % 2 === 0) writeFrame(out, k / 2, n, states, pose);
    }
    if (rapierSteps < steps) {
      bodies.forEach((b, i) => {
        const t = b.translation(), q = b.rotation(), v = b.linvel(), w = b.angvel();
        const st = states[i];
        st.pos = [t.x, t.y, t.z]; st.quat = [q.x, q.y, q.z, q.w]; st.vel = [v.x, v.y, v.z]; st.ang = [w.x, w.y, w.z];
      });
      stepFallback(states, p, out, n, rapierSteps, steps);
    }
  } finally {
    world.free();
  }
  return { bake: out, frames, fps: BAKE_FPS, count: n };
}

const floorAt = (x, z) => {
  if (Math.abs(x) < 4.62 && Math.abs(z) < 4.62) return 0;
  const r = Math.hypot(x, z);
  if (r < 7.1) return -0.14;
  if (r < 10.6) return -0.55;
  return -Infinity;
};

/** Steps the analytic simulator from step k0 to k1, recording every other step into `out`. */
function stepFallback(states, p, out, n, k0, k1) {
  const pose = (_, s) => [s.pos, s.quat];
  for (let k = k0 + 1; k <= k1; k++) {
    const t = k * STEP;
    for (const s of states) {
      const a = windAccel(t, s, s.vel, p.gustDir);
      s.vel[0] += a[0] * STEP;
      s.vel[1] += (a[1] - GRAVITY) * STEP;
      s.vel[2] += a[2] * STEP;
      s.pos[0] += s.vel[0] * STEP; s.pos[1] += s.vel[1] * STEP; s.pos[2] += s.vel[2] * STEP;
      const floor = floorAt(s.pos[0], s.pos[2]) + s.size * 0.35;
      if (s.pos[1] < floor && s.pos[1] > floor - 0.6) {
        s.pos[1] = floor;
        if (s.vel[1] < 0) s.vel[1] = -s.vel[1] * 0.3;
        s.vel[0] *= 0.82; s.vel[2] *= 0.82;
        s.ang[0] *= 0.8; s.ang[1] *= 0.8; s.ang[2] *= 0.8;
      }
      // Integrate orientation: q += 0.5 * (0, w) * q * dt
      const [qx, qy, qz, qw] = s.quat, [wx, wy, wz] = s.ang;
      const h = 0.5 * STEP;
      const nx = qx + h * (wx * qw + wy * qz - wz * qy);
      const ny = qy + h * (wy * qw + wz * qx - wx * qz);
      const nz = qz + h * (wz * qw + wx * qy - wy * qx);
      const nw = qw + h * (-wx * qx - wy * qy - wz * qz);
      const l = Math.hypot(nx, ny, nz, nw) || 1;
      s.quat = [nx / l, ny / l, nz / l, nw / l];
    }
    if (k % 2 === 0) writeFrame(out, k / 2, n, states, pose);
  }
}

/** Lightweight analytic simulation used until (or if) Rapier is unavailable. */
export function bakeFallback(p) {
  const n = p.fragments.length;
  const frames = Math.ceil(p.duration * BAKE_FPS) + 1;
  const out = new Float32Array(frames * n * 7);
  const states = initialState(p);
  writeFrame(out, 0, n, states, (_, s) => [s.pos, s.quat]);
  stepFallback(states, p, out, n, 0, (frames - 1) * 2);
  return { bake: out, frames, fps: BAKE_FPS, count: n };
}
