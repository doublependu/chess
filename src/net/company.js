// Playing with friends: a room on a p3p2 server.
//
// The room's log is the game. Every page reads the same ops in the same order into a `Table` (`table.js`), and the
// board follows the table. A page's own move is an op like anybody's: it is played when it comes back, on every
// page at once. The room keeps the log, so a game can be left and picked up another day.
//
// More than two in the room take turns: somebody who finds both seats taken is asked whether they want to play,
// and gets in line (`table.js` has the rules). Who is here right now is the page's own knowledge, from p3p2's
// presence: it only decides when a player who is not there may be skipped, never what the table does.
//
// On an ordinary visit (no invite in the address, no room this tab was in) nothing here asks any server anything:
// `start()` resolves at once, and p3p2's button is all there is.
import { P3P2 } from '@p3p2/client';
import { Table, TABLE_VERSION } from './table.js';

/**
 * How long, in ms: a seated player who is not here before they may be skipped (before the game's first move, or
 * after its end) or replaced (in a game begun, counting as their loss); and from a game's end to the next one, when
 * somebody waits. The tests shorten them (`__test.room.timers`).
 */
export const ROOM_TIMERS = { skip: 60000, replace: 120000, next: 15000 };

/** An op that has not come back after this long went again: p3p2 sends an op once, and one on its way when the connection drops is lost. */
const RESEND_MS = 4000;

/**
 * @param ctrl the game's Controller: told when the room comes and goes, and when the table changes.
 * @param ui for toasts.
 */
export function openCompany(ctrl, ui) {
  const p3p2 = new P3P2({
    // The ops and the snapshot have a version of their own; a page that reads them differently is kept out.
    game: { id: 'sky-arena-chess', version: TABLE_VERSION },
    // p3p2's own button, as it comes: the room's head count, unread chat and the live mark are on it. ⌖ stands above
    // it (index.html), and "Play with a friend" in the menus opens the same panel.
    ui: { corner: 'bottom-right' },
  });

  let room = null;
  let table = null;
  /** Whether the table was last started from a snapshot, for the tests: a full log was replaced by one. */
  let fromSnapshot = false;
  /** A seat this page asked for and has not seen taken yet, and whether it may still try the other one. */
  let claim = null;
  let mayRetry = true;
  /** Whether this page asked its player "play or watch?" in this room already. */
  let asked = false;
  /** When each seated player was last seen not here (ms), by player id; somebody here has no entry. */
  const absent = new Map();
  let ticker = 0;
  const timers = { ...ROOM_TIMERS };

  const handle = {
    /** The panel: the room, the invite, chat, leaving; or, with no room, where an invite comes from. */
    open() { p3p2.open(); },
    get table() { return table; },
    get me() { return room ? room.self.pid : null; },
    get timers() { return timers; },
    /** Sends an op. While the connection is coming back, the client keeps it until it is. */
    submit(op) { return !!room && room.log.submit(op); },
    /** 'here', 'away' or 'lost' for a player in the room now; null for one who is not. */
    presence(pid) {
      const m = room?.members.find((x) => x.pid === pid);
      return m ? m.state : null;
    },
    /** How long a seated player has not been here, in ms: 0 for one who is. */
    absentFor(pid) {
      const t = absent.get(pid);
      return t === undefined ? 0 : Date.now() - t;
    },
    sit(c) {
      if (!room || c < 0 || table.seats[c]) return;
      claim = { c };
      room.log.submit({ t: 'sit', c, name: room.self.name });
    },
    /** Into the line, to play when a seat comes free. */
    line() {
      if (!room) return;
      watching(false);
      until({ t: 'line', name: room.self.name }, () => table.placeOf(handle.me) !== -1 || table.seatOf(handle.me) !== -1);
    },
    unline() {
      if (!room) return;
      until({ t: 'unline' }, () => table.placeOf(handle.me) === -1);
    },
    /** Skips the player in seat `c`, who is not here: the first in line takes the seat. */
    skip(c) {
      if (!room) return;
      const pid = table.seats[c];
      until({ t: 'skip', n: table.n, c }, () => table.seats[c] !== pid);
    },
  };

  /** Sends an op, and again while it has not taken effect (it is harmless twice: the table ignores the second). */
  function until(op, done) {
    const r = room;
    if (!r.log.submit(op)) { ui.toast('Not connected: try again in a moment.'); return; }
    let tries = 1;
    const again = () => {
      if (room !== r || done()) return;
      if (tries++ < 4 && r.log.submit(op)) setTimeout(again, RESEND_MS);
    };
    setTimeout(again, RESEND_MS);
  }

  /** "Just watch", remembered for this tab and room, so a reload does not ask again. */
  function watching(set) {
    const key = room && `skychess.watching:${room.server}|${room.name}`;
    try {
      if (set === undefined) return !!key && sessionStorage.getItem(key) === '1';
      if (set) sessionStorage.setItem(key, '1');
      else sessionStorage.removeItem(key);
    } catch { /* storage blocked: they are asked again after a reload */ }
    return false;
  }

  /** Sit down if there is a seat and this page has none: on coming in, and once more if the first one went to somebody else. */
  function sitIfFree() {
    if (!room || claim || table.seatOf(handle.me) !== -1 || table.line.length) return;
    const free = table.seats.indexOf(null);
    if (free === -1) return;
    handle.sit(free);
  }

  /** Both seats taken, and this player neither in one nor in line: "Do you want to play or just keep watching?" */
  function maybeAsk() {
    if (!room || asked || claim) return;
    const me = handle.me;
    if (table.seatOf(me) !== -1 || table.placeOf(me) !== -1) return;
    if (table.seats.includes(null) && !table.line.length) return;
    asked = true;
    if (watching()) return;
    ctrl.askToPlay().then((play) => {
      if (!room) return;
      if (play) handle.line();
      else watching(true);
    });
  }

  /** Who of the seated is not here, and since when; and the board's buttons that depend on it. */
  function checkPresence() {
    if (!room) return;
    for (const pid of table.seats) {
      if (!pid) continue;
      if (handle.presence(pid) === 'here') absent.delete(pid);
      else if (!absent.has(pid)) absent.set(pid, Date.now());
    }
    for (const pid of absent.keys()) if (!table.seats.includes(pid)) absent.delete(pid);
    ctrl.roomTick();
  }

  async function adopt(r) {
    room = r;
    table = new Table();
    claim = null;
    mayRetry = true;
    asked = false;
    absent.clear();
    let open = false;
    await r.log.open({
      load(state) { table.load(state); fromSnapshot = state !== undefined; },
      apply(op, entry) {
        const before = { place: table.placeOf(handle.me) };
        const what = table.apply(op, entry.pid);
        if (claim && op?.t === 'sit' && op.c === claim.c) {
          // The seat went: to this page, or to somebody quicker.
          const lost = entry.pid !== handle.me;
          claim = null;
          if (lost && mayRetry) { mayRetry = false; queueMicrotask(sitIfFree); }
          if (lost) queueMicrotask(maybeAsk);
        }
        if (open && what) changed(what, entry, before);
      },
      save() { return table.save(); },
    });
    if (room !== r) return;
    open = true;
    ctrl.enterRoom(handle);
    sitIfFree();
    maybeAsk();
    for (const ev of ['member-join', 'member-leave', 'member-state']) r.on(ev, () => { checkPresence(); ctrl.roomHud(); });
    clearInterval(ticker);
    ticker = setInterval(checkPresence, 1000);
    checkPresence();
  }

  /** A change to the table, as it happens: the board catches up, and the people are told what it was. */
  function changed(what, entry, before) {
    ctrl.follow();
    const name = (c) => table.names[c] || (c === 0 ? 'White' : 'Black');
    const side = (c) => (c === 0 ? 'white' : 'black');
    const me = handle.me;
    const mine = entry.pid === me;
    const who = entry.from?.name || 'A player';
    switch (what.t) {
      case 'sit':
        if (!mine) ui.toast(`${name(what.c)} plays ${side(what.c)}`);
        break;
      case 'stand':
        if (!mine) ui.toast(what.lost ? `${who} gave up the seat, and the game` : `${who} gave up the seat`);
        break;
      case 'line':
        if (mine) ui.toast(what.filled ? 'A seat was free: you play' : what.place === 0 ? 'You are next to play' : `You are #${what.place + 1} in line`);
        else if (!what.filled) ui.toast(`${who} wants to play next`);
        break;
      case 'skip':
        if (what.pid === me) ui.toast('You were skipped while you were away. Get back in line from ☰', 5000);
        else ui.toast(what.lost ? `${what.name} was not here: the game counts as theirs lost` : `${what.name} was not here, and was skipped`);
        break;
      case 'offer':
        if (!mine) ctrl.offered(what.c);
        else ui.toast('Draw offered');
        break;
      case 'new':
        if (what.out?.pid === me) ui.toast(`Game ${what.n}: you are at the back of the line`);
        else ui.toast(`Game ${what.n}: ${name(0)} plays white, ${name(1)} black`);
        break;
      default:
    }
    for (const f of what.filled || []) {
      if (what.t === 'line' && mine) continue;
      if (f.pid === me) ui.toast(`Your turn to play: you take ${side(f.c)}`, 4000);
      else ui.toast(`${name(f.c)} takes the ${side(f.c)} seat`);
    }
    const place = table.placeOf(me);
    if (place === 0 && before.place > 0) ui.toast('You are next to play');
    maybeAsk();
    checkPresence();
  }

  p3p2.on('room', adopt);
  p3p2.on('leave', () => {
    room = null;
    table = null;
    claim = null;
    clearInterval(ticker);
    absent.clear();
    ctrl.leaveRoom();
  });
  // Back into the room after a reload, or the library's own "Join?" for a page opened from an invite.
  p3p2.start().catch(() => { /* no room, then; the AI is still there */ });

  // For the browser tests (dev builds, or ?test=1): ops as the page would send them, without the taps, to fill a
  // log quickly; what the page knows of the room; and shorter waits.
  if (window.__test) {
    window.__test.room = {
      submit: (op) => handle.submit(op),
      table: () => (table ? { ...table.save(), fingerprint: table.fingerprint(), status: table.game.result.status, fromSnapshot } : null),
      seat: () => (table ? table.seatOf(handle.me) : null),
      timers: (t) => Object.assign(timers, t),
    };
  }
  return handle;
}
