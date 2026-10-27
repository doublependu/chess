// What every reel needs: the shape of each cut, and a page of the game ready to film in it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepare, Recorder } from './clock.mjs';
import { Human } from '../human.mjs';
import { MOBILE } from '../lib.mjs';
import { mulberry32 } from '../../src/ai/strength.js';

const OVERLAY = readFileSync(fileURLToPath(new URL('./overlay.js', import.meta.url)), 'utf8');

/**
 * Each cut is recorded at its own shape, so it shows the layout the game really uses there (a Short is the phone's
 * portrait layout, by touch). `size` is the captions' font size in CSS px; `safe` the margins (% of the screen)
 * captions keep clear of.
 */
export const PRESETS = {
  youtube: { name: 'youtube', viewport: { width: 1280, height: 720 }, scale: 1.5, size: 30, safe: { top: 6, bottom: 8, left: 4, right: 4 } },
  short: {
    name: 'short', viewport: { width: 432, height: 768 }, scale: 2.5, touch: true, size: 21,
    // The Shorts player puts its buttons down the right and the title along the bottom.
    safe: { top: 11, bottom: 24, left: 5, right: 15 },
  },
  x: { name: 'x', viewport: { width: 720, height: 720 }, scale: 1.5, size: 30, safe: { top: 6, bottom: 8, left: 5, right: 5 } },
  /** One phone of three side by side (the `devices` reel): 640×1080 each. */
  pane: { name: 'pane', viewport: { width: 360, height: 608 }, scale: 16 / 9, touch: true, size: 19, safe: { top: 4, bottom: 6, left: 4, right: 4 } },
};

export const SETTINGS = {
  graphics: 'high', difficulty: 4, animSpeed: 1, sound: false, volume: 0.7, reducedMotion: false, showMoves: true,
  showSanInput: false, idleMotion: 'full',
};

/** A snapshot to continue from (the game's autosave format): a position, and moves played from it. */
export function save({ moves = [], startFen, humanColor = 0, seed = 77, label = 'Film' }) {
  return { schema: 1, savedAt: Date.now(), label, humanColor, seed, startFen, moves, director: null, turn: moves.length % 2, over: false };
}

/**
 * A page of the game, loaded and ready: on the film's clock (stopped; it moves as frames are recorded), or `live`
 * on real time. Returns { ctx, page, rec, human, close }.
 */
export async function openFilm(browser, url, preset, { quality = 'high', settings = {}, autosave = null, slots = null, live = false, seed = 7, errors = [] } = {}) {
  const dev = preset.touch ? MOBILE.pixel5 : {};
  const ctx = await browser.newContext({
    viewport: preset.viewport, deviceScaleFactor: preset.scale,
    ...(preset.touch ? { isMobile: true, hasTouch: true, userAgent: dev.userAgent } : {}),
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e) }));
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text() }); });
  if (live) await page.addInitScript({ content: OVERLAY });
  else await prepare(page);
  await page.addInitScript(([s, a, sl]) => {
    localStorage.setItem('skychess.settings.v1', JSON.stringify(s));
    if (a) localStorage.setItem('skychess.autosave.v1', JSON.stringify(a)); else localStorage.removeItem('skychess.autosave.v1');
    if (sl) localStorage.setItem('skychess.slots.v1', JSON.stringify(sl));
  }, [{ ...SETTINGS, ...settings }, autosave, slots]);
  const u = new URL(url);
  u.searchParams.set('test', '1');
  if (quality) u.searchParams.set('quality', quality);
  await page.goto(u.toString());
  await page.waitForFunction(() => window.__test && document.querySelector('.overlay[data-name="title"]'), null, { timeout: 30000 });
  // The physics engine, the shaders' warm-up and the intro fly-in, in real time, before the film starts.
  await page.waitForTimeout(2600);
  const rec = await new Recorder(page).attach();
  await page.evaluate((cfg) => window.__film.config(cfg), { size: preset.size, safe: preset.safe });
  if (!live) await rec.freeze();
  const rng = mulberry32(seed);
  const human = new Human(page, { wait: live ? (ms) => page.waitForTimeout(ms) : (ms) => rec.hold(ms), touch: !!preset.touch, rng, style: 'cinematic' });
  return { ctx, page, rec, human, rng, close: () => ctx.close() };
}

/** Until the side to move is the human's and nothing animates (the AI answered, and its move played out). */
export const humanReady = () => { const s = window.__test.state(); return (s.phase === 'human' && !s.busy) || s.over; };
/** Until the game is over and its finale has played (the game-over box is up). */
export const overShown = () => window.__test.state().overlay === 'over';
