import {
  WHITE, BLACK, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  pieceColor, pieceType, makePiece,
  F_CAPTURE, F_EP, F_CASTLE, F_DOUBLE, F_PROMO, encodeMove,
  WK, WQ, BK, BQ, PIECE_CHARS, START_FEN, sqName, parseSq,
  KNIGHT_OFFSETS, KING_OFFSETS, BISHOP_DIRS, ROOK_DIRS,
} from './constants.js';

// ---- Zobrist keys (deterministic, two 32-bit halves so we never need BigInt) ----
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) | 0;
  };
}
const rnd = mulberry32(0xc0ffee);
const Z_PIECE_LO = new Int32Array(16 * 128);
const Z_PIECE_HI = new Int32Array(16 * 128);
for (let i = 0; i < Z_PIECE_LO.length; i++) { Z_PIECE_LO[i] = rnd(); Z_PIECE_HI[i] = rnd(); }
const Z_CASTLE_LO = new Int32Array(16);
const Z_CASTLE_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = rnd(); Z_CASTLE_HI[i] = rnd(); }
const Z_EP_LO = new Int32Array(8);
const Z_EP_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) { Z_EP_LO[i] = rnd(); Z_EP_HI[i] = rnd(); }
const Z_SIDE_LO = rnd();
const Z_SIDE_HI = rnd();

// Rights kept after a piece leaves or lands on a square.
const CASTLE_MASK = new Uint8Array(128).fill(15);
CASTLE_MASK[0x00] = 15 & ~WQ;
CASTLE_MASK[0x04] = 15 & ~(WK | WQ);
CASTLE_MASK[0x07] = 15 & ~WK;
CASTLE_MASK[0x70] = 15 & ~BQ;
CASTLE_MASK[0x74] = 15 & ~(BK | BQ);
CASTLE_MASK[0x77] = 15 & ~BK;

const MAX_STACK = 4096;

export class Position {
  constructor(fen = START_FEN) {
    this.board = new Int8Array(128);
    this.side = WHITE;
    this.castling = 0;
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.kings = [-1, -1];
    this.hashLo = 0;
    this.hashHi = 0;
    // Undo stack (parallel typed arrays to avoid allocation during search)
    this.sp = 0;
    this.uMove = new Int32Array(MAX_STACK);
    this.uCaptured = new Int8Array(MAX_STACK);
    this.uCastling = new Int8Array(MAX_STACK);
    this.uEp = new Int16Array(MAX_STACK);
    this.uHalf = new Int16Array(MAX_STACK);
    this.uHashLo = new Int32Array(MAX_STACK);
    this.uHashHi = new Int32Array(MAX_STACK);
    // Position history for repetition detection (current position is at index sp)
    this.hLo = new Int32Array(MAX_STACK + 1);
    this.hHi = new Int32Array(MAX_STACK + 1);
    this.setFEN(fen);
  }

  clone() {
    const p = new Position(this.toFEN());
    return p;
  }

  setFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error('Bad FEN: ' + fen);
    this.board.fill(0);
    this.kings[0] = this.kings[1] = -1;
    const rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('Bad FEN board: ' + fen);
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') { f += +ch; continue; }
        const lower = ch.toLowerCase();
        const type = PIECE_CHARS.indexOf(lower);
        if (type <= 0 || f > 7) throw new Error('Bad FEN piece: ' + fen);
        const color = ch === lower ? BLACK : WHITE;
        const sq = ((7 - r) << 4) | f;
        this.board[sq] = makePiece(color, type);
        if (type === KING) this.kings[color] = sq;
        f++;
      }
      if (f !== 8) throw new Error('Bad FEN row: ' + fen);
    }
    if (this.kings[0] < 0 || this.kings[1] < 0) throw new Error('FEN missing king: ' + fen);
    this.side = parts[1] === 'b' ? BLACK : WHITE;
    this.castling = 0;
    if (parts[2] !== '-') {
      for (const c of parts[2]) {
        if (c === 'K') this.castling |= WK;
        else if (c === 'Q') this.castling |= WQ;
        else if (c === 'k') this.castling |= BK;
        else if (c === 'q') this.castling |= BQ;
      }
    }
    // Drop rights that the board contradicts so hashing stays canonical.
    const b = this.board;
    if (b[0x04] !== makePiece(WHITE, KING)) this.castling &= ~(WK | WQ);
    if (b[0x07] !== makePiece(WHITE, ROOK)) this.castling &= ~WK;
    if (b[0x00] !== makePiece(WHITE, ROOK)) this.castling &= ~WQ;
    if (b[0x74] !== makePiece(BLACK, KING)) this.castling &= ~(BK | BQ);
    if (b[0x77] !== makePiece(BLACK, ROOK)) this.castling &= ~BK;
    if (b[0x70] !== makePiece(BLACK, ROOK)) this.castling &= ~BQ;
    this.ep = parts[3] === '-' ? -1 : parseSq(parts[3]);
    if (this.ep >= 0 && !this.epCapturePossible(this.ep, this.side)) this.ep = -1;
    this.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;
    this.sp = 0;
    this.computeHash();
    this.hLo[0] = this.hashLo;
    this.hHi[0] = this.hashHi;
  }

  computeHash() {
    let lo = 0, hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.board[sq];
      if (p) { lo ^= Z_PIECE_LO[p * 128 + sq]; hi ^= Z_PIECE_HI[p * 128 + sq]; }
    }
    lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
    if (this.side === BLACK) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
    this.hashLo = lo;
    this.hashHi = hi;
  }

  toFEN() {
    let s = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[(r << 4) | f];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        const ch = PIECE_CHARS[pieceType(p)];
        s += pieceColor(p) === WHITE ? ch.toUpperCase() : ch;
      }
      if (empty) s += empty;
      if (r) s += '/';
    }
    let c = '';
    if (this.castling & WK) c += 'K';
    if (this.castling & WQ) c += 'Q';
    if (this.castling & BK) c += 'k';
    if (this.castling & BQ) c += 'q';
    return `${s} ${this.side === WHITE ? 'w' : 'b'} ${c || '-'} ${this.ep >= 0 ? sqName(this.ep) : '-'} ${this.halfmove} ${this.fullmove}`;
  }

  // An en-passant square only counts (for hashing/repetition) if a pawn of `side` could capture onto it.
  epCapturePossible(epSq, side) {
    const pawn = makePiece(side, PAWN);
    const from1 = side === WHITE ? epSq - 15 : epSq + 15;
    const from2 = side === WHITE ? epSq - 17 : epSq + 17;
    return (!(from1 & 0x88) && this.board[from1] === pawn) || (!(from2 & 0x88) && this.board[from2] === pawn);
  }

  isAttacked(sq, by) {
    const b = this.board;
    // Pawns
    if (by === WHITE) {
      const wp = makePiece(WHITE, PAWN);
      if (!((sq - 15) & 0x88) && b[sq - 15] === wp) return true;
      if (!((sq - 17) & 0x88) && b[sq - 17] === wp) return true;
    } else {
      const bp = makePiece(BLACK, PAWN);
      if (!((sq + 15) & 0x88) && b[sq + 15] === bp) return true;
      if (!((sq + 17) & 0x88) && b[sq + 17] === bp) return true;
    }
    const kn = makePiece(by, KNIGHT);
    for (let i = 0; i < 8; i++) {
      const t = sq + KNIGHT_OFFSETS[i];
      if (!(t & 0x88) && b[t] === kn) return true;
    }
    const kg = makePiece(by, KING);
    for (let i = 0; i < 8; i++) {
      const t = sq + KING_OFFSETS[i];
      if (!(t & 0x88) && b[t] === kg) return true;
    }
    const bi = makePiece(by, BISHOP), rk = makePiece(by, ROOK), qn = makePiece(by, QUEEN);
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_DIRS[i];
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) { if (p === bi || p === qn) return true; break; }
        t += d;
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_DIRS[i];
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) { if (p === rk || p === qn) return true; break; }
        t += d;
      }
    }
    return false;
  }

  inCheck(side = this.side) {
    return this.isAttacked(this.kings[side], side ^ 1);
  }

  // Pseudo-legal move generation into `out` (a plain array). Returns count added.
  generate(out, capturesOnly = false) {
    const b = this.board;
    const us = this.side, them = us ^ 1;
    const start = out.length;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (!p || pieceColor(p) !== us) continue;
      const type = pieceType(p);
      if (type === PAWN) {
        const dir = us === WHITE ? 16 : -16;
        const rank = sq >> 4;
        const promoRank = us === WHITE ? 6 : 1;
        const startRank = us === WHITE ? 1 : 6;
        const one = sq + dir;
        // Pushes
        if (!(one & 0x88) && !b[one]) {
          if (rank === promoRank) {
            for (let pr = QUEEN; pr >= KNIGHT; pr--) out.push(encodeMove(sq, one, pr, F_PROMO));
          } else if (!capturesOnly) {
            out.push(encodeMove(sq, one));
            const two = one + dir;
            if (rank === startRank && !b[two]) out.push(encodeMove(sq, two, 0, F_DOUBLE));
          }
        }
        // Captures
        for (let k = 0; k < 2; k++) {
          const t = sq + dir + (k ? 1 : -1);
          if (t & 0x88) continue;
          const tp = b[t];
          if (tp && pieceColor(tp) === them) {
            if (rank === promoRank) {
              for (let pr = QUEEN; pr >= KNIGHT; pr--) out.push(encodeMove(sq, t, pr, F_PROMO | F_CAPTURE));
            } else out.push(encodeMove(sq, t, 0, F_CAPTURE));
          } else if (t === this.ep) {
            out.push(encodeMove(sq, t, 0, F_EP | F_CAPTURE));
          }
        }
        continue;
      }
      if (type === KNIGHT || type === KING) {
        const offs = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (let i = 0; i < 8; i++) {
          const t = sq + offs[i];
          if (t & 0x88) continue;
          const tp = b[t];
          if (!tp) { if (!capturesOnly) out.push(encodeMove(sq, t)); }
          else if (pieceColor(tp) === them) out.push(encodeMove(sq, t, 0, F_CAPTURE));
        }
        if (type === KING && !capturesOnly) this.genCastles(out, sq);
        continue;
      }
      // Sliders
      if (type === BISHOP || type === QUEEN) this.genSlides(out, sq, BISHOP_DIRS, them, capturesOnly);
      if (type === ROOK || type === QUEEN) this.genSlides(out, sq, ROOK_DIRS, them, capturesOnly);
    }
    return out.length - start;
  }

  genSlides(out, sq, dirs, them, capturesOnly) {
    const b = this.board;
    for (let i = 0; i < 4; i++) {
      const d = dirs[i];
      let t = sq + d;
      while (!(t & 0x88)) {
        const tp = b[t];
        if (!tp) { if (!capturesOnly) out.push(encodeMove(sq, t)); }
        else { if (pieceColor(tp) === them) out.push(encodeMove(sq, t, 0, F_CAPTURE)); break; }
        t += d;
      }
    }
  }

  genCastles(out, ksq) {
    const b = this.board, us = this.side, them = us ^ 1;
    if (us === WHITE) {
      if (ksq !== 0x04) return;
      if ((this.castling & WK) && !b[0x05] && !b[0x06] &&
        !this.isAttacked(0x04, them) && !this.isAttacked(0x05, them) && !this.isAttacked(0x06, them)) {
        out.push(encodeMove(0x04, 0x06, 0, F_CASTLE));
      }
      if ((this.castling & WQ) && !b[0x03] && !b[0x02] && !b[0x01] &&
        !this.isAttacked(0x04, them) && !this.isAttacked(0x03, them) && !this.isAttacked(0x02, them)) {
        out.push(encodeMove(0x04, 0x02, 0, F_CASTLE));
      }
    } else {
      if (ksq !== 0x74) return;
      if ((this.castling & BK) && !b[0x75] && !b[0x76] &&
        !this.isAttacked(0x74, them) && !this.isAttacked(0x75, them) && !this.isAttacked(0x76, them)) {
        out.push(encodeMove(0x74, 0x76, 0, F_CASTLE));
      }
      if ((this.castling & BQ) && !b[0x73] && !b[0x72] && !b[0x71] &&
        !this.isAttacked(0x74, them) && !this.isAttacked(0x73, them) && !this.isAttacked(0x72, them)) {
        out.push(encodeMove(0x74, 0x72, 0, F_CASTLE));
      }
    }
  }

  // Returns false (and leaves the position unchanged) if the move leaves our king in check.
  makeMove(m) {
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flags = m >>> 17;
    const b = this.board;
    const us = this.side, them = us ^ 1;
    const piece = b[from];
    const sp = this.sp;
    this.uMove[sp] = m;
    this.uCastling[sp] = this.castling;
    this.uEp[sp] = this.ep;
    this.uHalf[sp] = this.halfmove;
    this.uHashLo[sp] = this.hashLo;
    this.uHashHi[sp] = this.hashHi;

    let lo = this.hashLo, hi = this.hashHi;
    lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }

    let captured = EMPTY;
    if (flags & F_EP) {
      const capSq = us === WHITE ? to - 16 : to + 16;
      captured = b[capSq];
      b[capSq] = EMPTY;
      lo ^= Z_PIECE_LO[captured * 128 + capSq]; hi ^= Z_PIECE_HI[captured * 128 + capSq];
    } else {
      captured = b[to];
      if (captured) { lo ^= Z_PIECE_LO[captured * 128 + to]; hi ^= Z_PIECE_HI[captured * 128 + to]; }
    }
    this.uCaptured[sp] = captured;

    lo ^= Z_PIECE_LO[piece * 128 + from]; hi ^= Z_PIECE_HI[piece * 128 + from];
    b[from] = EMPTY;
    const placed = promo ? makePiece(us, promo) : piece;
    b[to] = placed;
    lo ^= Z_PIECE_LO[placed * 128 + to]; hi ^= Z_PIECE_HI[placed * 128 + to];

    if (flags & F_CASTLE) {
      let rf, rt;
      if (to > from) { rf = from + 3; rt = from + 1; } else { rf = from - 4; rt = from - 1; }
      const rook = b[rf];
      b[rf] = EMPTY; b[rt] = rook;
      lo ^= Z_PIECE_LO[rook * 128 + rf] ^ Z_PIECE_LO[rook * 128 + rt];
      hi ^= Z_PIECE_HI[rook * 128 + rf] ^ Z_PIECE_HI[rook * 128 + rt];
    }
    if (pieceType(piece) === KING) this.kings[us] = to;

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    this.ep = -1;
    if (flags & F_DOUBLE) {
      const epSq = (from + to) >> 1;
      if (this.epCapturePossible(epSq, them)) this.ep = epSq;
    }
    this.halfmove = (pieceType(piece) === PAWN || captured) ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.side = them;

    lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
    lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI;
    this.hashLo = lo; this.hashHi = hi;
    this.sp = sp + 1;
    this.hLo[sp + 1] = lo; this.hHi[sp + 1] = hi;

    if (this.isAttacked(this.kings[us], them)) { this.unmakeMove(); return false; }
    return true;
  }

  unmakeMove() {
    const sp = --this.sp;
    const m = this.uMove[sp];
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flags = m >>> 17;
    const b = this.board;
    const them = this.side, us = them ^ 1;
    let piece = b[to];
    if (promo) piece = makePiece(us, PAWN);
    b[from] = piece;
    b[to] = EMPTY;
    const captured = this.uCaptured[sp];
    if (flags & F_EP) b[us === WHITE ? to - 16 : to + 16] = captured;
    else b[to] = captured;
    if (flags & F_CASTLE) {
      let rf, rt;
      if (to > from) { rf = from + 3; rt = from + 1; } else { rf = from - 4; rt = from - 1; }
      b[rf] = b[rt]; b[rt] = EMPTY;
    }
    if (pieceType(piece) === KING) this.kings[us] = from;
    this.side = us;
    this.castling = this.uCastling[sp];
    this.ep = this.uEp[sp];
    this.halfmove = this.uHalf[sp];
    this.hashLo = this.uHashLo[sp];
    this.hashHi = this.uHashHi[sp];
    if (us === BLACK) this.fullmove--;
  }

  makeNull() {
    const sp = this.sp;
    this.uMove[sp] = 0;
    this.uCaptured[sp] = 0;
    this.uCastling[sp] = this.castling;
    this.uEp[sp] = this.ep;
    this.uHalf[sp] = this.halfmove;
    this.uHashLo[sp] = this.hashLo;
    this.uHashHi[sp] = this.hashHi;
    if (this.ep >= 0) { this.hashLo ^= Z_EP_LO[this.ep & 7]; this.hashHi ^= Z_EP_HI[this.ep & 7]; }
    this.ep = -1;
    this.hashLo ^= Z_SIDE_LO; this.hashHi ^= Z_SIDE_HI;
    this.side ^= 1;
    this.halfmove++;
    this.sp = sp + 1;
    this.hLo[sp + 1] = this.hashLo; this.hHi[sp + 1] = this.hashHi;
  }

  unmakeNull() {
    const sp = --this.sp;
    this.side ^= 1;
    this.ep = this.uEp[sp];
    this.halfmove = this.uHalf[sp];
    this.hashLo = this.uHashLo[sp];
    this.hashHi = this.uHashHi[sp];
  }

  legalMoves() {
    const pseudo = [];
    this.generate(pseudo);
    const legal = [];
    for (const m of pseudo) {
      if (this.makeMove(m)) { legal.push(m); this.unmakeMove(); }
    }
    return legal;
  }

  // Number of earlier occurrences of the current position within the reversible window.
  repetitions() {
    let count = 0;
    const sp = this.sp, lo = this.hashLo, hi = this.hashHi;
    const limit = Math.max(0, sp - this.halfmove);
    for (let i = sp - 2; i >= limit; i -= 2) {
      if (this.hLo[i] === lo && this.hHi[i] === hi) count++;
    }
    return count;
  }

  insufficientMaterial() {
    const b = this.board;
    let minors = 0, bishopsLight = 0, bishopsDark = 0, knights = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (!p) continue;
      const t = pieceType(p);
      if (t === KING) continue;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      minors++;
      if (t === KNIGHT) knights++;
      else if ((((sq >> 4) + (sq & 7)) & 1) === 0) bishopsDark++;
      else bishopsLight++;
    }
    if (minors <= 1) return true;
    // Only bishops, all on the same colour complex.
    if (knights === 0 && (bishopsLight === 0 || bishopsDark === 0)) return true;
    return false;
  }

  // Non-pawn material of `side` (used by null-move pruning).
  hasPieces(side) {
    const b = this.board;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (p && pieceColor(p) === side) {
        const t = pieceType(p);
        if (t !== PAWN && t !== KING) return true;
      }
    }
    return false;
  }
}

export function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = [];
  pos.generate(moves);
  let n = 0;
  for (const m of moves) {
    if (!pos.makeMove(m)) continue;
    n += depth === 1 ? 1 : perft(pos, depth - 1);
    pos.unmakeMove();
  }
  return n;
}
