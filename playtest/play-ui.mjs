// Browser playtests: plays the real production build as a human would (taps, drags, mis-taps,
// rotations, saves/loads), records videos and writes a report to playtest-output/ (gitignored).
//
// Usage:
//   npm run playtest                        # all scenarios, default personas
//   node playtest/play-ui.mjs --scenarios game,checkpoint --personas club --max-moves 30
//   node playtest/play-ui.mjs --url http://localhost:5173/ --no-build --headed
//   node playtest/play-ui.mjs --scenarios outline --no-video   # outline coverage/flicker on phone and desktop
//   node playtest/play-ui.mjs --scenarios corners              # p3p2's button: on screen, clear of the HUD, opens the panel
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  parseArgs, outDir, startServer, launch, MOBILE, watchErrors, openGame, idle, state, playMove, tapSquare, fenBoard,
} from './lib.mjs';
import { PERSONAS, PersonaPlayer } from './personas.js';
import { Human } from './human.mjs';
import { mulberry32 } from '../src/ai/strength.js';

const args = parseArgs({
  scenarios: 'game,checkpoint,rotate,promotion,pause,corners,contextloss,outline', personas: 'beginner,club', 'max-moves': 40,
  speed: 1.8, video: true, headed: false, build: true, url: null, seed: 7,
});
const DIR = outDir('ui');
const report = { started: new Date().toISOString(), args, scenarios: [] };

const SETTINGS = (speed) => ({ graphics: 'auto', difficulty: 'auto', animSpeed: speed, sound: false, volume: 0, reducedMotion: false, showMoves: true, showSanInput: false });

async function newPage(browser, device, name) {
  const dev = MOBILE[device];
  const ctx = await browser.newContext({
    ...dev,
    recordVideo: args.video && !args['no-video'] ? { dir: `${DIR}/video/${name}`, size: dev.viewport } : undefined,
  });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  return { ctx, page, errors };
}

async function waitPly(page, ply, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state(page);
    if (s.ply > ply || s.over) return true;
    await page.waitForTimeout(60);
  }
  return false;
}

/** Plays human moves chosen by a persona until the game ends or `maxMoves` is reached. */
async function playPersonaMoves(page, player, rng, { maxMoves, touch, issues, frames, onMove }) {
  let played = 0;
  // Moves go through the board as a person makes them: a pointer on its way, sometimes a look at another piece.
  const human = new Human(page, { touch, rng, style: 'fast' });
  while (played < maxMoves) {
    const s = await idle(page);
    if (s.over) break;
    if (s.turn !== s.humanColor) { await page.waitForTimeout(100); continue; }
    const uci = player.choose(s.startFen || undefined, s.moves);
    if (!uci) break;
    // Occasional human sloppiness: tap an empty square or a different piece first.
    if (rng() < player.p.misTap) {
      const b = fenBoard(s.fen);
      const empty = Object.keys({ a3: 1, b4: 1, c5: 1, h3: 1, g4: 1, d5: 1 }).find((q) => !b[q]);
      if (empty) { await tapSquare(page, empty, { touch }); await page.waitForTimeout(120); }
    }
    const drag = rng() < (touch ? 0.15 : 0.3);
    await human.play(uci, { drag });
    if (!(await waitPly(page, s.ply))) {
      issues.push({ type: 'move-not-registered', uci, ply: s.ply, drag, touch });
      await playMove(page, uci, { touch, drag: false });
      if (!(await waitPly(page, s.ply))) { issues.push({ type: 'move-failed-twice', uci, ply: s.ply }); break; }
    }
    played++;
    const problems = await page.evaluate(async () => { await window.__test.idle(); return window.__test.checkScene(); });
    if (problems.length) issues.push({ type: 'scene-mismatch', ply: s.ply + 1, problems });
    frames.push(await page.evaluate(() => window.__test.frameStats()));
    onMove?.(uci);
  }
  return played;
}

async function scenarioGame(browser, url, personaKey, device) {
  const name = `game-${personaKey}-${device}`;
  const { ctx, page, errors } = await newPage(browser, device, name);
  const rng = mulberry32(args.seed + personaKey.length * 101);
  const persona = PERSONAS[personaKey];
  const player = new PersonaPlayer(persona, rng);
  const issues = [], frames = [];
  const t0 = Date.now();
  await openGame(page, url, { settings: SETTINGS(args.speed) });
  const color = rng() < 0.5 ? 'Play White' : 'Play Black';
  await page.getByRole('button', { name: new RegExp(color) }).click();
  const touch = !!MOBILE[device].hasTouch;
  const played = await playPersonaMoves(page, player, rng, { maxMoves: args['max-moves'], touch, issues, frames });
  const s = await state(page);
  const events = await page.evaluate(() => window.__test.events());
  const info = await page.evaluate(() => window.__test.info());
  await ctx.close();
  const aiMoves = events.filter((e) => e.type === 'ai');
  return {
    name, persona: persona.label, device, tier: info.tier, played, plies: s.ply, over: s.over, result: s.result,
    humanColor: s.humanColor, rating: s.rating, aiElo: s.aiElo, seconds: Math.round((Date.now() - t0) / 1000),
    aiEloRange: aiMoves.length ? [Math.min(...aiMoves.map((e) => e.elo)), Math.max(...aiMoves.map((e) => e.elo))] : null,
    aiOversights: aiMoves.filter((e) => e.oversight).length,
    frameEmaMs: frames.length ? +(frames.reduce((a, f) => a + f.ema, 0) / frames.length).toFixed(1) : null,
    moves: s.moves, issues, errors,
  };
}

async function scenarioCheckpoint(browser, url) {
  const { ctx, page, errors } = await newPage(browser, 'desktop', 'checkpoint');
  const rng = mulberry32(args.seed + 5);
  const player = new PersonaPlayer(PERSONAS.club, rng);
  const issues = [], frames = [], checks = [];
  await openGame(page, url, { settings: SETTINGS(Math.max(args.speed, 2)) });
  await page.getByRole('button', { name: /Play White/ }).click();
  await playPersonaMoves(page, player, rng, { maxMoves: 8, touch: false, issues, frames });
  const saveTo = async (slot) => {
    await idle(page);
    await page.click('#btn-save');
    await page.locator('.slot').nth(slot).click();
    if (await page.locator('[data-name="confirm"]').count()) await page.getByRole('button', { name: 'Overwrite' }).click();
    await page.waitForTimeout(300);
    return state(page);
  };
  const loadFrom = async (slot) => {
    await idle(page);
    await page.click('#btn-load');
    await page.locator('.slot').nth(slot).click();
    const t0 = Date.now();
    await page.waitForTimeout(300);
    await idle(page);
    return { s: await state(page), ms: Date.now() - t0 };
  };
  const saved = await saveTo(1);
  await playPersonaMoves(page, player, rng, { maxMoves: 6, touch: false, issues, frames });
  const later = await state(page);
  const r1 = await loadFrom(1);
  checks.push({ check: 'rewind to earlier save restores position', ok: r1.s.fen === saved.fen, rewindMs: r1.ms, fromPly: later.ply, toPly: r1.s.ply });
  checks.push({ check: 'scene matches after rewind', ok: (await page.evaluate(() => window.__test.checkScene())).length === 0 });
  // Diverge, save a branch, then jump between branches.
  const player2 = new PersonaPlayer(PERSONAS.casual, mulberry32(args.seed + 99));
  await playPersonaMoves(page, player2, rng, { maxMoves: 4, touch: false, issues, frames });
  const branch = await saveTo(2);
  const r2 = await loadFrom(1);
  checks.push({ check: 'rewind from a branch back to the save', ok: r2.s.fen === saved.fen });
  const r3 = await loadFrom(2);
  checks.push({ check: 'fast-forward to the other branch', ok: r3.s.fen === branch.fen, ms: r3.ms });
  checks.push({ check: 'scene matches after branch jump', ok: (await page.evaluate(() => window.__test.checkScene())).length === 0 });
  // Reload and continue from the autosave.
  await page.reload();
  await page.waitForFunction(() => window.__test && document.querySelector('.overlay[data-name="title"]'));
  await page.getByRole('button', { name: /Continue/ }).click();
  const cont = await idle(page);
  checks.push({ check: 'continue after reload restores the game', ok: cont.fen === branch.fen });
  // Rewind after reload: shards must be regenerated (no session cache).
  const r4 = await loadFrom(1);
  checks.push({ check: 'rewind after reload', ok: r4.s.fen === saved.fen, ms: r4.ms });
  await ctx.close();
  return { name: 'checkpoint', checks, issues, errors, ok: checks.every((c) => c.ok) };
}

async function scenarioRotate(browser, url) {
  const { ctx, page, errors } = await newPage(browser, 'pixel5', 'rotate');
  const rng = mulberry32(args.seed + 11);
  const player = new PersonaPlayer(PERSONAS.casual, rng);
  const issues = [], frames = [], checks = [];
  await openGame(page, url, { settings: SETTINGS(Math.max(args.speed, 2)) });
  await page.getByRole('button', { name: /Play White/ }).tap();
  const sizes = [[393, 851], [851, 393], [393, 851], [915, 412], [412, 915]];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    const c = await page.evaluate(() => window.__test.canvasSize());
    const expectW = Math.round(w * c.pixelRatio), expectH = Math.round(h * c.pixelRatio);
    checks.push({ check: `canvas fills ${w}x${h}`, ok: c.css[0] === w && c.css[1] === h && Math.abs(c.px[0] - expectW) <= 2 && Math.abs(c.px[1] - expectH) <= 2, c });
    const before = (await state(page)).ply;
    await playPersonaMoves(page, player, rng, { maxMoves: 1, touch: true, issues, frames });
    checks.push({ check: `touch move registers after rotating to ${w}x${h}`, ok: (await state(page)).ply > before });
  }
  await ctx.close();
  return { name: 'rotate', checks, issues, errors, ok: checks.every((c) => c.ok) && !issues.length };
}

async function scenarioPromotion(browser, url) {
  const { ctx, page, errors } = await newPage(browser, 'desktop', 'promotion');
  const autosave = { schema: 1, savedAt: Date.now(), label: 'promo', humanColor: 0, seed: 77, startFen: '1r5k/P7/8/8/8/8/6PP/6K1 w - - 0 40', moves: [], director: null, turn: 0, over: false };
  await openGame(page, url, { settings: SETTINGS(2), autosave });
  await page.getByRole('button', { name: /Continue/ }).click();
  await idle(page);
  await playMove(page, 'a7b8q', { touch: false });
  await page.waitForTimeout(400);
  const s = await idle(page);
  const scene = await page.evaluate(() => window.__test.checkScene());
  await ctx.close();
  const checks = [
    { check: 'capture-promotion through the picker', ok: s.moves[0] === 'a7b8q' },
    { check: 'promoted piece shown on b8', ok: scene.length === 0, scene },
  ];
  return { name: 'promotion', checks, errors, ok: checks.every((c) => c.ok) };
}

async function scenarioPause(browser, url) {
  const { ctx, page, errors } = await newPage(browser, 'desktop', 'pause');
  await openGame(page, url, { settings: SETTINGS(2) });
  const loadingCorner = await page.locator('.github-corner').count();
  await page.getByRole('button', { name: /Play White/ }).click();
  await idle(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const overlay = await page.evaluate(() => window.__test.overlay());
  const corner = await page.locator('.overlay[data-name="pause"] .github-corner svg').count();
  const href = await page.locator('.overlay[data-name="pause"] .github-corner').getAttribute('href');
  const version = await page.locator('#version').textContent();
  const maize = await page.locator('.overlay[data-name="pause"] a[href="https://maize.live"]').count();
  const p3p2 = await page.locator('.overlay[data-name="pause"] .hint a[href="https://p3p2.me/#start"]').count();
  const loadingHtml = await (await fetch(url)).text();
  const loadingMaize = /<div id="loading">[\s\S]*<a href="https:\/\/maize\.live"[^>]*>More games on Maize\.Live<\/a>/.test(loadingHtml);
  await page.getByRole('button', { name: /Resume/ }).click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__test.overlay());
  await ctx.close();
  const checks = [
    { check: 'title/loading shows the GitHub corner', ok: loadingCorner > 0 },
    { check: 'Esc opens pause', ok: overlay === 'pause' },
    { check: 'pause screen has the fork-me corner', ok: corner === 1 && /github\.com\/doublependu\/chess/.test(href || '') },
    { check: 'version badge "v.xxxx"', ok: /^v\.[0-9a-f]{4}$/.test((version || '').trim()), version },
    { check: 'resume closes pause', ok: after === null },
    { check: 'loading screen links to Maize.Live', ok: loadingMaize },
    { check: 'pause screen links to Maize.Live', ok: maize === 1 },
    { check: 'pause screen says where to make a room (p3p2.me)', ok: p3p2 === 1 },
  ];
  return { name: 'pause', checks, errors, ok: checks.every((c) => c.ok) };
}

async function scenarioContextLoss(browser, url) {
  const { ctx, page, errors } = await newPage(browser, 'desktop', 'contextloss');
  const rng = mulberry32(args.seed + 3);
  const player = new PersonaPlayer(PERSONAS.club, rng);
  const issues = [], frames = [];
  await openGame(page, url, { settings: SETTINGS(2) });
  await page.getByRole('button', { name: /Play White/ }).click();
  await playPersonaMoves(page, player, rng, { maxMoves: 2, touch: false, issues, frames });
  await page.evaluate(() => window.__test.loseContext());
  await page.waitForTimeout(1500);
  const before = (await state(page)).ply;
  await playPersonaMoves(page, player, rng, { maxMoves: 2, touch: false, issues, frames });
  const after = (await state(page)).ply;
  await ctx.close();
  const checks = [{ check: 'play continues after WebGL context loss', ok: after > before }];
  return { name: 'contextloss', checks, issues, errors, ok: checks.every((c) => c.ok) && !issues.length };
}

/** Whether two DOMRect-likes overlap (touching edges do not count). */
const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// p3p2's own multiplayer button has the bottom-right corner: it must be on screen, clear of every HUD control, and
// open the same panel as "Play with a friend" in the menu. On four screen shapes, with screenshots in corners/.
async function scenarioCorners(browser, url) {
  const runs = [
    { name: 'pixel5', device: 'pixel5' },
    { name: 'pixel5-landscape', device: 'pixel5', viewport: { width: 851, height: 393 } },
    { name: 'iphone12', device: 'iphone12' },
    { name: 'desktop', device: 'desktop' },
  ];
  const checks = [], errors = [];
  mkdirSync(`${DIR}/corners`, { recursive: true });
  for (const run of runs) {
    const dev = { ...MOBILE[run.device], ...(run.viewport ? { viewport: run.viewport } : {}) };
    const ctx = await browser.newContext(dev);
    const page = await ctx.newPage();
    watchErrors(page, errors);
    await openGame(page, url, { settings: SETTINGS(2) });
    const touch = !!dev.hasTouch;
    const press = (loc) => (touch ? loc.tap() : loc.click());
    await press(page.getByRole('button', { name: /Play White/ }));
    await idle(page);
    const rects = await page.evaluate(() => {
      const r = (el) => { if (!el || el.hidden) return null; const b = el.getBoundingClientRect(); return b.width ? { x: b.x, y: b.y, width: b.width, height: b.height } : null; };
      const out = { p3p2: r(document.querySelector('p3p2-panel')), vw: innerWidth, vh: innerHeight };
      for (const id of ['btn-view', 'btn-menu', 'p-you', 'p-ai', 'hud-actions-top', 'version']) out[id] = r(document.getElementById(id));
      return out;
    });
    await page.screenshot({ path: `${DIR}/corners/${run.name}.png` });
    const p = rects.p3p2;
    const inside = p && p.x >= 0 && p.y >= 0 && p.x + p.width <= rects.vw && p.y + p.height <= rects.vh;
    const hit = ['btn-view', 'btn-menu', 'p-you', 'p-ai', 'hud-actions-top', 'version'].filter((id) => overlaps(p, rects[id]));
    checks.push({ check: `${run.name}: the p3p2 button is on screen in the corner, clear of ⌖, the plates and the other controls`, ok: !!inside && !hit.length, rect: p, hit });
    // The corner button and the menu's "Play with a friend" open the same panel.
    const card = page.locator('p3p2-panel section.card');
    await press(page.locator('p3p2-panel button[aria-label^="Multiplayer"]').filter({ visible: true }).first());
    const fromCorner = await card.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    await page.screenshot({ path: `${DIR}/corners/${run.name}-panel.png` });
    await press(page.locator('p3p2-panel').getByRole('button', { name: 'Close', exact: true }));
    await press(page.locator('#btn-menu'));
    await press(page.getByRole('button', { name: /Play with a friend/ }));
    const fromMenu = await card.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    checks.push({ check: `${run.name}: the corner button and "Play with a friend" both open p3p2's panel`, ok: fromCorner && fromMenu });
    await ctx.close();
  }
  return { name: 'corners', checks, errors, ok: checks.every((c) => c.ok) && !errors.length };
}

// How well the piece outlines read on a phone (Low and Medium) and on a desktop, with the pieces at rest
// (see src/debug/outlineProbe.js). Screenshots of both back ranks go to outline/.
async function scenarioOutline(browser, url) {
  const runs = [
    { device: 'pixel5', quality: 'low', scales: [1, 0.6] },
    { device: 'pixel5', quality: 'medium', scales: [1] },
    { device: 'desktop', quality: 'medium', scales: [1] },
  ];
  const checks = [], results = [], errors = [];
  mkdirSync(`${DIR}/outline`, { recursive: true });
  for (const run of runs) {
    const name = `outline-${run.device}-${run.quality}`;
    const { ctx, page, errors: errs } = await newPage(browser, run.device, name);
    const u = new URL(url);
    u.searchParams.set('quality', run.quality);
    await openGame(page, u.toString(), { settings: SETTINGS(2) });
    const start = page.getByRole('button', { name: /Play White/ });
    if (MOBILE[run.device].hasTouch) await start.tap(); else await start.click();
    await idle(page);
    for (const scale of run.scales) {
      const stats = await page.evaluate((scale) => window.__test.outlineStats({ scale }), scale);
      results.push({ ...run, scale, ...stats });
      const phone = run.device !== 'desktop';
      checks.push({
        check: `${run.device} ${run.quality} ×${scale}, idle ${stats.idle}: outline unbroken (min coverage ${stats.minCoverage}, min bottom ${stats.minBottom}, width ${stats.width} px, flicker ${stats.flicker})`,
        ok: !phone || (stats.minCoverage >= 0.9 && stats.minBottom >= 0.9),
      });
    }
    await page.evaluate(() => window.__test.holdClock(10));
    await page.waitForTimeout(150);
    for (const [rank, label] of [['8', 'black'], ['1', 'white']]) {
      const pts = await page.evaluate((r) => ['a', 'h'].map((f) => window.__test.squareToScreen(f + r, 0.6)), rank);
      const x = Math.max(0, Math.min(pts[0].x, pts[1].x) - 30), y = Math.max(0, Math.min(pts[0].y, pts[1].y) - 70);
      await page.screenshot({ path: `${DIR}/outline/${name}-${label}.png`, clip: { x, y, width: Math.abs(pts[1].x - pts[0].x) + 60, height: 110 } });
    }
    await page.evaluate(() => window.__test.holdClock(null));
    errors.push(...errs);
    await ctx.close();
  }
  return { name: 'outline', checks, results, errors, ok: checks.every((c) => c.ok) };
}

const server = await startServer({ url: args.url, build: args.build !== false && !args['no-build'] });
const browser = await launch({ headed: args.headed });
const scenarios = String(args.scenarios).split(',');
try {
  for (const sc of scenarios) {
    const t0 = Date.now();
    let res;
    try {
      if (sc === 'game') {
        for (const p of String(args.personas).split(',')) {
          for (const device of ['desktop', 'pixel5']) {
            res = await scenarioGame(browser, server.url, p, device);
            report.scenarios.push(res);
            console.log(`[game] ${res.persona} on ${res.device}: ${res.plies} plies, ${res.over ? res.result.status : 'unfinished'}, AI ${res.aiEloRange?.join('–')}, issues ${res.issues.length}, errors ${res.errors.length}`);
          }
        }
        continue;
      }
      const fn = { checkpoint: scenarioCheckpoint, rotate: scenarioRotate, promotion: scenarioPromotion, pause: scenarioPause, contextloss: scenarioContextLoss, outline: scenarioOutline, corners: scenarioCorners }[sc];
      if (!fn) { console.warn('unknown scenario', sc); continue; }
      res = await fn(browser, server.url);
    } catch (e) {
      res = { name: sc, ok: false, crash: String(e?.stack || e) };
    }
    res.seconds = Math.round((Date.now() - t0) / 1000);
    report.scenarios.push(res);
    console.log(`[${sc}] ${res.ok ? 'OK' : 'FAIL'}${res.checks ? ' — ' + res.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.check}`).join('; ') : ''}${res.crash ? '\n' + res.crash : ''}`);
  }
} finally {
  await browser.close();
  server.stop();
}

report.finished = new Date().toISOString();
const allErrors = report.scenarios.flatMap((s) => s.errors || []);
const failures = report.scenarios.filter((s) => s.ok === false || (s.issues && s.issues.length));
writeFileSync(`${DIR}/report.json`, JSON.stringify(report, null, 2));
const pgn = report.scenarios.filter((s) => s.moves).map((s) => `[Event "${s.name}"]\n[Persona "${s.persona}"]\n\n${s.moves.join(' ')}\n`).join('\n');
if (pgn) writeFileSync(`${DIR}/games.uci.txt`, pgn);
const md = [
  `# UI playtest ${report.started}`, '',
  ...report.scenarios.map((s) => `- **${s.name}**: ${s.ok === false ? 'FAIL' : 'ok'}${s.plies ? ` · ${s.plies} plies · ${s.over ? s.result.status : 'unfinished'} · AI ${s.aiEloRange?.join('–')} · ${s.frameEmaMs} ms/frame` : ''}${s.checks ? '\n' + s.checks.map((c) => `  - ${c.ok ? '✓' : '✗'} ${c.check}`).join('\n') : ''}${s.issues?.length ? `\n  - issues: ${JSON.stringify(s.issues).slice(0, 400)}` : ''}${s.errors?.length ? `\n  - errors: ${JSON.stringify(s.errors).slice(0, 400)}` : ''}`),
  '', `Console/page errors: ${allErrors.length}`,
];
writeFileSync(`${DIR}/report.md`, md.join('\n'));
mkdirSync(`${DIR}/video`, { recursive: true });
console.log(`\nReport: ${DIR}/report.md (videos in ${DIR}/video)`);
console.log(failures.length || allErrors.length ? `✗ ${failures.length} failing scenario(s), ${allErrors.length} error(s)` : '✓ all scenarios passed');
process.exitCode = failures.length || allErrors.length ? 1 : 0;
