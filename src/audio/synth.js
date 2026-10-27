// Procedural sound effects (no audio files to download). Created lazily after the first
// user gesture, as browsers require.
//
// The same sounds can be made into an OfflineAudioContext, each at a time of its own (`at`): the film script
// (src/debug/film.js) renders a recording's sound track this way, from the sounds the game asked for.
export class Synth {
  /** @param {{ ctx?: BaseAudioContext }} [o] a context to play into (an offline one), instead of the speakers. */
  constructor({ ctx = null } = {}) {
    this.ctx = null;
    this.given = ctx;
    this.master = null;
    this.volume = 0.7;
    this.muted = false;
    /** When the next sound starts, in the context's seconds; null: now. */
    this.at = null;
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && !this.given) this.ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!this.given && !AC) return false;
    this.ctx = this.given || new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = this.muted ? 0 : v; }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : this.volume; }

  get ok() { return this.ctx && !this.muted && (!!this.given || this.ctx.state === 'running'); }

  /** The time a sound starts at. */
  now() { return this.at ?? this.ctx.currentTime; }

  env(node, t, a, peak, d) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    node.connect(g).connect(this.master);
    return g;
  }

  noiseSrc(t, dur, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = rate;
    s.start(t, Math.random(), dur + 0.05);
    return s;
  }

  whoosh(strength = 0.5) {
    if (!this.ok) return;
    const t = this.now();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(1400, t + 0.25);
    this.noiseSrc(t, 0.35).connect(f);
    this.env(f, t, 0.08, 0.25 * strength, 0.25);
  }

  thud(strength = 0.6) {
    if (!this.ok) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    o.start(t); o.stop(t + 0.25);
    this.env(o, t, 0.005, 0.5 * strength, 0.18);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    this.noiseSrc(t, 0.06).connect(f);
    this.env(f, t, 0.002, 0.2 * strength, 0.05);
  }

  impact(power = 1) {
    if (!this.ok) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.5);
    o.start(t); o.stop(t + 0.7);
    this.env(o, t, 0.004, 0.9 * Math.min(1.3, power), 0.55);
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 1800;
    this.noiseSrc(t, 0.12).connect(f);
    this.env(f, t, 0.002, 0.6, 0.1);
  }

  shatter(type = 1) {
    if (!this.ok) return;
    const t0 = this.now();
    const n = 9 + type * 2;
    for (let i = 0; i < n; i++) {
      const t = t0 + Math.random() * 0.45 * Math.random();
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 6 + Math.random() * 8;
      f.frequency.value = 900 + Math.random() * 4200;
      this.noiseSrc(t, 0.08).connect(f);
      this.env(f, t, 0.002, 0.25 + Math.random() * 0.2, 0.05 + Math.random() * 0.1);
    }
    // a little resonant "tink"
    for (let i = 0; i < 3; i++) {
      const t = t0 + 0.05 + Math.random() * 0.3;
      const o = this.ctx.createOscillator();
      o.frequency.value = 2400 + Math.random() * 2400;
      o.start(t); o.stop(t + 0.3);
      this.env(o, t, 0.002, 0.05, 0.25);
    }
  }

  wind(strength = 1) {
    if (!this.ok) return;
    const t = this.now();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(300, t);
    f.frequency.linearRampToValueAtTime(1300, t + 0.9);
    f.frequency.linearRampToValueAtTime(350, t + 2.6);
    this.noiseSrc(t, 2.8, 0.7).connect(f);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 * strength, t + 0.6);
    g.gain.linearRampToValueAtTime(0.25 * strength, t + 1.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.7);
    f.connect(g).connect(this.master);
  }

  chime() {
    if (!this.ok) return;
    const t = this.now();
    [523.25, 659.25, 783.99, 1046.5].forEach((fr, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = fr;
      o.start(t + i * 0.06); o.stop(t + 1.2);
      this.env(o, t + i * 0.06, 0.01, 0.14, 0.9);
    });
  }

  check() {
    if (!this.ok) return;
    const t = this.now();
    [880, 660].forEach((fr, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'square'; o.frequency.value = fr;
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2000;
      o.connect(f);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.12);
      this.env(f, t + i * 0.12, 0.005, 0.08, 0.1);
    });
  }

  /** Reverse-time swell: noise that grows and snaps off, with a falling tone. */
  rewind(duration = 2) {
    if (!this.ok) return;
    const t = this.now();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(2400, t);
    f.frequency.exponentialRampToValueAtTime(300, t + duration);
    this.noiseSrc(t, duration).connect(f);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.02, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + duration * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    f.connect(g).connect(this.master);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(70, t + duration);
    const lf = this.ctx.createBiquadFilter(); lf.type = 'lowpass'; lf.frequency.value = 700;
    o.connect(lf);
    o.start(t); o.stop(t + duration);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.07, t + duration * 0.8);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    lf.connect(g2).connect(this.master);
  }

  jingle(win) {
    if (!this.ok) return;
    const t = this.now();
    const notes = win ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [440, 392, 349.2, 293.7];
    notes.forEach((fr, i) => {
      const o = this.ctx.createOscillator();
      o.type = win ? 'triangle' : 'sine'; o.frequency.value = fr;
      o.start(t + i * 0.13); o.stop(t + i * 0.13 + 0.6);
      this.env(o, t + i * 0.13, 0.01, 0.16, 0.5);
    });
  }

  click() {
    if (!this.ok) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    o.frequency.value = 1200;
    o.start(t); o.stop(t + 0.04);
    this.env(o, t, 0.002, 0.06, 0.03);
  }
}
