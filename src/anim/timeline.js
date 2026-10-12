// Reversible animation playback. A clip is a pure function of time: apply(t) fully sets the state
// of everything it owns for clip time t, so playing it backwards is just apply(duration - s).

export class Clip {
  /**
   * @param {object} o
   * @param {number} o.duration total length (s)
   * @param {number} [o.blocking] time at which the board state is final (input may resume)
   * @param {(t:number)=>void} o.apply
   * @param {(reverse:boolean)=>void} [o.begin] create resources
   * @param {()=>void} [o.dispose] free resources
   * @param {{at:number, ready:()=>boolean, timeoutMs?:number}[]} [o.gates] hold playback at `at` until ready()
   */
  constructor({ duration, blocking = duration, apply, begin, dispose, gates = [], events = [], name = 'clip' }) {
    this.duration = duration;
    this.blocking = Math.min(blocking, duration);
    this.applyFn = apply;
    this.beginFn = begin;
    this.disposeFn = dispose;
    this.gates = gates;
    this.events = events; // [{at, fn}] fired when forward playback crosses `at` (sounds etc.)
    this.name = name;
    this.wind = 0;
    this.shake = 0;
  }
  apply(t) { this.applyFn(Math.max(0, Math.min(this.duration, t))); }
  begin(reverse) { this.beginFn?.(reverse); }
  dispose() { this.disposeFn?.(); }
}

/** Runs several clips together; total duration is the max of the parts (offset by their start). */
export function parallel(parts, { name = 'parallel', blocking } = {}) {
  const duration = Math.max(0, ...parts.map((p) => (p.start || 0) + p.clip.duration));
  const block = blocking ?? Math.max(0, ...parts.map((p) => (p.start || 0) + p.clip.blocking));
  const gates = parts.flatMap((p) => p.clip.gates.map((g) => ({ ...g, at: g.at + (p.start || 0) })));
  const events = parts.flatMap((p) => p.clip.events.map((ev) => ({ ...ev, at: ev.at + (p.start || 0) })));
  const c = new Clip({
    name, duration, blocking: block, gates, events,
    begin: (rev) => parts.forEach((p) => p.clip.begin(rev)),
    dispose: () => parts.forEach((p) => p.clip.dispose()),
    apply: (t) => {
      let wind = 0, shake = 0;
      for (const p of parts) {
        const lt = t - (p.start || 0);
        if (lt < 0) continue; // not started yet: the earlier parts own the state
        p.clip.apply(lt);
        wind = Math.max(wind, p.clip.wind);
        shake = Math.max(shake, p.clip.shake);
      }
      c.wind = wind; c.shake = shake;
    },
  });
  return c;
}

export class Animator {
  constructor() {
    this.tracks = [];
    this.timeScale = 1;
  }

  get busy() { return this.tracks.some((tr) => !tr.unblocked); }
  get active() { return this.tracks.length > 0; }

  /** Starts a clip. Returns { blocking, done } promises. */
  play(clip, { speed = 1, reverse = false, speedFn = null } = {}) {
    let resolveBlock, resolveDone;
    const blocking = new Promise((r) => (resolveBlock = r));
    const done = new Promise((r) => (resolveDone = r));
    const tr = {
      clip, speed, speedFn, reverse, t: reverse ? clip.duration : 0, unblocked: false, gateWait: 0,
      resolveBlock, resolveDone,
    };
    clip.begin(reverse);
    clip.apply(tr.t);
    this.tracks.push(tr);
    if (clip.duration <= 0) this.finishTrack(tr);
    return { blocking, done, track: tr };
  }

  finishTrack(tr) {
    tr.t = tr.reverse ? 0 : tr.clip.duration;
    tr.clip.apply(tr.t);
    if (!tr.unblocked) { tr.unblocked = true; tr.resolveBlock(); }
    tr.clip.dispose();
    tr.resolveDone();
    const i = this.tracks.indexOf(tr);
    if (i >= 0) this.tracks.splice(i, 1);
  }

  /** Skips every running clip to its end state. */
  finishAll() {
    for (const tr of this.tracks.slice()) this.finishTrack(tr);
  }

  update(dt) {
    let wind = 0, shake = 0;
    for (const tr of this.tracks.slice()) {
      const c = tr.clip;
      const step = dt * tr.speed * this.timeScale * (tr.speedFn ? tr.speedFn(tr.t, c) : 1);
      let next = tr.reverse ? tr.t - step : tr.t + step;
      // Gates hold forward playback (e.g. waiting for fracture results at the moment of impact).
      if (!tr.reverse) {
        for (const g of c.gates) {
          if (tr.t <= g.at && next > g.at && !g.ready()) {
            tr.gateWait += dt * 1000;
            if (tr.gateWait < (g.timeoutMs ?? 900)) next = g.at;
          }
        }
      }
      if (!tr.reverse) for (const ev of c.events) if (tr.t < ev.at && next >= ev.at) ev.fn?.();
      tr.t = next;
      const end = tr.reverse ? tr.t <= 0 : tr.t >= c.duration;
      if (!tr.reverse && !tr.unblocked && tr.t >= c.blocking) {
        c.apply(Math.min(tr.t, c.duration));
        tr.unblocked = true;
        tr.resolveBlock();
      }
      if (end) { this.finishTrack(tr); continue; }
      c.apply(tr.t);
      wind = Math.max(wind, c.wind);
      shake = Math.max(shake, c.shake);
    }
    this.wind = wind;
    this.shake = shake;
  }
}

// ---------- easing helpers ----------
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const easeInOut = (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export const easeOutBack = (t, s = 1.4) => { t = clamp01(t) - 1; return 1 + (s + 1) * t * t * t + s * t * t; };
export const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeIn = (t) => Math.pow(clamp01(t), 3);
export const seg = (t, a, b) => clamp01((t - a) / (b - a));
/** 0 → 1 → 0 bump over [a, b]. */
export const bump = (t, a, b) => { const x = seg(t, a, b); return Math.sin(x * Math.PI); };

/** Piecewise-linear time remap: knots [[t0,e0],[t1,e1],...] (hit-stop / slow motion). */
export function remap(knots) {
  return (t) => {
    if (t <= knots[0][0]) return knots[0][1] + (t - knots[0][0]);
    for (let i = 1; i < knots.length; i++) {
      const [t1, e1] = knots[i], [t0, e0] = knots[i - 1];
      if (t <= t1) return e0 + ((t - t0) / (t1 - t0)) * (e1 - e0);
    }
    const [tl, el] = knots[knots.length - 1];
    return el + (t - tl);
  };
}
