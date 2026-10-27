// Hooks for the film script (playtest/film.mjs), which records the game frame by frame on a clock of its own.
// Loaded only through `__test.film()` (dev builds, or ?test=1), so an ordinary visit never downloads it.
//
// - waiting(): the board is holding a strike until the destruction worker hands over its shards. The script lets real
//   time pass then, and not the film's, so a capture never plays without its shards however slow the machine.
// - scriptAi(ucis): the AI answers with these moves, then thinks for itself again (a famous game, replayed).
// - sounds: every sound the game asks for, with the film's time; renderAudio() makes them into a WAV with the same
//   Synth code, in an OfflineAudioContext, so the sound track lines up with the frames to the sample.
// - orbit(): slow camera moves for establishing shots, on top of the rig's own framing.
// - The resolution governor is off: on the film's clock every frame takes 16 ms, and the picture keeps one size.
import { Synth } from '../audio/synth.js';

const SOUNDS = ['whoosh', 'thud', 'impact', 'shatter', 'wind', 'chime', 'check', 'rewind', 'jingle', 'click'];

export function install({ stage, ctrl }) {
  if (window.__filmApp) return window.__filmApp;
  const audio = ctrl.audio;
  let sounds = [];
  for (const name of SOUNDS) {
    const play = audio[name].bind(audio);
    audio[name] = (...args) => {
      sounds.push({ t: performance.now(), name, args });
      return play(...args);
    };
  }

  // The camera: the rig frames the board as always, and an offset goes on top, eased from one value to the next.
  const rig = stage.rig;
  const off = { yaw: 0, pitch: 0, dist: 1 };
  let tween = null;
  const update = rig.update.bind(rig);
  rig.update = (dt, time) => {
    update(dt, time);
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / tween.ms);
      const e = k * k * (3 - 2 * k);
      for (const key of ['yaw', 'pitch', 'dist']) off[key] = tween.from[key] + (tween.to[key] - tween.from[key]) * e;
      if (k >= 1) tween = null;
    }
    if (off.yaw || off.pitch || off.dist !== 1) {
      rig.place(rig.camera, rig.yaw + off.yaw, rig.pitch + off.pitch, rig.distance * off.dist);
      rig.camera.updateMatrixWorld();
    }
  };

  let script = [];
  const choose = ctrl.ai.chooseMove.bind(ctrl.ai);
  ctrl.ai.chooseMove = (req) => (script.length ? Promise.resolve({ uci: script.shift(), book: true, score: 0 }) : choose(req));

  stage.governor.enabled = false;
  stage.governor.scale = 1;
  stage.applyPixelRatio();

  const api = {
    waiting() {
      for (const tr of stage.animator.tracks) {
        if (tr.reverse) continue;
        for (const g of tr.clip.gates) if (tr.t <= g.at && g.at - tr.t < 0.1 && !g.ready()) return true;
      }
      return false;
    },
    scriptAi(ucis) { script = ucis.slice(); },
    scriptLeft() { return script.length; },
    /** Eases the camera's offset to `to` ({ yaw, pitch } in radians, `dist` as a factor) over `ms`. */
    orbit(to, ms = 0) {
      const target = { yaw: 0, pitch: 0, dist: 1, ...to };
      if (ms <= 0) { Object.assign(off, target); tween = null; stage.requestRender(); return; }
      tween = { from: { ...off }, to: target, t0: performance.now(), ms };
    },
    sounds() { return sounds.slice(); },
    clearSounds() { sounds = []; },
    /**
     * The sounds of a recording, rendered into a mono 16-bit WAV of `seconds`, as base64. `spans` say which stretches
     * of the film's clock (performance.now() ms) are in the video and from which second: a sound plays at its place in
     * its span, and one asked for in a cut is left out. `scale` stretches a span's time as the film's frames do (16 ms
     * of the game's clock to a 1/60 s frame); `spans` may be one stretch, from 0, for a live recording.
     */
    async renderAudio({ spans, seconds, scale = 1, rate = 48000, volume = 0.8 }) {
      const ctx = new OfflineAudioContext(1, Math.ceil((seconds + 0.05) * rate), rate);
      const synth = new Synth({ ctx });
      synth.ensure();
      synth.setVolume(volume);
      for (const s of sounds) {
        const span = spans.find((x) => s.t >= x.from && s.t < x.to);
        if (!span) continue;
        synth.at = span.video + ((s.t - span.from) * scale) / 1000 + 0.005;
        if (synth.at < seconds) synth[s.name](...s.args);
      }
      const buf = await ctx.startRendering();
      return wav(buf.getChannelData(0), rate);
    },
  };
  window.__filmApp = api;
  return api;
}

/** Float samples to a 16-bit PCM WAV, as base64. */
function wav(samples, rate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(bytes);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  let bin = '';
  const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
