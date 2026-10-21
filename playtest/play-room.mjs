// Chess with a friend, played for real: the production build, a p3p2 server, and three people in one room. A host on
// a desktop (white), a guest on a phone (black, by touch), and a watcher. Writes a report and videos to
// playtest-output/room-* (gitignored).
//
// Needs a p3p2 server. By default one is started from the p3p2 checkout next to this one (../p3p2), in memory:
//   npm run playtest:room
//   node playtest/play-room.mjs --p3p2 ~/src/p3p2           # another checkout
//   P3P2_OWNER_PASSWORD=… node playtest/play-room.mjs --server http://localhost:8080   # one already running
//   node playtest/play-room.mjs --lag                        # through p3p2's lag proxy: 150 ms ± 50 each way, one cut
//   node playtest/play-room.mjs --plies 30 --headed --no-video
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, outDir, startServer, launch, MOBILE, watchErrors, openGame, playMove, tapSquare } from './lib.mjs';
import { PERSONAS, PersonaPlayer } from './personas.js';
import { mulberry32 } from '../src/ai/strength.js';

const args = parseArgs({ p3p2: '../p3p2', server: null, port: 18210, plies: 20, lag: false, headed: false, video: true, build: true, url: null, seed: 11 });
const DIR = outDir('room');
const SETTINGS = { graphics: 'auto', difficulty: 'auto', animSpeed: 2, sound: false, volume: 0, reducedMotion: false, showMoves: true, showSanInput: false };
const checks = [];
const issues = [];
const check = (name, ok, extra = {}) => {
  checks.push({ check: name, ok: !!ok, ...extra });
  console.log(`${ok ? '✓' : '✗'} ${name}${Object.keys(extra).length ? ' ' + JSON.stringify(extra).slice(0, 200) : ''}`);
  return !!ok;
};
const children = [];
const stopAll = () => { for (const c of children) c.kill('SIGTERM'); };
process.once('exit', stopAll);

// ---------------------------------------------------------------- the p3p2 server (and the lag proxy)

async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not answer in ${ms / 1000} s`);
}

async function p3p2Server() {
  if (args.server) {
    const password = process.env.P3P2_OWNER_PASSWORD;
    if (!password) throw new Error('--server needs the owner password in P3P2_OWNER_PASSWORD');
    return { url: String(args.server).replace(/\/$/, ''), password, dir: args.p3p2 ? resolve(String(args.p3p2)) : null };
  }
  const dir = resolve(String(args.p3p2));
  const main = join(dir, 'server', 'src', 'main.ts');
  if (!existsSync(main)) throw new Error(`No p3p2 checkout at ${dir} (give one with --p3p2, or a running server with --server)`);
  const port = args.port;
  const password = 'room-playtest-' + Math.random().toString(36).slice(2, 10);
  const child = spawn(process.execPath, [main], {
    cwd: dir,
    env: {
      ...process.env, P3P2_PORT: String(port), P3P2_HOST: '127.0.0.1', P3P2_PUBLIC_URL: `http://127.0.0.1:${port}`,
      P3P2_DATA_DIR: ':memory:', P3P2_OWNER_PASSWORD: password, P3P2_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.push(child);
  await waitFor(`http://127.0.0.1:${port}/healthz`);
  return { url: `http://127.0.0.1:${port}`, password, dir };
}

async function lagProxy(server) {
  if (!server.dir) throw new Error('--lag needs a p3p2 checkout (--p3p2) for its lag proxy');
  const listen = args.port + 1;
  const to = new URL(server.url);
  const child = spawn(process.execPath, [
    join(server.dir, 'e2e', 'tools', 'lag-proxy.ts'), '--listen', String(listen), '--to', `${to.hostname}:${to.port}`,
    '--latency', '150', '--jitter', '50', '--drop-every', '45',
  ], { cwd: server.dir, stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  await waitFor(`http://127.0.0.1:${listen}/healthz`);
  return listen;
}

/** The owner's side: logs in to the portal and makes a room for the game's address. Returns its room URL. */
async function createRoom(browser, server, gameUrl) {
  const ctx = await browser.newContext();
  const portal = await ctx.newPage();
  await portal.goto(`${server.url}/`);
  await portal.getByLabel('Password').fill(server.password);
  await portal.getByRole('button', { name: 'Log in' }).click();
  await portal.getByLabel('Game URL').fill(gameUrl);
  await portal.getByLabel('Room name').fill('Sky Arena playtest');
  await portal.getByRole('button', { name: 'Create room' }).click();
  await portal.getByRole('heading', { name: 'Sky Arena playtest' }).waitFor();
  const roomUrl = await portal.getByLabel('Room URL').inputValue();
  await ctx.close();
  return roomUrl;
}

// ---------------------------------------------------------------- the people

async function person(browser, device, name) {
  const dev = MOBILE[device];
  const ctx = await browser.newContext({
    ...dev,
    recordVideo: args.video && !args['no-video'] ? { dir: `${DIR}/video/${name}`, size: dev.viewport } : undefined,
  });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  // A dropped connection that comes back is not an error of the game's.
  return { ctx, page, errors, name, device, touch: !!dev.hasTouch };
}

const st = (p) => p.page.evaluate(() => window.__test.state());
const room = (p) => p.page.evaluate(() => window.__test.state().room);
const settle = (p) => p.page.evaluate(() => window.__test.idle());

async function until(fn, ms = 10000, step = 100) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}

/** What every page should agree on: the table, and the board it shows; and, if given, what they should agree on. */
async function agree(people, ms = 15000, expected = () => true) {
  const ok = await until(async () => {
    const all = await Promise.all(people.map(async (p) => { await settle(p); return st(p); }));
    if (all.some((s) => !s.room)) return false;
    const fp = all[0].room.fingerprint;
    return all.every((s) => s.room.fingerprint === fp && s.fen === all[0].fen) && expected(all) ? all : false;
  }, ms, 150);
  return ok || null;
}

async function closePanel(p) {
  const close = p.page.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function openFromInvite(p, invite) {
  const u = new URL(invite);
  u.searchParams.set('test', '1');
  await p.page.goto(u.toString());
  await p.page.evaluate((s) => localStorage.setItem('skychess.settings.v1', JSON.stringify(s)), SETTINGS);
  await p.page.getByRole('button', { name: 'Join', exact: true }).waitFor({ timeout: 20000 });
  await p.page.getByLabel('Your name').fill(p.name);
  await p.page.getByRole('button', { name: 'Join', exact: true }).click();
  await until(() => room(p), 15000);
  await closePanel(p);
}

/** The side on move plays a persona's move through the board, by taps (or a click and a drag). */
async function playOne(people, players, rng) {
  const all = await agree(people);
  if (!all) { issues.push({ type: 'pages-disagree' }); return false; }
  const s = all[0];
  if (s.over) return false;
  const i = people.findIndex((p, k) => all[k].room.seat === s.turn);
  if (i < 0) { issues.push({ type: 'nobody-on-move', turn: s.turn }); return false; }
  const mover = people[i];
  const uci = players[i].choose(s.startFen || undefined, s.moves);
  await playMove(mover.page, uci, { touch: mover.touch, drag: !mover.touch && rng() < 0.3 });
  const t0 = Date.now();
  // A move lost on the way goes again after 4 s, and again, for 12 s (Controller.sendMove).
  const moved = await until(async () => (await st(mover)).room.moves.length > s.ply, 14000);
  if (!moved) {
    issues.push({ type: 'move-not-registered', by: mover.name, uci, ply: s.ply });
    return false;
  }
  if (Date.now() - t0 > 3000) {
    const resent = (await mover.page.evaluate(() => window.__test.events())).filter((e) => e.type === 'resent').length;
    issues.push({ type: 'note', text: `a move took ${((Date.now() - t0) / 1000).toFixed(1)} s to arrive`, resent, uci });
  }
  return { uci, by: mover.name, ply: s.ply + 1 };
}

// ---------------------------------------------------------------- the run

const game = await startServer({ url: args.url, build: args.build !== false && !args['no-build'] });
const browser = await launch({ headed: args.headed });
const report = { started: new Date().toISOString(), args, checks, issues, moves: [] };
let people = [];
try {
  const server = await p3p2Server();
  const gameUrl = game.url;
  let roomUrl = await createRoom(browser, server, gameUrl);
  if (args.lag) {
    const port = await lagProxy(server);
    const u = new URL(roomUrl);
    u.port = String(port);
    roomUrl = u.toString();
  }
  check('the portal made a room for the game', /^https?:\/\//.test(roomUrl), { roomUrl });

  const ada = await person(browser, 'desktop', 'Ada');
  const grace = await person(browser, 'pixel5', 'Grace');
  const lin = await person(browser, 'desktop', 'Lin');
  people = [ada, grace, lin];

  // Ada plays the AI first, so there is an autosave to come back to after the room.
  await openGame(ada.page, gameUrl, { settings: SETTINGS });
  check('the title has the p3p2.me hint', await ada.page.locator('.overlay[data-name="title"] .hint a[href="https://p3p2.me/#start"]').count() === 1);
  await ada.page.getByRole('button', { name: /Play White/ }).click();
  await settle(ada);
  await playMove(ada.page, 'e2e4');
  await until(async () => (await st(ada)).ply >= 2, 15000);
  await settle(ada);
  const beforeRoom = await st(ada);

  // Ada hosts from the pause menu.
  await ada.page.keyboard.press('Escape');
  await ada.page.getByRole('button', { name: /Play with a friend/ }).click();
  await ada.page.getByLabel('Your name').fill('Ada');
  await ada.page.getByLabel('Room URL').fill(roomUrl);
  await ada.page.getByRole('status').filter({ hasText: '✓' }).waitFor({ timeout: 15000 });
  await ada.page.getByRole('button', { name: 'Create a multiplayer game room for my friends' }).click();
  const linkBox = ada.page.getByLabel('Invite link', { exact: true });
  await linkBox.waitFor();
  const invite = await linkBox.inputValue();
  await closePanel(ada);
  const adaRoom = await until(async () => { const r = await room(ada); return r && r.seat === 0 ? r : null; }, 15000);
  check('the host takes white', adaRoom?.seat === 0, { invite });
  check('in a room, the checkpoint buttons go', await ada.page.locator('#hud-actions-top').isHidden());

  await openFromInvite(grace, invite);
  const graceRoom = await until(async () => { const r = await room(grace); return r && r.seat === 1 ? r : null; }, 15000);
  check('the guest from the invite takes black (on a phone)', graceRoom?.seat === 1);
  await openFromInvite(lin, invite);
  const linRoom = await until(() => room(lin), 15000);
  check('the third one watches', linRoom?.seat === -1);
  const agreed0 = await agree(people);
  check('all three pages start from the same table', !!agreed0, { fingerprint: agreed0?.[0].room.fingerprint });
  check('the plates name the players', (await grace.page.locator('#p-you .name').textContent()).includes('Grace') && (await grace.page.locator('#p-ai .name').textContent()).includes('Ada'));

  // Out of turn, and watching, a tap does nothing. White is to move: Grace and Lin try.
  await tapSquare(grace.page, 'e7', { touch: true }); await grace.page.waitForTimeout(150); await tapSquare(grace.page, 'e5', { touch: true });
  await tapSquare(lin.page, 'd2'); await lin.page.waitForTimeout(150); await tapSquare(lin.page, 'd4');
  await new Promise((r) => setTimeout(r, 1200));
  check('a tap out of turn, or by a watcher, does nothing', (await st(ada)).room.moves.length === 0 && (await st(grace)).room.sent === null);

  // The game: a club player on each side, and every page agreeing after every move.
  const rng = mulberry32(args.seed);
  const players = [new PersonaPlayer(PERSONAS.club, mulberry32(args.seed + 1)), new PersonaPlayer(PERSONAS.casual, mulberry32(args.seed + 2)), null];
  let sawCapture = false, captured = false, disagreed = 0;
  for (let k = 0; k < args.plies; k++) {
    const r = await playOne(people, players, rng);
    if (!r) break;
    report.moves.push(r.uci);
    const all = await agree(people);
    if (!all) { disagreed++; issues.push({ type: 'pages-disagree-after', ply: r.ply }); continue; }
    for (const p of people) {
      const scene = await p.page.evaluate(() => window.__test.checkScene());
      if (scene.length) issues.push({ type: 'scene-mismatch', who: p.name, ply: r.ply, scene });
    }
    if (!captured && all[0].fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length < 32) captured = r.ply;
    if (captured && !sawCapture) {
      const d = await Promise.all([ada, grace].map((p) => p.page.evaluate(() => window.__test.lastDestruction())));
      if (d.every((x) => x && x.count > 0)) sawCapture = { ply: r.ply, shards: d.map((x) => x.count) };
    }
    if (k === Math.floor(args.plies / 2)) {
      // Grace reloads mid-game: back in the same seat, with the same game.
      await grace.page.reload();
      const back = await until(async () => { try { const r2 = await room(grace); return r2 && r2.seat === 1 ? r2 : null; } catch { return null; } }, 20000);
      const same = await agree(people);
      check('after a reload the guest is back in the same seat and game', back?.seat === 1 && !!same, { ply: r.ply });
    }
  }
  check(`${report.moves.length} plies played, every page agreeing after each`, report.moves.length >= Math.min(args.plies, 10) && !disagreed, { plies: report.moves.length });
  if (captured) check('a capture shattered on both players\' pages', !!sawCapture, sawCapture || { captured });
  else console.log('· no capture in these plies: the shattering was not checked');

  // A draw: Ada offers; Grace says no to the question, thinks again, and accepts from ☰.
  let s = await st(ada);
  if (!s.over) {
    await ada.page.click('#btn-menu');
    await ada.page.getByRole('button', { name: /Offer a draw/ }).click();
    await grace.page.getByRole('button', { name: 'Accept the draw' }).waitFor({ timeout: 10000 });
    await grace.page.getByRole('button', { name: 'Cancel' }).click();
    const plate = await until(async () => /Offers a draw/.test(await grace.page.locator('#ai-status').textContent()), 5000);
    check('the plate says a draw is offered', !!plate);
    let drawn = null;
    for (let tries = 0; tries < 3 && !drawn; tries++) {
      // An op on its way when the connection drops is lost (p3p2 sends it once): then it is given again.
      if (tries) issues.push({ type: 'note', text: 'an accept did not arrive, and was sent again from the menu' });
      await grace.page.click('#btn-menu');
      await grace.page.getByRole('button', { name: /Accept the draw/ }).click();
      drawn = await agree(people, 6000, (all) => all.every((x) => x.over));
    }
    check('a draw offered on one page is accepted from the menu on the other', drawn && drawn.every((x) => x.result.status === 'agreement'),
      drawn ? {} : { pages: await Promise.all(people.map(async (p) => { const x = await st(p); return { who: p.name, over: x.over, phase: x.phase, overlay: x.overlay, offer: x.room?.offer, ply: x.ply }; })) });
  }

  // The next game: colours change.
  const n1 = (await room(ada)).n;
  await ada.page.getByRole('button', { name: /Rematch|Play again/ }).waitFor({ timeout: 10000 });
  await ada.page.getByRole('button', { name: /Rematch|Play again/ }).click();
  const next = await until(async () => { const r = await room(ada); return r && r.n === n1 + 1 ? r : null; }, 10000);
  await until(async () => (await room(grace)).n === n1 + 1, 10000);
  for (const p of people) await p.page.getByRole('button', { name: /View board/ }).click({ timeout: 2000 }).catch(() => {});
  check('the next game swaps colours', next?.seat === 1 && (await room(grace)).seat === 0);

  // Grace (now white) plays two plies, then resigns.
  for (let k = 0; k < 2; k++) { const r = await playOne(people, [players[0], players[1], null], rng); if (r) report.moves.push(r.uci); }
  await grace.page.click('#btn-menu');
  await grace.page.getByRole('button', { name: /Resign/ }).click();
  await grace.page.getByRole('button', { name: 'Resign', exact: true }).click();
  const resigned = await agree(people, 15000, (all) => all.every((x) => x.over));
  check('resigning ends the game on every page', resigned && resigned.every((x) => x.result.status === 'resignation' && x.result.winner === 1));
  for (const p of people) await p.page.getByRole('button', { name: /View board/ }).click({ timeout: 2000 }).catch(() => {});

  // Ada gives up her seat, and Lin takes it.
  await ada.page.click('#btn-menu');
  await ada.page.getByRole('button', { name: /Give up my seat/ }).click();
  await until(async () => (await room(lin)).seats.includes(null), 10000);
  await lin.page.click('#btn-menu');
  await lin.page.getByRole('button', { name: /Take the free seat/ }).click();
  const seated = await until(async () => { const r = await room(lin); return r && r.seat !== -1 ? r : null; }, 10000);
  check('a watcher takes a seat given up', !!seated, { seat: seated?.seat });

  // Ada leaves: the title is back, with her game against the AI.
  await ada.page.click('#btn-people');
  await ada.page.getByRole('button', { name: 'Leave', exact: true }).click();
  await ada.page.locator('.overlay[data-name="title"]').waitFor({ timeout: 10000 });
  const cont = ada.page.getByRole('button', { name: /Continue/ });
  const hasContinue = await cont.count() === 1;
  if (hasContinue) await cont.click();
  const after = hasContinue ? await settle(ada) : null;
  check('leaving brings back the title and the game against the AI', hasContinue && after.fen === beforeRoom.fen && after.room === null);
} catch (e) {
  check('the run finished', false, { crash: String(e?.stack || e).slice(0, 1500) });
} finally {
  for (const p of people) {
    report[p.name] = { errors: p.errors };
    await p.ctx.close().catch(() => {});
  }
  await browser.close();
  game.stop();
  stopAll();
}

const errors = people.flatMap((p) => p.errors.map((e) => ({ who: p.name, ...e })));
report.finished = new Date().toISOString();
writeFileSync(`${DIR}/report.json`, JSON.stringify(report, null, 2));
const notes = issues.filter((i) => i.type === 'note');
writeFileSync(`${DIR}/report.md`, [
  `# Room playtest ${report.started}${args.lag ? ' (through the lag proxy)' : ''}`, '',
  ...checks.map((c) => `- ${c.ok ? '✓' : '✗'} ${c.check}`),
  '', `Moves: ${report.moves.join(' ')}`, '',
  `Issues: ${issues.length - notes.length ? JSON.stringify(issues.filter((i) => i.type !== 'note')).slice(0, 1500) : 'none'}`,
  `Notes: ${notes.length ? notes.map((n) => n.text + (n.resent !== undefined ? ` (resent ${n.resent}×)` : '')).join('; ') : 'none'}`,
  `Console/page errors: ${errors.length ? JSON.stringify(errors).slice(0, 1500) : 'none'}`,
].join('\n'));
const failed = checks.filter((c) => !c.ok).length;
const problems = issues.filter((i) => i.type !== 'note');
console.log(`\nReport: ${DIR}/report.md`);
console.log(failed || problems.length || errors.length ? `✗ ${failed} failed check(s), ${problems.length} issue(s), ${errors.length} error(s)` : '✓ all room checks passed');
process.exitCode = failed || problems.length || errors.length ? 1 : 0;
