import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { Animator, Clip, parallel, remap } from '../src/anim/timeline.js';
import { CameraRig } from '../src/render/camera.js';

function recorder() {
  const log = [];
  const clip = new Clip({ duration: 1, blocking: 0.6, apply: (t) => log.push(+t.toFixed(4)) });
  return { clip, log };
}

describe('timeline', () => {
  it('plays forward and resolves blocking before done', async () => {
    const a = new Animator();
    const { clip, log } = recorder();
    const order = [];
    const h = a.play(clip);
    h.blocking.then(() => order.push('blocking'));
    h.done.then(() => order.push('done'));
    for (let i = 0; i < 30; i++) a.update(1 / 20);
    await h.done;
    expect(order).toEqual(['blocking', 'done']);
    expect(log[0]).toBe(0);
    expect(log.at(-1)).toBe(1);
    expect(a.active).toBe(false);
  });

  it('reverse playback ends at t = 0 (the pre-move state)', async () => {
    const a = new Animator();
    const { clip, log } = recorder();
    const h = a.play(clip, { reverse: true, speedFn: (t, c) => (t > c.blocking ? 3 : 1) });
    for (let i = 0; i < 40; i++) a.update(1 / 30);
    await h.done;
    expect(log[0]).toBe(1);
    expect(log.at(-1)).toBe(0);
    for (let i = 1; i < log.length; i++) expect(log[i]).toBeLessThanOrEqual(log[i - 1]);
  });

  it('a pure clip lands in the same state forwards and backwards', () => {
    const state = { x: 0 };
    const clip = new Clip({ duration: 2, apply: (t) => { state.x = Math.sin(t) * 3 + t * t; } });
    const a = new Animator();
    a.play(clip);
    for (let i = 0; i < 100; i++) a.update(0.05);
    const end = state.x;
    a.play(clip, { reverse: true });
    for (let i = 0; i < 100; i++) a.update(0.05);
    expect(state.x).toBeCloseTo(0, 10);
    clip.apply(2);
    expect(state.x).toBeCloseTo(end, 10);
  });

  it('gates hold playback until ready (with timeout)', () => {
    let ready = false;
    let last = 0;
    const clip = new Clip({ duration: 1, apply: (t) => { last = t; }, gates: [{ at: 0.5, ready: () => ready, timeoutMs: 10_000 }] });
    const a = new Animator();
    a.play(clip);
    for (let i = 0; i < 20; i++) a.update(0.05);
    expect(last).toBeCloseTo(0.5, 5);
    ready = true;
    for (let i = 0; i < 20; i++) a.update(0.05);
    expect(a.active).toBe(false);
  });

  it('fires events only when playing forward', () => {
    let fired = 0;
    const clip = new Clip({ duration: 1, apply: () => {}, events: [{ at: 0.3, fn: () => fired++ }] });
    const a = new Animator();
    a.play(clip);
    for (let i = 0; i < 25; i++) a.update(0.05);
    a.play(clip, { reverse: true });
    for (let i = 0; i < 25; i++) a.update(0.05);
    expect(fired).toBe(1);
  });

  it('parallel parts do not touch state before they start', () => {
    const seen = [];
    const p1 = new Clip({ duration: 1, apply: (t) => seen.push(['a', t]) });
    const p2 = new Clip({ duration: 1, apply: (t) => seen.push(['b', t]) });
    const c = parallel([{ clip: p1 }, { clip: p2, start: 0.5 }]);
    expect(c.duration).toBe(1.5);
    c.apply(0.25);
    expect(seen.map((s) => s[0])).toEqual(['a']);
  });

  it('remap implements hit-stop and slow motion', () => {
    const m = remap([[0, 0], [1, 1], [1.1, 1], [1.5, 1.15]]);
    expect(m(0.5)).toBeCloseTo(0.5);
    expect(m(1.05)).toBeCloseTo(1);
    expect(m(1.3)).toBeCloseTo(1.075);
    expect(m(2.5)).toBeCloseTo(2.15);
  });
});

describe('camera fit', () => {
  const corners = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) corners.push(new Vector3(sx * 4.6, 0, sz * 4.6));
  for (const [w, h] of [[390, 844], [844, 390], [1280, 800], [2560, 1080], [820, 1180], [600, 1400], [1400, 600]]) {
    it(`keeps the whole board visible at ${w}x${h}`, () => {
      const rig = new CameraRig();
      rig.setSize(w, h, { top: 60, bottom: 70, left: 8, right: 8 });
      rig.intro = 0;
      for (let i = 0; i < 400; i++) rig.update(1 / 60, i / 60);
      rig.camera.updateProjectionMatrix();
      for (const c of corners) {
        const p = c.clone().project(rig.camera);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
      }
    });
  }
});
