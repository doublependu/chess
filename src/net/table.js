// The table in a room: who sits where, who waits to play next, and the game being played on it.
//
// Built from the room's log alone, one op at a time, in the log's order, so every page that reads the same log has
// the same table. An op that is not valid here (a move out of turn, a seat that is taken, a second move for the same
// ply) is ignored, and is ignored by every page alike. Nothing in here touches the screen or the network: who is in
// the room right now is the page's to know (company.js), and only decides which buttons it shows.
//
// Taking turns: whoever wants to play and finds both seats taken gets in line. When a game is over and somebody is
// waiting, the next game sends the loser to the back of the line and the first in line sits down in that seat; the
// winner stays. After a draw, the one who has sat longer goes. With nobody waiting, the same two play on, changing
// colours, as before there was a line.
import { Game, RESULT } from '../core/game.js';

/**
 * The format of the ops and the snapshot. A page with another one is kept out of the room (`game.version`).
 * 2: the line, `since`, `finished`, and the ops `line`, `unline` and `skip`. A v2 table reads v1 snapshots and logs
 * as v1 did: nobody is in line in them, and without a line nothing turns.
 */
export const TABLE_VERSION = '2';

/** At most this many finished games are remembered, to keep the snapshot small. */
const HISTORY = 50;
/** At most this many in line: more than a room holds (16 by default). */
export const LINE_MAX = 32;

/** The seed of game `n`: the same on every page, so that pieces shatter alike for everybody. */
export function seedOf(n) {
  return Math.imul(n ^ 0x5bd1e995, 0x9e3779b1) >>> 0;
}

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const isSeat = (c) => c === 0 || c === 1;
const isCount = (n) => Number.isInteger(n) && n >= 0;
const isPid = (p) => typeof p === 'string' && p.length > 0;
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '') || 'Player';

export class Table {
  constructor(state) {
    this.load(state);
  }

  /** Starts over from a snapshot (`save()`'s output), or from an empty table. Anything malformed: an empty table. */
  load(state) {
    this.n = 1;
    this.seats = [null, null];
    this.names = ['', ''];
    this.moves = [];
    this.ended = null;
    this.offer = null;
    this.history = [];
    /** Who waits to play, first first: `{ pid, name }`. */
    this.line = [];
    /** The game in which each seat's player sat down: the lower, the longer they have sat. */
    this.since = [1, 1];
    /** Who sat where when the game ended (null while it goes on): the next game sends one of them to the line. */
    this.finished = null;
    const s = state && typeof state === 'object' ? state : null;
    if (s && isCount(s.n) && s.n >= 1 && Array.isArray(s.seats) && Array.isArray(s.moves) && s.moves.every((u) => typeof u === 'string')) {
      this.n = s.n;
      this.seats = [0, 1].map((c) => (isPid(s.seats[c]) ? s.seats[c] : null));
      this.names = [0, 1].map((c) => (this.seats[c] ? cleanName(s.names?.[c]) : ''));
      this.moves = s.moves.slice();
      this.ended = s.ended && isSeat(s.ended.by) && (s.ended.how === 'resign' || s.ended.how === 'agreed') ? { ...s.ended } : null;
      this.offer = s.offer && isSeat(s.offer.by) && isCount(s.offer.ply) ? { ...s.offer } : null;
      this.history = Array.isArray(s.history) ? s.history.slice(-HISTORY) : [];
      // A v1 snapshot has none of these: nobody in line, both sat down together.
      const seen = new Set(this.seats);
      this.line = (Array.isArray(s.line) ? s.line : [])
        .filter((e) => e && isPid(e.pid) && !seen.has(e.pid) && (seen.add(e.pid), true))
        .slice(0, LINE_MAX)
        .map((e) => ({ pid: e.pid, name: cleanName(e.name) }));
      this.since = [0, 1].map((c) => (isCount(s.since?.[c]) && s.since[c] >= 1 && s.since[c] <= this.n ? s.since[c] : this.n));
      this.finished = Array.isArray(s.finished) ? [0, 1].map((c) => (isPid(s.finished[c]) ? s.finished[c] : null)) : null;
    }
    this.game = this.replay();
    if (this.game.over && !this.finished) this.finished = this.seats.slice();
    if (!this.game.over) this.finished = null;
  }

  /** The table as JSON, for a snapshot. */
  save() {
    return {
      n: this.n, seats: this.seats.slice(), names: this.names.slice(), moves: this.moves.slice(), ended: this.ended, offer: this.offer,
      history: this.history.slice(), line: this.line.map((e) => ({ ...e })), since: this.since.slice(), finished: this.finished && this.finished.slice(),
    };
  }

  /** The game on the table, from its moves. A move that will not play (a snapshot from elsewhere) ends the list there. */
  replay() {
    const game = new Game({ seed: seedOf(this.n) });
    const played = [];
    for (const uci of this.moves) {
      try { game.play(uci); played.push(uci); } catch { break; }
    }
    this.moves = played;
    if (this.ended?.how === 'resign') game.resign(this.ended.by);
    else if (this.ended?.how === 'agreed') game.agree();
    return game;
  }

  /** A game of its own with the table's moves and end: to show, and to animate further, without touching the table's. */
  copy() {
    const game = new Game({ seed: seedOf(this.n) });
    for (const uci of this.moves) game.play(uci);
    if (this.ended?.how === 'resign') game.resign(this.ended.by);
    else if (this.ended?.how === 'agreed') game.agree();
    return game;
  }

  /** The seat of a player: 0 white, 1 black, or -1 for somebody who watches. */
  seatOf(pid) {
    return pid ? this.seats.indexOf(pid) : -1;
  }

  /** A player's place in line: 0 for the first, or -1 for somebody not in it. */
  placeOf(pid) {
    return pid ? this.line.findIndex((e) => e.pid === pid) : -1;
  }

  get over() { return this.game.over; }
  get turn() { return this.game.turn; }

  /**
   * The seat whose player goes to the line when the next game starts, if somebody is waiting: the loser; after a
   * draw, the one who has sat longer (and if they sat down together, the one who had white). -1 when nobody goes:
   * nobody waits, the game is not over or had no moves, or that player got up already.
   */
  leaving() {
    if (!this.line.length || !this.over || !this.moves.length || !this.finished) return -1;
    const r = this.game.result;
    const c = r.winner !== null ? r.winner ^ 1 : this.since[1] < this.since[0] ? 1 : 0;
    return this.finished[c] && this.seats[c] === this.finished[c] ? c : -1;
  }

  /**
   * One op from the log, sent by player `pid`. Returns what happened, for the page to show, or null when the op
   * changed nothing. `filled`, when there, lists the seats that the first in line took because of it.
   */
  apply(op, pid) {
    if (!op || typeof op !== 'object' || !isPid(pid)) return null;
    const what = this.change(op, pid);
    if (!what) return null;
    // A free seat never waits while somebody does.
    const filled = this.fill();
    if (filled.length) what.filled = filled;
    return what;
  }

  change(op, pid) {
    const mine = this.seatOf(pid);
    switch (op.t) {
      case 'sit': {
        if (!isSeat(op.c) || this.seats[op.c] || mine !== -1) return null;
        // With people waiting, a seat is the first one's.
        if (this.line.length && this.line[0].pid !== pid) return null;
        if (this.line.length) this.line.shift();
        this.seat(op.c, pid, op.name);
        return { t: 'sit', c: op.c };
      }
      case 'stand': {
        if (mine === -1) return null;
        // Leaving a game that has begun gives it up.
        const lost = !this.over && this.moves.length > 0;
        if (lost) this.end('resign', mine);
        this.seats[mine] = null;
        this.names[mine] = '';
        return { t: 'stand', c: mine, lost };
      }
      case 'line': {
        if (mine !== -1 || this.placeOf(pid) !== -1 || this.line.length >= LINE_MAX) return null;
        this.line.push({ pid, name: cleanName(op.name) });
        return { t: 'line', pid, place: this.line.length - 1 };
      }
      case 'unline': {
        const at = this.placeOf(pid);
        if (at === -1) return null;
        this.line.splice(at, 1);
        return { t: 'unline', pid };
      }
      case 'skip': {
        // A player who is not there, while somebody waits: up to the other player, or to somebody in line, to say.
        const c = op.c;
        if (op.n !== this.n || !isSeat(c) || !this.seats[c] || !this.line.length) return null;
        if (mine !== (c ^ 1) && this.placeOf(pid) === -1) return null;
        const gone = { pid: this.seats[c], name: this.names[c] };
        const lost = !this.over && this.moves.length > 0;
        if (lost) this.end('resign', c);
        // The game that just ended has no leaver now: that seat is somebody else's already.
        this.seats[c] = null;
        this.names[c] = '';
        return { t: 'skip', c, ...gone, lost };
      }
      case 'move': {
        if (op.n !== this.n || this.over || op.ply !== this.moves.length || mine !== this.turn) return null;
        if (typeof op.uci !== 'string' || !UCI.test(op.uci)) return null;
        let rec;
        try { rec = this.game.play(op.uci); } catch { return null; }
        this.moves.push(op.uci);
        this.offer = null;
        if (this.over) this.finished = this.seats.slice();
        return { t: 'move', rec };
      }
      case 'resign': {
        if (op.n !== this.n || this.over || mine === -1) return null;
        this.end('resign', mine);
        return { t: 'resign', c: mine };
      }
      case 'offer': {
        if (op.n !== this.n || this.over || mine === -1 || op.ply !== this.moves.length) return null;
        if (this.offer && this.offer.ply === op.ply) return null;
        this.offer = { by: mine, ply: op.ply };
        return { t: 'offer', c: mine };
      }
      case 'accept': {
        if (op.n !== this.n || this.over || mine === -1 || !this.offer) return null;
        if (this.offer.ply !== op.ply || this.offer.ply !== this.moves.length || this.offer.by === mine) return null;
        this.end('agreed', mine);
        return { t: 'accept', c: mine };
      }
      case 'new': {
        // The players start it, or the first in line, who is next to play.
        if (op.n !== this.n || !(this.over || this.moves.length === 0)) return null;
        if (mine === -1 && this.placeOf(pid) !== 0) return null;
        let out = null;
        if (this.moves.length) {
          const r = this.game.result;
          this.history.push({ white: this.names[0], black: this.names[1], winner: r.winner, how: r.status, plies: this.moves.length });
          if (this.history.length > HISTORY) this.history.shift();
          const c = this.leaving();
          if (c !== -1) {
            // The first in line takes the seat; the one who leaves it goes to the back.
            const next = this.line.shift();
            out = { c, pid: this.seats[c], name: this.names[c] };
            this.line.push({ pid: out.pid, name: out.name });
            this.seat(c, next.pid, next.name, this.n + 1);
          }
        }
        // The players change colours: the one who stays plays the other side, and somebody new takes what is left.
        this.seats.reverse();
        this.names.reverse();
        this.since.reverse();
        this.n += 1;
        this.moves = [];
        this.ended = null;
        this.offer = null;
        this.finished = null;
        this.game = this.replay();
        return out ? { t: 'new', n: this.n, out } : { t: 'new', n: this.n };
      }
      default:
        return null;
    }
  }

  seat(c, pid, name, since = this.n) {
    this.seats[c] = pid;
    this.names[c] = cleanName(name);
    this.since[c] = since;
  }

  /** Free seats go to the first in line. Returns who sat where. */
  fill() {
    const filled = [];
    for (const c of [0, 1]) {
      if (this.seats[c] || !this.line.length) continue;
      const next = this.line.shift();
      this.seat(c, next.pid, next.name);
      filled.push({ c, pid: next.pid });
    }
    return filled;
  }

  end(how, by) {
    this.ended = { how, by };
    this.offer = null;
    this.finished = this.seats.slice();
    if (how === 'resign') this.game.resign(by);
    else this.game.agree();
  }

  /** What every page should agree on, for the tests: the game, the seats, the line, and the position. */
  fingerprint() {
    return `${this.n}|${this.seats.join(',')}|${this.line.map((e) => e.pid).join(',')}|${this.game.fen()}|${this.game.result.status}`;
  }
}

export { RESULT };
