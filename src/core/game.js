import { Position } from './position.js';
import { moveToUci, uciToMove, moveToSan } from './notation.js';
import {
  WHITE, BLACK, PAWN, KING, pieceType, pieceColor, moveFrom, moveTo, movePromo, moveFlags,
  F_CAPTURE, F_EP, F_CASTLE, sqName, START_FEN, TYPE_NAMES,
} from './constants.js';

export function hash32(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

export const RESULT = {
  PLAYING: 'playing',
  CHECKMATE: 'checkmate',
  STALEMATE: 'stalemate',
  THREEFOLD: 'threefold',
  FIFTY: 'fifty-move rule',
  INSUFFICIENT: 'insufficient material',
  RESIGN: 'resignation',
  AGREED: 'agreement',
};

/**
 * The authoritative game state. The 3D scene is only a projection of this.
 */
export class Game {
  constructor({ seed = (Math.random() * 2 ** 32) >>> 0, startFen = START_FEN } = {}) {
    this.seed = seed >>> 0;
    this.startFen = startFen;
    this.pos = new Position(startFen);
    /** @type {ReturnType<Game['describe']>[]} */
    this.records = [];
    this.result = { status: RESULT.PLAYING, winner: null };
    this.resigned = null;
    this.agreed = false;
  }

  static fromMoves(uciList, opts = {}) {
    const g = new Game(opts);
    for (const u of uciList) g.play(u);
    return g;
  }

  get turn() { return this.pos.side; }
  get ply() { return this.records.length; }
  get over() { return this.result.status !== RESULT.PLAYING; }
  fen() { return this.pos.toFEN(); }
  uciList() { return this.records.map((r) => r.uci); }

  legalMoves() {
    if (this.over) return [];
    return this.pos.legalMoves();
  }

  legalUcis() { return this.legalMoves().map(moveToUci); }

  pieceAt(name) {
    const sqIdx = (name.charCodeAt(1) - 49) * 16 + (name.charCodeAt(0) - 97);
    const p = this.pos.board[sqIdx];
    return p ? { type: pieceType(p), color: pieceColor(p) } : null;
  }

  // All pieces as {square, type, color}
  pieces() {
    const out = [];
    const b = this.pos.board;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (b[sq]) out.push({ square: sqName(sq), type: pieceType(b[sq]), color: pieceColor(b[sq]) });
    }
    return out;
  }

  describe(m, legal) {
    const pos = this.pos;
    const from = moveFrom(m), to = moveTo(m), flags = moveFlags(m);
    const piece = pos.board[from];
    const color = pieceColor(piece);
    let captured = null;
    if (flags & F_EP) {
      const capSq = color === WHITE ? to - 16 : to + 16;
      captured = { type: PAWN, color: color ^ 1, square: sqName(capSq) };
    } else if (flags & F_CAPTURE) {
      const cp = pos.board[to];
      captured = { type: pieceType(cp), color: pieceColor(cp), square: sqName(to) };
    }
    let castle = null;
    if (flags & F_CASTLE) {
      const kingSide = to > from;
      const rf = kingSide ? from + 3 : from - 4;
      const rt = kingSide ? from + 1 : from - 1;
      castle = { rookFrom: sqName(rf), rookTo: sqName(rt), side: kingSide ? 'king' : 'queen' };
    }
    const san = moveToSan(pos, m, legal);
    return {
      ply: this.records.length,
      uci: moveToUci(m),
      san,
      color,
      piece: pieceType(piece),
      pieceName: TYPE_NAMES[pieceType(piece)],
      from: sqName(from),
      to: sqName(to),
      captured,
      promotion: movePromo(m),
      castle,
      enPassant: !!(flags & F_EP),
      check: san.endsWith('+') || san.endsWith('#'),
      mate: san.endsWith('#'),
      seed: hash32(this.seed, this.records.length),
      move: m,
    };
  }

  /** Plays a UCI move. Returns the move record, or throws on illegal input. */
  play(uci) {
    if (this.over) throw new Error('Game is over');
    const legal = this.pos.legalMoves();
    const m = uciToMove(this.pos, uci);
    if (!m) throw new Error('Illegal move: ' + uci + ' in ' + this.fen());
    const rec = this.describe(m, legal);
    this.pos.makeMove(m);
    this.records.push(rec);
    this.updateResult();
    rec.result = { ...this.result };
    return rec;
  }

  undo() {
    if (!this.records.length) return null;
    if (this.resigned !== null) this.resigned = null;
    this.agreed = false;
    const rec = this.records.pop();
    this.pos.unmakeMove();
    this.updateResult();
    return rec;
  }

  resign(color) {
    this.resigned = color;
    this.result = { status: RESULT.RESIGN, winner: color ^ 1 };
  }

  /** A draw both players agreed to (only between two people: the AI never offers one). */
  agree() {
    this.agreed = true;
    this.result = { status: RESULT.AGREED, winner: null };
  }

  updateResult() {
    if (this.resigned !== null) {
      this.result = { status: RESULT.RESIGN, winner: this.resigned ^ 1 };
      return;
    }
    if (this.agreed) {
      this.result = { status: RESULT.AGREED, winner: null };
      return;
    }
    const pos = this.pos;
    const legal = pos.legalMoves();
    if (legal.length === 0) {
      this.result = pos.inCheck()
        ? { status: RESULT.CHECKMATE, winner: pos.side ^ 1 }
        : { status: RESULT.STALEMATE, winner: null };
    } else if (pos.insufficientMaterial()) {
      this.result = { status: RESULT.INSUFFICIENT, winner: null };
    } else if (pos.halfmove >= 100) {
      this.result = { status: RESULT.FIFTY, winner: null };
    } else if (pos.repetitions() >= 2) {
      this.result = { status: RESULT.THREEFOLD, winner: null };
    } else {
      this.result = { status: RESULT.PLAYING, winner: null };
    }
  }

  inCheck() { return this.pos.inCheck(); }
  kingSquare(color) { return sqName(this.pos.kings[color]); }

  // Material balance from White's view in pawns (for HUD).
  material() {
    const val = [0, 1, 3, 3, 5, 9, 0];
    let s = 0;
    for (const p of this.pieces()) s += (p.color === WHITE ? 1 : -1) * val[p.type];
    return s;
  }

  capturedBy(color) {
    return this.records.filter((r) => r.captured && r.color === color).map((r) => r.captured.type);
  }
}

export { WHITE, BLACK, KING };
