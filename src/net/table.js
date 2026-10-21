// The table in a room: who sits where, and the game being played on it.
//
// Built from the room's log alone, one op at a time, in the log's order, so every page that reads the same log has
// the same table. An op that is not valid here (a move out of turn, a seat that is taken, a second move for the same
// ply) is ignored, and is ignored by every page alike. Nothing in here touches the screen or the network.
import { Game, RESULT } from '../core/game.js';

/** The format of the ops and the snapshot. A page with another one is kept out of the room (`game.version`). */
export const TABLE_VERSION = '1';

/** At most this many finished games are remembered, to keep the snapshot small. */
const HISTORY = 50;

/** The seed of game `n`: the same on every page, so that pieces shatter alike for everybody. */
export function seedOf(n) {
  return Math.imul(n ^ 0x5bd1e995, 0x9e3779b1) >>> 0;
}

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const isSeat = (c) => c === 0 || c === 1;
const isCount = (n) => Number.isInteger(n) && n >= 0;
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
    const s = state && typeof state === 'object' ? state : null;
    if (s && isCount(s.n) && s.n >= 1 && Array.isArray(s.seats) && Array.isArray(s.moves) && s.moves.every((u) => typeof u === 'string')) {
      this.n = s.n;
      this.seats = [0, 1].map((c) => (typeof s.seats[c] === 'string' ? s.seats[c] : null));
      this.names = [0, 1].map((c) => (this.seats[c] ? cleanName(s.names?.[c]) : ''));
      this.moves = s.moves.slice();
      this.ended = s.ended && isSeat(s.ended.by) && (s.ended.how === 'resign' || s.ended.how === 'agreed') ? { ...s.ended } : null;
      this.offer = s.offer && isSeat(s.offer.by) && isCount(s.offer.ply) ? { ...s.offer } : null;
      this.history = Array.isArray(s.history) ? s.history.slice(-HISTORY) : [];
    }
    this.game = this.replay();
  }

  /** The table as JSON, for a snapshot. */
  save() {
    return { n: this.n, seats: this.seats.slice(), names: this.names.slice(), moves: this.moves.slice(), ended: this.ended, offer: this.offer, history: this.history.slice() };
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

  get over() { return this.game.over; }
  get turn() { return this.game.turn; }

  /**
   * One op from the log, sent by player `pid`. Returns what happened, for the page to show, or null when the op
   * changed nothing.
   */
  apply(op, pid) {
    if (!op || typeof op !== 'object' || typeof pid !== 'string' || !pid) return null;
    const mine = this.seatOf(pid);
    switch (op.t) {
      case 'sit': {
        if (!isSeat(op.c) || this.seats[op.c] || mine !== -1) return null;
        this.seats[op.c] = pid;
        this.names[op.c] = cleanName(op.name);
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
      case 'move': {
        if (op.n !== this.n || this.over || op.ply !== this.moves.length || mine !== this.turn) return null;
        if (typeof op.uci !== 'string' || !UCI.test(op.uci)) return null;
        let rec;
        try { rec = this.game.play(op.uci); } catch { return null; }
        this.moves.push(op.uci);
        this.offer = null;
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
        if (op.n !== this.n || mine === -1 || !(this.over || this.moves.length === 0)) return null;
        if (this.moves.length) {
          const r = this.game.result;
          this.history.push({ white: this.names[0], black: this.names[1], winner: r.winner, how: r.status, plies: this.moves.length });
          if (this.history.length > HISTORY) this.history.shift();
        }
        // The players change colours.
        this.seats.reverse();
        this.names.reverse();
        this.n += 1;
        this.moves = [];
        this.ended = null;
        this.offer = null;
        this.game = this.replay();
        return { t: 'new', n: this.n };
      }
      default:
        return null;
    }
  }

  end(how, by) {
    this.ended = { how, by };
    this.offer = null;
    if (how === 'resign') this.game.resign(by);
    else this.game.agree();
  }

  /** What every page should agree on, for the tests: the game, the seats, and the position. */
  fingerprint() {
    return `${this.n}|${this.seats.join(',')}|${this.game.fen()}|${this.game.result.status}`;
  }
}

export { RESULT };
