// The wind gust that follows each destruction. Shared by the physics bake (forces) and the
// renderer (grass, banners, streaks), so everything moves in sync — forwards and backwards.

export const GUST = { start: 0.5, rise: 0.35, hold: 1.25, fall: 1.2, speed: 17 };
export const PREVAILING = [1, 0, -0.35];

const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Gust strength 0..1 at time t (seconds after impact). */
export function gust(t) {
  const { start, rise, hold, fall } = GUST;
  return sstep(start, start + rise, t) * (1 - sstep(start + rise + hold, start + rise + hold + fall, t));
}

/** Gust direction for a destruction at (x, z): prevailing wind bent outwards from the board centre. */
export function gustDir(x, z) {
  const len = Math.hypot(x, z) || 1;
  let dx = PREVAILING[0] + (x / len) * 0.5, dz = PREVAILING[2] + (z / len) * 0.5;
  const l = Math.hypot(dx, dz);
  dx /= l; dz /= l;
  return [dx, 0, dz];
}
