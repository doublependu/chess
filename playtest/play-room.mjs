// Chess with friends, played for real: the production build, a p3p2 server, and four people in one room. A host on
// a desktop (white), a guest on a phone (black, by touch), and two more who find both seats taken: one gets in line,
// one only watches. They all come in by the room's invite link from the server's portal, and take turns: the loser
// goes to the back of the line, somebody who is not there is skipped. Writes a report and videos to
// playtest-output/room-* (gitignored).
//
// Needs a p3p2 server. By default one is started from the p3p2 checkout next to this one (../p3p2), in memory:
//   npm run playtest:room
//   node playtest/play-room.mjs --p3p2 ~/src/p3p2           # another checkout
//   P3P2_OWNER_PASSWORD=… node playtest/play-room.mjs --server http://localhost:8080   # one already running
//   node playtest/play-room.mjs --lag                        # through p3p2's lag proxy: 150 ms ± 50 each way, one cut
//   node playtest/play-room.mjs --plies 30 --headed --no-video
import { writeFileSync } from 'node:fs';
import { p3p2Server, lagProxy, createRoom, roomOf, stopAll } from './rooms.mjs';
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
/** The same invite through another port of its server: the lag proxy's. */
const through = (invite, port) => invite.replace(/([?&]room=[^&#]*:)\d+\//, `$1${port}/`);

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
  const close = p.page.locator('p3p2-panel').getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible().catch(() => false)) await close.click();
}

/** p3p2's own multiplayer button, bottom right (the stand-in before the panel's code is loaded, or the panel's). */
const p3p2Button = (p) => p.page.locator('p3p2-panel button[aria-label^="Multiplayer"]').filter({ visible: true }).first();

/** "Do you want to play or just keep watching?": answers it. */
async function answer(p, play) {
  const b = p.page.getByRole('button', { name: play ? /Play: get in line/ : /^👁 Just watch$/ });
  await b.waitFor({ timeout: 10000 });
  await b.click();
}

/** The waits in a room, short enough for a test: the next game, and skipping somebody who is not there. */
const TIMERS = { next: 3000, skip: 3000, replace: 30000 };
const shortTimers = (p) => p.page.evaluate((t) => window.__test.room.timers(t), TIMERS);

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
/** Everybody who came, for the report: `people` loses whoever closes their page. */
const everybody = [];
try {
  const server = await p3p2Server({ server: args.server, p3p2: args.p3p2, port: args.port });
  const gameUrl = game.url;
  let invite = await createRoom(browser, server, gameUrl);
  if (args.lag) invite = through(invite, await lagProxy(server, args.port + 1));
  check('the portal made a room for the game, and its invite', !!roomOf(invite), { invite });

  const ada = await person(browser, 'desktop', 'Ada');
  const grace = await person(browser, 'pixel5', 'Grace');
  const lin = await person(browser, 'desktop', 'Lin');
  const mo = await person(browser, 'desktop', 'Mo');
  people = [ada, grace, lin, mo];
  everybody.push(...people);

  // Ada plays the AI first, so there is an autosave to come back to after the room.
  await openGame(ada.page, gameUrl, { settings: SETTINGS });
  check('the title has the p3p2.me hint', await ada.page.locator('.overlay[data-name="title"] .hint a[href="https://p3p2.me/#start"]').count() === 1);
  await ada.page.getByRole('button', { name: /Play White/ }).click();
  await settle(ada);
  await playMove(ada.page, 'e2e4');
  await until(async () => (await st(ada)).ply >= 2, 15000);
  await settle(ada);
  const beforeRoom = await st(ada);

  // Ada opens the invite in the same tab: everybody joins by it, the room's owner too. The first one in hosts.
  await openFromInvite(ada, invite);
  const adaRoom = await until(async () => { const r = await room(ada); return r && r.seat === 0 ? r : null; }, 15000);
  check('the host takes white', adaRoom?.seat === 0, { invite });
  check('in a room, the checkpoint buttons go', await ada.page.locator('#hud-actions-top').isHidden());
  await p3p2Button(ada).click();
  const passOn = await ada.page.getByLabel('Invite link', { exact: true }).inputValue();
  check("p3p2's own button opens the panel, which passes on the room's invite", roomOf(passOn) === roomOf(invite), { passOn });
  await closePanel(ada);
  await shortTimers(ada);

  await openFromInvite(grace, invite);
  const graceRoom = await until(async () => { const r = await room(grace); return r && r.seat === 1 ? r : null; }, 15000);
  check('the guest from the invite takes black (on a phone)', graceRoom?.seat === 1);
  await shortTimers(grace);
  // On the phone, in a room (the button shows a head count now): still in its corner, clear of ⌖ and the plates.
  const corner = await grace.page.evaluate(() => {
    const r = (el) => el && el.getBoundingClientRect();
    const b = r(document.querySelector('p3p2-panel')), clear = ['btn-view', 'p-you', 'p-ai', 'room-note'].map((id) => r(document.getElementById(id)));
    const hit = clear.some((c) => c && c.width && b.x < c.right && c.x < b.right && b.y < c.bottom && c.y < b.bottom);
    return { inside: b.right <= innerWidth && b.bottom <= innerHeight && b.width > 0, hit };
  });
  check("in a room, on the phone, p3p2's button is in its corner and clear of the HUD", corner.inside && !corner.hit, corner);

  // Lin finds both seats taken, is asked, and gets in line; Mo only watches.
  await openFromInvite(lin, invite);
  await answer(lin, true);
  const linRoom = await until(async () => { const r = await room(lin); return r && r.place === 0 ? r : null; }, 15000);
  check('the third one is asked "play or watch?", and gets in line', linRoom?.seat === -1 && linRoom?.place === 0, linRoom ? { line: linRoom.line } : {});
  await shortTimers(lin);
  await openFromInvite(mo, invite);
  await answer(mo, false);
  const moRoom = await until(() => room(mo), 15000);
  check('the fourth one chooses to watch: not in line', moRoom?.seat === -1 && moRoom?.place === -1 && moRoom.line.length === 1);
  await shortTimers(mo);
  check("the watcher's note on the HUD says who plays next", /Watching · Next: Lin/.test(await mo.page.locator('#room-note').textContent()));
  const agreed0 = await agree(people);
  check('all four pages start from the same table', !!agreed0, { fingerprint: agreed0?.[0].room.fingerprint });
  check('the plates name the players', (await grace.page.locator('#p-you .name').textContent()).includes('Grace') && (await grace.page.locator('#p-ai .name').textContent()).includes('Ada'));

  // Out of turn, and watching, a tap does nothing. White is to move: Grace and Lin try.
  await tapSquare(grace.page, 'e7', { touch: true }); await grace.page.waitForTimeout(150); await tapSquare(grace.page, 'e5', { touch: true });
  await tapSquare(lin.page, 'd2'); await lin.page.waitForTimeout(150); await tapSquare(lin.page, 'd4');
  await new Promise((r) => setTimeout(r, 1200));
  check('a tap out of turn, or by a watcher, does nothing', (await st(ada)).room.moves.length === 0 && (await st(grace)).room.sent === null);

  // The game: a club player on each side, and every page agreeing after every move.
  const rng = mulberry32(args.seed);
  const players = [new PersonaPlayer(PERSONAS.club, mulberry32(args.seed + 1)), new PersonaPlayer(PERSONAS.casual, mulberry32(args.seed + 2)), null, null];
  /** The persona of whoever sits in seat c: Ada's and Grace's play on whichever page sits there. */
  const byPage = (all) => people.map((p, k) => (all[k].room.seat === -1 ? null : players[all[k].room.seat]));
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
      await shortTimers(grace);
    }
  }
  check(`${report.moves.length} plies played, every page agreeing after each`, report.moves.length >= Math.min(args.plies, 10) && !disagreed, { plies: report.moves.length });
  if (captured) check('a capture shattered on both players\' pages', !!sawCapture, sawCapture || { captured });
  else console.log('· no capture in these plies: the shattering was not checked');

  // Mo reloads: having said "just watch", Mo is not asked again.
  await mo.page.reload();
  await until(async () => { try { return await room(mo); } catch { return null; } }, 20000);
  await closePanel(mo);
  await mo.page.waitForTimeout(1500);
  check('after a reload, "just watch" is not asked again', (await mo.page.evaluate(() => window.__test.overlay())) !== 'ask');
  await shortTimers(mo);

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
  } else {
    issues.push({ type: 'note', text: `the game ended by itself (${s.result.status}) before the draw offer` });
  }

  // Somebody waits, so the next game starts by itself. After a draw between two who sat down together, white (Ada)
  // goes to the back of the line; Grace stays and changes colour, and Lin comes in.
  const n1 = (await room(ada)).n;
  const told = await until(async () => /Next game: .*to the back of the line/.test(await ada.page.locator('.overlay[data-name="over"]').textContent().catch(() => '')), 10000);
  check('the game-over box says who plays next, and who goes to the line', !!told);
  const game2 = await agree(people, 20000, (all) => all.every((x) => x.room.n === n1 + 1));
  const r2 = game2 && Object.fromEntries(people.map((p, k) => [p.name, game2[k].room]));
  const expect2 = s.over ? null : { white: 'Grace', black: 'Lin', line: ['Ada'] };
  check('with somebody waiting, the next game starts by itself; the loser goes to the back of the line, the winner stays',
    !!r2 && (!expect2 || (r2.Grace.seat === 0 && r2.Lin.seat === 1 && r2.Ada.place === 0 && r2.Ada.line.join() === 'Ada')),
    r2 ? { seats: r2.Ada.names, line: r2.Ada.line } : {});
  for (const p of people) await p.page.getByRole('button', { name: /View board/ }).click({ timeout: 2000 }).catch(() => {});

  // Game 2: two plies, then black resigns: black loses, white stays, and Ada (first in line) starts the next one herself.
  for (let k = 0; k < 2; k++) {
    const all = await agree(people);
    const r = all && await playOne(people, byPage(all), rng);
    if (r) report.moves.push(r.uci);
  }
  const black2 = people.find((p) => r2 && r2[p.name].seat === 1) || lin;
  const white2 = people.find((p) => r2 && r2[p.name].seat === 0) || grace;
  // This time nobody's clock starts it: the first in line does.
  for (const p of people) await p.page.evaluate(() => window.__test.room.timers({ next: 60000 }));
  await black2.page.click('#btn-menu');
  await black2.page.getByRole('button', { name: /Resign/ }).click();
  await black2.page.getByRole('button', { name: 'Resign', exact: true }).click();
  const resigned = await agree(people, 15000, (all) => all.every((x) => x.over));
  check('resigning ends the game on every page', resigned && resigned.every((x) => x.result.status === 'resignation' && x.result.winner === 0));
  const start = ada.page.getByRole('button', { name: /Start now/ });
  const canStart = await start.waitFor({ timeout: 10000 }).then(() => true, () => false);
  check('the first in line may start the next game ("Start now")', canStart);
  if (canStart) await start.click();
  const game3 = await agree(people, 15000, (all) => all.every((x) => x.room.n === n1 + 2));
  const r3 = game3 && Object.fromEntries(people.map((p, k) => [p.name, game3[k].room]));
  check('the winner stays and changes colour; the newcomer plays the other side; the loser is at the back',
    !!r3 && r3.Ada.seat === 0 && r3[white2.name].seat === 1 && r3[black2.name].place === 0, r3 ? { names: r3.Ada.names, line: r3.Ada.line } : {});
  for (const p of people) await p.page.getByRole('button', { name: /View board/ }).click({ timeout: 2000 }).catch(() => {});
  for (const p of people) await shortTimers(p);

  // Mo changes their mind and gets in line from ☰: second, behind the loser.
  await mo.page.click('#btn-menu');
  await mo.page.getByRole('button', { name: /Get in line/ }).click();
  const moLine = await until(async () => { const r = await room(mo); return r && r.place === 1 ? r : null; }, 10000);
  check('a watcher gets in line from the menu, at the back', !!moLine, moLine ? { line: moLine.line } : {});
  check("the note on the HUD shows the watcher's place", /#2 in line/.test(await mo.page.locator('#room-note').textContent()));

  // Game 3 has not begun. Its black player closes the page: after a while the other player (Ada) may skip them, and
  // the first in line sits down for the same game.
  const gone = people.find((p) => r3 && r3[p.name].seat === 1) || white2;
  const firstInLine = people.find((p) => r3 && r3[p.name].place === 0) || black2;
  await gone.ctx.close();
  people = people.filter((p) => p !== gone);
  const skipBtn = ada.page.getByRole('button', { name: new RegExp(`Skip ${gone.name}`) });
  const offered = await until(async () => {
    await ada.page.click('#btn-menu');
    if (await skipBtn.isVisible().catch(() => false)) return true;
    await ada.page.keyboard.press('Escape');
    return false;
  }, 20000, 1000);
  check('a player who is not there may be skipped by the other player, once somebody waits', !!offered);
  if (offered) await skipBtn.click();
  const skipped = await agree(people, 15000, (all) => all.every((x) => x.room.seats[1] && x.room.names[1] !== gone.name));
  const rs = skipped && Object.fromEntries(people.map((p, k) => [p.name, skipped[k].room]));
  check('the first in line takes the seat of the one skipped, who is not put in line',
    !!rs && rs[firstInLine.name].seat === 1 && !rs.Ada.line.includes(gone.name), rs ? { names: rs.Ada.names, line: rs.Ada.line } : {});

  // Ada gives up her seat before a move: Mo, first in line now, takes it at once.
  await ada.page.click('#btn-menu');
  await ada.page.getByRole('button', { name: /Give up my seat/ }).click();
  const seated = await until(async () => { const r = await room(mo); return r && r.seat !== -1 ? r : null; }, 10000);
  check('a seat given up goes to the first in line', !!seated, { seat: seated?.seat });

  // Ada leaves: the title is back, with her game against the AI.
  await p3p2Button(ada).click();
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
  for (const p of everybody) {
    report[p.name] = { errors: p.errors };
    await p.ctx.close().catch(() => {});
  }
  await browser.close();
  game.stop();
  stopAll();
}

const errors = everybody.flatMap((p) => p.errors.map((e) => ({ who: p.name, ...e })));
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
