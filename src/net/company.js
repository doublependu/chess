// Playing with friends: a room on a p3p2 server.
//
// The room's log is the game. Every page reads the same ops in the same order into a `Table` (`table.js`), and the
// board follows the table. A page's own move is an op like anybody's: it is played when it comes back, on every
// page at once. The room keeps the log, so a game can be left and picked up another day.
//
// On an ordinary visit (no invite in the address, no room this tab was in) nothing here asks any server anything:
// `start()` resolves at once, and the 👥 button is all there is.
import { P3P2 } from '@p3p2/client';
import { Table, TABLE_VERSION } from './table.js';

/**
 * @param ctrl the game's Controller: told when the room comes and goes, and when the table changes.
 * @param ui for toasts.
 */
export function openCompany(ctrl, ui) {
  const p3p2 = new P3P2({
    // The ops and the snapshot have a version of their own; a page that reads them differently is kept out.
    game: { id: 'sky-arena-chess', version: TABLE_VERSION },
    // No corner is free (the version is bottom left), so the panel has no button of its own: the game's 👥, beside
    // the view button, opens it, and it opens there.
    ui: { corner: 'bottom-right', button: false },
  });

  let room = null;
  let table = null;
  /** Whether the table was last started from a snapshot, for the tests: a full log was replaced by one. */
  let fromSnapshot = false;
  /** A seat this page asked for and has not seen taken yet, and whether it may still try the other one. */
  let claim = null;
  let mayRetry = true;

  const handle = {
    /** The panel: the room, the invite, chat, leaving; or, with no room, where an invite comes from. */
    open() { p3p2.open(); },
    get table() { return table; },
    get me() { return room ? room.self.pid : null; },
    /** Sends an op. While the connection is coming back, the client keeps it until it is. */
    submit(op) { return !!room && room.log.submit(op); },
    /** 'here', 'away' or 'lost' for a player in the room now; null for one who is not. */
    presence(pid) {
      const m = room?.members.find((x) => x.pid === pid);
      return m ? m.state : null;
    },
    sit(c) {
      if (!room || c < 0 || table.seats[c]) return;
      claim = { c };
      room.log.submit({ t: 'sit', c, name: room.self.name });
    },
  };

  /** Sit down if there is a seat and this page has none: on coming in, and once more if the first one went to somebody else. */
  function sitIfFree() {
    if (!room || claim || table.seatOf(handle.me) !== -1) return;
    const free = table.seats.indexOf(null);
    if (free === -1) return;
    handle.sit(free);
  }

  async function adopt(r) {
    room = r;
    table = new Table();
    claim = null;
    mayRetry = true;
    let open = false;
    await r.log.open({
      load(state) { table.load(state); fromSnapshot = state !== undefined; },
      apply(op, entry) {
        const what = table.apply(op, entry.pid);
        if (claim && op?.t === 'sit' && op.c === claim.c) {
          // The seat went: to this page, or to somebody quicker.
          const lost = entry.pid !== handle.me;
          claim = null;
          if (lost && mayRetry) { mayRetry = false; queueMicrotask(sitIfFree); }
        }
        if (open && what) changed(what, entry);
      },
      save() { return table.save(); },
    });
    if (room !== r) return;
    open = true;
    ctrl.enterRoom(handle);
    sitIfFree();
    for (const ev of ['member-join', 'member-leave', 'member-state']) r.on(ev, () => ctrl.roomHud());
  }

  /** A change to the table, as it happens: the board catches up, and the people are told what it was. */
  function changed(what, entry) {
    ctrl.follow();
    const name = (c) => table.names[c] || (c === 0 ? 'White' : 'Black');
    const side = (c) => (c === 0 ? 'white' : 'black');
    const mine = entry.pid === handle.me;
    switch (what.t) {
      case 'sit':
        if (!mine) ui.toast(`${name(what.c)} plays ${side(what.c)}`);
        break;
      case 'stand':
        if (!mine) ui.toast(what.lost ? `${entry.from?.name || 'A player'} gave up the seat, and the game` : `${entry.from?.name || 'A player'} gave up the seat`);
        break;
      case 'offer':
        if (!mine) ctrl.offered(what.c);
        else ui.toast('Draw offered');
        break;
      case 'new':
        ui.toast(`Game ${what.n}: ${name(0)} plays white`);
        break;
      default:
    }
  }

  p3p2.on('room', adopt);
  p3p2.on('leave', () => {
    room = null;
    table = null;
    claim = null;
    ctrl.leaveRoom();
  });
  // Back into the room after a reload, or the library's own "Join?" for a page opened from an invite.
  p3p2.start().catch(() => { /* no room, then; the AI is still there */ });

  // For the browser tests (dev builds, or ?test=1): ops as the page would send them, without the taps, to fill a
  // log quickly; and what the page knows of the room.
  if (window.__test) {
    window.__test.room = {
      submit: (op) => handle.submit(op),
      table: () => (table ? { ...table.save(), fingerprint: table.fingerprint(), status: table.game.result.status, fromSnapshot } : null),
      seat: () => (table ? table.seatOf(handle.me) : null),
    };
  }
  return handle;
}
