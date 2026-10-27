// The reels: scripted, repeatable segments of the game, each recorded as one file (with cuts inside it) and its
// sound. A reel takes the cut's preset, so the same story is told at 16:9, 9:16 or 1:1 in that shape's own layout.
// Each returns [{ name, title, video, audio, seconds, marks, captions }].
import { openFilm, save, humanReady, overShown, PRESETS } from './kit.mjs';
import { LiveRecorder } from './clock.mjs';
import { PERSONAS, PersonaPlayer } from '../personas.js';
import { p3p2Server, createRoom } from '../rooms.mjs';
import { mulberry32 } from '../../src/ai/strength.js';

/** Morphy vs the Duke of Brunswick and Count Isouard, Paris 1858: the Opera Game. */
const OPERA = 'e2e4 e7e5 g1f3 d7d6 d2d4 c8g4 d4e5 g4f3 d1f3 d6e5 f1c4 g8f6 f3b3 d8e7 b1c3 c7c6 c1g5 b7b5 c3b5 c6b5 c4b5 b8d7 e1c1 a8d8 d1d7 d8d7 h1d1 e7e6 b5d7 f6d7 b3b8 d7b8 d1d8'.split(' ');
const blackOf = (moves) => moves.filter((_, i) => i % 2 === 1);

/** Records one reel: opens its page, runs `body`, and returns its clip with its sound. */
async function reel(env, name, title, open, body) {
  const f = await openFilm(env.browser, env.url, open.preset || env.preset, { errors: env.errors, ...open });
  try {
    const file = `${env.dir}/${env.preset.name}-${name}.mp4`;
    await f.rec.begin(file);
    await body(f);
    const seg = await f.rec.end();
    const audio = await f.rec.sound(seg, file.replace(/\.mp4$/, '.wav'));
    env.log(`  ${name}: ${seg.seconds.toFixed(1)} s`);
    return [{ name, title, video: file, audio, seconds: seg.seconds, marks: seg.marks, captions: seg.captions }];
  } finally {
    await f.close();
  }
}

/** A short dip to black and back: a jump cut over `fn`, which runs off the record. */
async function cutOver(f, fn) {
  await f.page.evaluate(() => window.__film.fade(1, 160));
  await f.rec.hold(170);
  const wait = f.human.wait;
  f.human.wait = (ms) => f.rec.skip(ms);
  await fn();
  f.human.wait = wait;
  await f.page.evaluate(() => window.__film.fade(0, 220));
}

/** Clicks the title menu's button, off the record (before a reel starts). */
async function startFromTitle(f, name) {
  await f.page.getByRole('button', { name }).click();
  await f.rec.skipUntil(humanReady, 15000);
}

/** A big title on a still, for a thumbnail. */
async function thumbnail(f, file, html) {
  await f.page.evaluate((h) => {
    window.__film.hideCursor();
    // Top left, clear of the action in the middle and right of the frame.
    const el = document.createElement('div');
    el.className = 'film-title film-still';
    el.style.cssText = 'top:7%;left:4%;right:auto;text-align:left;padding:0';
    el.innerHTML = `<h1 style="font-size:${window.__film.size * 3.4}px">${h}</h1>`;
    document.getElementById('film-layer').append(el);
  }, html);
  await f.rec.still(file);
  await f.page.evaluate(() => document.querySelectorAll('.film-still').forEach((e) => e.remove()));
}

/** The HUD, the version, p3p2's button and the cursor off (or back on), for a shot of the arena alone. */
const hideHud = (f, hidden) => f.page.evaluate((h) => {
  document.getElementById('hud').hidden = h;
  document.getElementById('version').hidden = h;
  const p = document.querySelector('p3p2-panel');
  if (p) p.style.visibility = h ? 'hidden' : '';
  if (h) window.__film.hideCursor();
}, hidden);

// ------------------------------------------------------------------ the reels

/** A knight takes a queen, close up: the hook. */
export function coldopen(env) {
  const fen = 'r1b1kbnr/pppp1ppp/2n5/4p1q1/4P3/3P1N2/PPP2PPP/RNBQKB1R w KQkq - 0 4';
  return reel(env, 'coldopen', 'Pieces shatter', { autosave: save({ startFen: fen, seed: 4242 }) }, async (f) => {
    await startFromTitle(f, /Continue game/);
    await f.page.evaluate(() => window.__filmApp.scriptAi(['c6d4']));
    const portrait = env.preset.name === 'short';
    await f.page.evaluate((p) => window.__filmApp.orbit(p ? { yaw: 0.3, pitch: -0.12, dist: 0.8 } : { yaw: 0.5, pitch: -0.24, dist: 0.74 }), portrait);
    await hideHud(f, true);
    await f.rec.skip(800);
    await f.rec.hold(400);
    await f.human.play('f3g5');
    // The strike, the shatter, the gust: then the line. The shatter's sound marks the moment of impact.
    await f.rec.until(() => window.__filmApp.sounds().some((x) => x.name === 'shatter'), 8000);
    await f.rec.hold(240);
    if (env.preset.name === 'youtube') await thumbnail(f, `${env.dir}/thumb-shatter.png`, 'PIECES<br>SHATTER');
    await f.page.evaluate((p) => window.__film.title({ text: 'Chess, but the pieces <i>shatter</i>', ms: 2600, pos: p ? 'top' : 'center', size: window.__film.size * (p ? 1.9 : 2.2) }), portrait);
    f.rec.captions.push({ at: f.rec.frames / 60, seconds: 2.6, text: 'Chess, but the pieces shatter' });
    await f.rec.hold(2700);
  });
}

/** The arena from afar, sweeping in, with the title. */
export function intro(env) {
  return reel(env, 'intro', 'Sky Arena Chess', {}, async (f) => {
    await startFromTitle(f, /Play White/);
    await hideHud(f, true);
    await f.page.evaluate(() => window.__filmApp.orbit({ yaw: -1.2, pitch: -0.12, dist: 1.9 }));
    await f.rec.skip(400);
    await f.page.evaluate(() => window.__filmApp.orbit({ yaw: 0, pitch: 0, dist: 1 }, 9000));
    await f.page.evaluate(() => window.__film.title({ text: 'Sky Arena<br>Chess', ms: 4200, size: window.__film.size * 3 }));
    f.rec.captions.push({ at: 0, seconds: 4.2, text: 'Sky Arena Chess' });
    await f.rec.hold(4600);
    await f.rec.say('3D chess on a floating island, free in your browser', { ms: 3400, sub: 'Ready to play in about a second: no install, no sign-up' });
    await f.rec.hold(3600);
    await f.rec.say('Every piece is built in code, and the wind blows through the arena', { ms: 3000 });
    await f.rec.hold(3200);
  });
}

/**
 * The Opera Game, through the board as a person plays it: White by the human, Black's historical replies given to
 * the AI (and said so on screen). Quiet stretches are cut. `from` starts it at that ply (a Short starts at move 12).
 */
export function opera(env, { from = 0, all = false } = {}) {
  const shown = {
    0: ['Replaying Morphy\'s Opera Game, Paris 1858', 'You play White. The AI is given Black\'s moves.'],
    2: ['Knights leap'],
    6: ['Every capture shatters the piece taken'],
    8: ['The queen takes the bishop'],
    18: ['10. Nxb5! A knight for two pawns'],
    20: ['11. Bxb5+ Check'],
    22: ['12. O-O-O: castling', 'The rook hops over the king'],
    24: ['13. Rxd7: rook takes knight, and rook takes back'],
    28: ['15. Bxd7+'],
    30: ['16. Qb8+!! The queen is given away…'],
    32: ['…for 17. Rd8 checkmate'],
  };
  const autosave = from ? save({ moves: OPERA.slice(0, from), seed: 1858 }) : null;
  return reel(env, 'opera', 'The Opera Game, 1858', { autosave, settings: { difficulty: 4 } }, async (f) => {
    const { page, rec, human } = f;
    if (from) {
      await startFromTitle(f, /Continue game/);
    } else {
      await rec.hold(500);
      await human.click(page.getByRole('button', { name: /Play White/ }));
      await rec.until(humanReady, 15000);
    }
    await page.evaluate((b) => window.__filmApp.scriptAi(b), blackOf(OPERA.slice(from)));
    rec.mark('The Opera Game');
    for (let ply = from; ply < OPERA.length; ply += 2) {
      const show = all || ply in shown;
      const play = async () => {
        await human.play(OPERA[ply], { drag: ply === 22 && !env.preset.touch });
        await (show ? rec.until(ply === 32 ? overShown : humanReady, 30000) : rec.skipUntil(humanReady, 30000));
      };
      if (!show) { await cutOver(f, play); continue; }
      if (ply === 22) rec.mark('Castling');
      if (ply === 30) rec.mark('The queen sacrifice');
      if (shown[ply]) {
        const [line, sub] = shown[ply];
        await rec.say(line, { ms: ply === 32 ? 3600 : 3000, sub });
      }
      await rec.hold(350);
      await play();
      await rec.hold(ply === 32 ? 2400 : 500);
    }
  });
}

/** Save a checkpoint, blunder the queen, and rewind time. `brief`: shorter holds, and it ends when time has rewound. */
export function rewind(env, { brief = false } = {}) {
  const moves = ['e2e4', 'e7e5', 'd1h5', 'b8c6'];
  return reel(env, 'rewind', 'Checkpoints rewind time', { autosave: save({ moves, seed: 99 }) }, async (f) => {
    const { page, rec, human } = f;
    await startFromTitle(f, /Continue game/);
    await page.evaluate(() => window.__filmApp.scriptAi(['e8f7', 'g7g6']));
    rec.mark('Checkpoints and rewinding time');
    await rec.say(brief ? 'Save a checkpoint' : 'Save a checkpoint…', { ms: brief ? 2000 : 2600 });
    await rec.hold(brief ? 200 : 400);
    await human.click(page.locator('#btn-save'));
    await rec.hold(brief ? 300 : 500);
    await human.click(page.locator('.overlay[data-name="slots"] .slot').first());
    await rec.hold(brief ? 400 : 900);
    await rec.say('…then make a mistake', { ms: brief ? 2200 : 2600 });
    await human.play('h5f7');
    await rec.until(humanReady, 20000);
    await rec.say('Oops: the king took the queen', { ms: brief ? 1700 : 2200 });
    await rec.hold(brief ? 1400 : 2000);
    await rec.say(brief ? 'Made a mistake? Rewind time' : 'Rewind time', { ms: 3200, sub: brief ? '' : 'The shards fly back and fuse; the moves play backwards' });
    await human.click(page.locator('#btn-load'));
    await rec.hold(500);
    await human.click(page.locator('.overlay[data-name="slots"] .slot').first());
    await rec.until(() => window.__test.state().phase === 'rewinding', 3000);
    let still = false;
    for (let i = 0; i < 900; i++) {
      if (!(await page.evaluate(() => window.__test.state().phase === 'rewinding'))) break;
      await rec.frame();
      if (!still && i === 150 && env.preset.name === 'youtube') { still = true; await thumbnail(f, `${env.dir}/thumb-rewind.png`, 'REWIND<br>TIME'); }
    }
    await rec.until(humanReady, 10000);
    if (brief) { await rec.hold(700); return; }
    await rec.hold(500);
    await rec.say('…and play the better move', { ms: 2600 });
    await human.play('f1c4');
    await rec.until(humanReady, 15000);
    await rec.hold(900);
  });
}

/** A pawn takes a rook and becomes a queen. */
export function promotion(env) {
  return reel(env, 'promotion', 'Promotion', { autosave: save({ startFen: '1r5k/P7/8/8/8/8/6PP/6K1 w - - 0 40', seed: 31 }) }, async (f) => {
    await startFromTitle(f, /Continue game/);
    await f.page.evaluate(() => window.__filmApp.scriptAi(['h8h7']));
    await f.page.evaluate(() => window.__filmApp.orbit({ yaw: -0.25, pitch: -0.08, dist: 0.85 }, 1));
    f.rec.mark('Promotion');
    await f.rec.say('Promotion: the pawn takes the rook, and becomes a queen', { ms: 4200 });
    await f.rec.hold(400);
    await f.human.play('a7b8q');
    await f.rec.until(humanReady, 15000);
    await f.rec.hold(1200);
  });
}

/** A real game against the adaptive AI (nothing scripted), and the level it found. */
export function vsai(env, { plies = 8 } = {}) {
  return reel(env, 'vsai', 'An AI that adapts to you', { settings: { difficulty: 'auto' } }, async (f) => {
    const { page, rec, human } = f;
    const persona = new PersonaPlayer(PERSONAS.club, mulberry32(5));
    await startFromTitle(f, /Play White/);
    rec.mark('The adaptive AI');
    await rec.say('Against the AI: nothing scripted now', { ms: 2800, sub: 'It estimates your level from your moves, and aims for a fair fight' });
    for (let k = 0; k < plies; k += 2) {
      const s = await page.evaluate(() => window.__test.state());
      if (s.over) break;
      const uci = persona.choose(s.startFen || undefined, s.moves);
      await rec.hold(Math.min(900, human.thinkMs({ legal: 30 }) / 4));
      await human.play(uci, { drag: k === 2 && !env.preset.touch });
      await rec.until(humanReady, 30000);
      if (k === 2) await cutOver(f, async () => {
        for (let j = 0; j < 4; j++) {
          const t = await page.evaluate(() => window.__test.state());
          if (t.over) break;
          await human.play(persona.choose(t.startFen || undefined, t.moves));
          await rec.skipUntil(humanReady, 30000);
        }
      });
    }
    await rec.hold(400);
    // The pause menu says both levels, in small print: the caption says them again, before and after.
    const { aiElo, rating } = await page.evaluate(() => window.__test.state());
    await rec.say('Pause, and it tells you its level, and yours', { ms: 2400 });
    await rec.hold(500);
    await human.click(page.locator('#btn-menu'));
    await rec.hold(2600);
    await human.click(page.getByRole('button', { name: /Resume/ }));
    await rec.hold(300);
    await rec.say(`AI ≈ ${aiElo} · you ≈ ${rating}`, { ms: 3000, sub: 'It keeps measuring, move by move and game by game' });
    await rec.hold(3000);
  });
}

/** Low, Medium and High on a phone, side by side: three recordings of the same moves. */
export async function devices(env) {
  const out = [];
  for (const quality of ['low', 'medium', 'high']) {
    const sub = { ...env, preset: PRESETS.pane };
    const [clip] = await reel(sub, `devices-${quality}`, 'Phones and graphics', { quality, seed: 3 }, async (f) => {
      await startFromTitle(f, /Play White/);
      await f.page.evaluate(() => window.__filmApp.scriptAi(['e7e5', 'b8c6', 'a7a6', 'd7c6']));
      if (quality === 'low') f.rec.mark('Phones and graphics');
      await f.rec.say(quality[0].toUpperCase() + quality.slice(1), { ms: 11000, pos: 'top', size: 26 });
      for (const uci of ['e2e4', 'g1f3', 'f1b5', 'b5c6']) {
        await f.rec.hold(300);
        await f.human.play(uci);
        await f.rec.hold(2600);
      }
      await f.rec.hold(600);
    });
    out.push(clip);
  }
  // The sound of the High phone: the three play the same moves.
  return [{ name: 'devices', title: 'Phones and graphics', stack: out, audio: out[2].audio, seconds: Math.min(...out.map((c) => c.seconds)), marks: out[0].marks,
    captions: [{ at: 0, seconds: 11, text: 'Low · Medium · High: picked for your device, and yours to change' }] }];
}

/** Close up, with the HUD off: the pieces idling, built in code, from low angles. */
export function closeup(env) {
  return reel(env, 'closeup', 'Made in code', { autosave: save({ moves: OPERA.slice(0, 16), seed: 1858 }), settings: { idleMotion: 'full' } }, async (f) => {
    const { page, rec } = f;
    await startFromTitle(f, /Continue game/);
    await hideHud(f, true);
    await page.evaluate(() => window.__filmApp.orbit({ yaw: -0.7, pitch: -0.42, dist: 0.5 }));
    await rec.skip(300);
    rec.mark('Made in code');
    await page.evaluate(() => window.__filmApp.orbit({ yaw: 0.1, pitch: -0.36, dist: 0.46 }, 9000));
    await rec.say('Every piece is made in code: no models or textures to download', { ms: 4200 });
    await rec.hold(4600);
    await rec.say('While they wait, they breathe, sway and bob', { ms: 3800 });
    await rec.hold(4600);
    await cutOver(f, async () => { await page.evaluate(() => window.__filmApp.orbit({ yaw: 2.6, pitch: -0.2, dist: 0.62 })); await rec.skip(200); });
    await page.evaluate(() => window.__filmApp.orbit({ yaw: 3.3, pitch: -0.1, dist: 0.8 }, 8000));
    await rec.say('The whole game starts from about 200 KB', { ms: 3800, sub: 'Physics and effects load while you play' });
    await rec.hold(4400);
    await rec.say('Toon shading, rim light and an outline that stays sharp on a phone', { ms: 3600 });
    await rec.hold(3800);
  });
}

/** The graphics setting, changed live: Low, then High. */
export function settings(env) {
  return reel(env, 'settings', 'Your settings', {}, async (f) => {
    const { page, rec, human } = f;
    await startFromTitle(f, /Play White/);
    await page.evaluate(() => window.__filmApp.scriptAi(['e7e5', 'g8f6']));
    await cutOver(f, async () => { for (const u of ['e2e4', 'g1f3']) { await human.play(u); await rec.skipUntil(humanReady, 20000); } });
    rec.mark('Your settings');
    const graphics = (name) => page.locator('.overlay[data-name="settings"] .setting').first().getByRole('radio', { name });
    const open = async () => {
      await human.click(page.locator('#btn-menu'));
      await rec.hold(400);
      await human.click(page.getByRole('button', { name: /Settings/ }));
      await rec.hold(500);
    };
    const close = async () => {
      // A click beside the panel closes it (Done is at the bottom of a panel taller than the screen); then Resume.
      const { width, height } = page.viewportSize();
      await human.clickAt(width * 0.12, height * 0.55);
      await page.locator('.overlay[data-name="settings"]').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
      await rec.hold(300);
      await human.click(page.locator('.overlay[data-name="pause"]').getByRole('button', { name: /Resume/ }));
    };
    await rec.say('Graphics, AI level, animation speed: picked for your device, yours to change', { ms: 4200 });
    await open();
    await rec.hold(1200);
    await human.click(graphics('Low'));
    await rec.hold(600);
    await close();
    await rec.say('Low: for older phones', { ms: 2600 });
    await rec.hold(2800);
    await open();
    await human.click(graphics('High'));
    await rec.hold(500);
    await close();
    await rec.say('High: soft shadows and bloom', { ms: 2600 });
    await rec.hold(2800);
  });
}

/** The end card. */
export function outro(env) {
  return reel(env, 'outro', 'Play it', {}, async (f) => {
    await startFromTitle(f, /Play White/);
    await f.page.evaluate(() => window.__filmApp.orbit({ yaw: 0.6, pitch: -0.1, dist: 1.5 }, 1));
    const short = env.preset.name === 'short';
    f.rec.mark('Play it');
    await f.rec.card({
      title: 'Sky Arena Chess', ms: short ? 4400 : 6500, fadeOut: 0,
      lines: short
        ? ['Free in your browser', { text: 'Link in the description', dim: true }]
        : env.preset.name === 'x'
          ? ['Free in your browser', { text: 'An AI that adapts to how you play', dim: true, scale: 0.85 }, { text: 'Open source: github.com/doublependu/chess', dim: true, scale: 0.75 }]
          : ['Free in your browser: no install, no sign-up', { text: 'Fork me on GitHub · github.com/doublependu/chess', dim: true, scale: 0.8 },
            { text: 'More games on Maize.Live · Multiplayer by p3p2.me', dim: true, scale: 0.8 }],
      url: env.args['url-label'] || '',
    });
    await f.rec.hold(short ? 4400 : 6500);
  });
}

/**
 * Friends in a room, recorded in real time (the room's server keeps real time): Ada on a desktop shows the invite,
 * Lin opens it on a phone, finds both seats taken and gets in line; Ada wins, and Lin takes the loser's seat.
 * Two panes side by side for YouTube (desktop | phone), Ada's screen alone for X.
 */
export async function friends(env) {
  const dual = env.preset.name === 'youtube';
  const server = await p3p2Server({ p3p2: env.args.p3p2 || '../p3p2', port: 18410 + Math.floor(Math.random() * 50) });
  const invite = await createRoom(env.browser, server, env.url, 'Friday chess');
  const join = async (f, name) => {
    await f.page.getByLabel('Your name').fill(name);
    await f.page.getByRole('button', { name: 'Join', exact: true }).click();
    await f.page.waitForFunction(() => window.__test.state().room, null, { timeout: 20000 });
    const close = f.page.locator('p3p2-panel').getByRole('button', { name: 'Close', exact: true });
    if (await close.isVisible().catch(() => false)) await close.click();
  };
  const timers = (f) => f.page.evaluate(() => window.__test.room.timers({ next: 9000 }));
  // CDP's screencast hands over frames in CSS pixels, whatever the device's scale: so the live pages are laid out at
  // the size they are recorded at. The phone is 480×810 (a large phone), scaled up a third to 640×1080.
  const deskPreset = dual
    ? { name: 'desk', viewport: { width: 1280, height: 1080 }, scale: 1, size: 30, safe: { top: 5, bottom: 8, left: 4, right: 4 } }
    : { ...env.preset, viewport: { width: 1080, height: 1080 }, scale: 1, size: 40 };
  const phonePreset = { name: 'phone', viewport: { width: 480, height: 810 }, scale: 4 / 3, touch: true, size: 24, safe: { top: 4, bottom: 6, left: 4, right: 4 } };
  const ada = await openFilm(env.browser, invite, deskPreset, { live: true, errors: env.errors, seed: 21 });
  const grace = await openFilm(env.browser, invite, PRESETS.x, { live: true, errors: env.errors, quality: 'low' });
  const lin = await openFilm(env.browser, invite, phonePreset, { live: true, errors: env.errors, seed: 22 });
  try {
    // One at a time, each in a seat before the next comes: two who arrive together may both reach for white.
    const seated = (f, c) => f.page.waitForFunction((k) => window.__test.state().room?.seat === k, c, { timeout: 20000 });
    await join(ada, 'Ada');
    await seated(ada, 0);
    await join(grace, 'Grace');
    await seated(grace, 1);
    await ada.page.waitForFunction(() => window.__test.state().room?.seats.every(Boolean), null, { timeout: 20000 });
    for (const f of [ada, grace, lin]) await timers(f).catch(() => {});
    // The game so far: four moves, as the two pages would send them.
    const submit = (f, uci) => f.page.evaluate((u) => { const r = window.__test.state().room; window.__test.room.submit({ t: 'move', n: r.n, ply: r.moves.length, uci: u }); }, uci);
    const ply = (n) => ada.page.waitForFunction((k) => window.__test.state().room.moves.length >= k, n, { timeout: 20000 });
    for (const [k, [who, uci]] of [[ada, 'e2e4'], [grace, 'e7e5'], [ada, 'f1c4'], [grace, 'b8c6'], [ada, 'd1h5']].entries()) { await submit(who, uci); await ply(k + 1); }
    await ada.page.evaluate(() => window.__test.idle());
    await lin.page.getByLabel('Your name').fill('Lin');

    const file = `${env.dir}/${env.preset.name}-friends.mp4`;
    const left = new LiveRecorder(ada.page, deskPreset.viewport);
    const right = dual ? new LiveRecorder(lin.page, phonePreset.viewport) : null;
    const t0 = await ada.page.evaluate(() => performance.now());
    await left.begin(dual ? file.replace('.mp4', '-ada.mp4') : file);
    if (right) await right.begin(file.replace('.mp4', '-lin.mp4'));
    const t = Date.now();
    const at = () => (Date.now() - t) / 1000;
    const captions = [];
    const say = async (f, text, o = {}) => { await f.page.evaluate(([x, opts]) => window.__film.caption(x, opts), [text, { ms: 3200, ...o }]); captions.push({ at: at(), seconds: (o.ms || 3200) / 1000, text }); };

    await say(ada, 'Play with friends: send one invite link', { sub: 'Rooms on a p3p2 server: no accounts' });
    await ada.human.click(ada.page.locator('p3p2-panel button[aria-label^="Multiplayer"]').filter({ visible: true }).first());
    await ada.page.waitForTimeout(1200);
    await ada.human.click(ada.page.locator('p3p2-panel').getByRole('button', { name: 'QR code' }));
    // Lin opens the link on a phone, and joins.
    await lin.human.click(lin.page.getByRole('button', { name: 'Join', exact: true }));
    if (dual) await say(lin, 'Both seats taken?', { pos: 'top', ms: 3600 });
    await lin.page.getByRole('button', { name: /Play: get in line/ }).waitFor({ timeout: 20000 });
    await lin.page.waitForTimeout(1600);
    await lin.human.click(lin.page.getByRole('button', { name: /Play: get in line/ }));
    if (!dual) await say(ada, 'Lin joins, finds both seats taken, and gets in line', { ms: 3200 });
    await ada.page.waitForTimeout(800);
    await ada.human.click(ada.page.locator('p3p2-panel').getByRole('button', { name: 'Close', exact: true }));
    // Grace blunders; Ada mates. Every screen sees it.
    await submit(grace, 'g8f6');
    await ada.page.waitForFunction(() => { const s = window.__test.state(); return s.phase === 'human' && !s.busy; }, null, { timeout: 15000 });
    await say(ada, 'Every move shows up on every screen', { ms: 3000 });
    await ada.page.waitForTimeout(700);
    await ada.human.play('h5f7');
    await ada.page.waitForFunction(() => window.__test.state().overlay === 'over', null, { timeout: 20000 });
    await say(ada, 'Winner stays on: the loser goes to the back of the line', { ms: 4200 });
    const start = lin.page.getByRole('button', { name: /Start now/ });
    await start.waitFor({ timeout: 15000 });
    await lin.page.waitForTimeout(2600);
    await lin.human.click(start);
    await lin.page.waitForFunction(() => { const s = window.__test.state(); return s.room?.seat === 0 && s.phase === 'human' && !s.busy; }, null, { timeout: 20000 });
    for (const f of [ada, lin]) await f.page.getByRole('button', { name: /View board/ }).click({ timeout: 1500 }).catch(() => {});
    await say(dual ? lin : ada, dual ? 'Lin\'s turn to play' : 'Lin\'s turn to play: Ada stays, with black', { pos: dual ? 'top' : 'bottom', ms: 3000 });
    await lin.page.waitForTimeout(600);
    await lin.human.play('d2d4');
    await ada.page.waitForFunction(() => window.__test.state().ply >= 1, null, { timeout: 15000 });
    await ada.page.waitForTimeout(1800);

    const t1 = await ada.page.evaluate(() => performance.now());
    const a = await left.end();
    const b = right ? await right.end() : null;
    const seconds = Math.min(a.seconds, b?.seconds ?? Infinity);
    const audio = file.replace('.mp4', '.wav');
    const b64 = await ada.page.evaluate((o) => window.__filmApp.renderAudio(o), { spans: [{ from: t0, to: t1, video: 0 }], seconds, scale: 1 });
    (await import('node:fs')).writeFileSync(audio, Buffer.from(b64, 'base64'));
    env.log(`  friends: ${seconds.toFixed(1)} s (live)`);
    const marks = [{ name: 'Playing with friends, taking turns', at: 0 }];
    return [dual
      ? { name: 'friends', title: 'Playing with friends', stack: [{ video: a.file, seconds: a.seconds }, { video: b.file, seconds: b.seconds }], audio, seconds, marks, captions }
      : { name: 'friends', title: 'Playing with friends', video: a.file, audio, seconds, marks, captions }];
  } finally {
    for (const f of [ada, grace, lin]) await f.close().catch(() => {});
  }
}

export const REELS = { coldopen, intro, opera, closeup, rewind, promotion, vsai, settings, devices, friends, outro };
