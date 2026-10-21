// Shared helpers for browser-driven playtests and perf scripts.
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

export function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

export function outDir(kind) {
  const dir = `playtest-output/${kind}-${stamp()}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function parseArgs(defaults) {
  const args = process.argv.slice(2);
  const out = { ...defaults };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = isNaN(+next) ? next : +next; i++; }
  }
  return out;
}

/** Builds (unless --no-build) and serves dist/ with `vite preview`. Returns { url, stop }. */
export async function startServer({ url, build = true, port = 4173 } = {}) {
  if (url) return { url, stop: () => {} };
  if (build) execSync('npx vite build', { stdio: 'inherit' });
  // In a process group of its own: `npx` starts vite as a child, and stopping only `npx` would leave vite serving.
  const proc = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
  const base = `http://localhost:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base); if (r.ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { url: base, stop: () => { try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* gone already */ } } };
}

export async function launch({ headed = false } = {}) {
  return chromium.launch({
    headless: !headed,
    args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=default', '--autoplay-policy=no-user-gesture-required'],
  });
}

export const MOBILE = {
  pixel5: { viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
  iphone12: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  ipad: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  desktop: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 },
};

/** Collects console errors and page errors. */
export function watchErrors(page, sink) {
  page.on('pageerror', (e) => sink.push({ kind: 'pageerror', text: String(e) }));
  page.on('console', (m) => { if (m.type() === 'error') sink.push({ kind: 'console', text: m.text() }); });
}

export async function openGame(page, url, { settings, autosave, test = true } = {}) {
  const u = new URL(url);
  if (test) u.searchParams.set('test', '1');
  await page.goto(u.toString());
  if (settings || autosave) {
    await page.evaluate(({ settings, autosave }) => {
      if (settings) localStorage.setItem('skychess.settings.v1', JSON.stringify(settings));
      if (autosave) localStorage.setItem('skychess.autosave.v1', JSON.stringify(autosave));
    }, { settings, autosave });
    await page.reload();
  }
  await page.waitForFunction(() => window.__test && document.querySelector('.overlay[data-name="title"]'), null, { timeout: 30000 });
}

export const idle = (page) => page.evaluate(() => window.__test.idle());
export const state = (page) => page.evaluate(() => window.__test.state());

/** Taps a square like a person would: on the piece's body if there is one. */
export async function tapSquare(page, sq, { touch = false, jitter = 0 } = {}) {
  const p = await page.evaluate((s) => window.__test.squareToScreen(s), sq);
  const x = p.x + (Math.random() - 0.5) * jitter, y = p.y + (Math.random() - 0.5) * jitter;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/** Drags a piece from one square to another with the mouse. */
export async function dragSquare(page, from, to) {
  const a = await page.evaluate((s) => window.__test.squareToScreen(s), from);
  const b = await page.evaluate((s) => window.__test.squareToScreen(s, 0.02), to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10); await page.waitForTimeout(16); }
  await page.mouse.up();
}

/** Plays one UCI move through the UI (tap-tap, or drag), handling the promotion picker. */
export async function playMove(page, uci, { touch = false, drag = false, jitter = 6 } = {}) {
  if (drag && !touch) await dragSquare(page, uci.slice(0, 2), uci.slice(2, 4));
  else {
    await tapSquare(page, uci.slice(0, 2), { touch, jitter });
    await page.waitForTimeout(80 + Math.random() * 120);
    await tapSquare(page, uci.slice(2, 4), { touch, jitter: jitter * 0.5 });
  }
  if (uci.length > 4) {
    await page.waitForSelector('.promo button', { timeout: 3000 });
    const idx = 'qrbn'.indexOf(uci[4]);
    await page.locator('.promo button').nth(Math.max(0, idx)).click();
  }
}

export function fenBoard(fen) {
  const b = {};
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) { if (/\d/.test(ch)) f += +ch; else { b['abcdefgh'[f] + (8 - r)] = ch; f++; } }
  });
  return b;
}
