// Shared chess constants and small helpers. 0x88 board: sq = rank * 16 + file,
// rank 0 is White's back rank, so a1 = 0x00 and h8 = 0x77.

export const WHITE = 0;
export const BLACK = 1;

export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const pieceColor = (p) => p >> 3;
export const pieceType = (p) => p & 7;
export const makePiece = (color, type) => (color << 3) | type;

// Move encoding: from | to << 7 | promo << 14 | flags << 17
export const F_CAPTURE = 1;
export const F_EP = 2;
export const F_CASTLE = 4;
export const F_DOUBLE = 8;
export const F_PROMO = 16;

export const encodeMove = (from, to, promo = 0, flags = 0) =>
  from | (to << 7) | (promo << 14) | (flags << 17);
export const moveFrom = (m) => m & 127;
export const moveTo = (m) => (m >> 7) & 127;
export const movePromo = (m) => (m >> 14) & 7;
export const moveFlags = (m) => m >>> 17;

// Castling rights bits
export const WK = 1;
export const WQ = 2;
export const BK = 4;
export const BQ = 8;

export const fileOf = (sq) => sq & 7;
export const rankOf = (sq) => sq >> 4;
export const sq64 = (sq) => (sq >> 4) * 8 + (sq & 7);
export const sq88 = (i) => ((i >> 3) << 4) | (i & 7);

export const FILES = 'abcdefgh';
export const sqName = (sq) => FILES[sq & 7] + ((sq >> 4) + 1);
export const parseSq = (s) => {
  const f = FILES.indexOf(s[0]);
  const r = s.charCodeAt(1) - 49;
  if (f < 0 || r < 0 || r > 7) return -1;
  return (r << 4) | f;
};

export const PIECE_CHARS = ' pnbrqk';
export const TYPE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const KNIGHT_OFFSETS = [33, 31, 18, 14, -14, -18, -31, -33];
export const KING_OFFSETS = [1, 15, 16, 17, -1, -15, -16, -17];
export const BISHOP_DIRS = [15, 17, -15, -17];
export const ROOK_DIRS = [1, 16, -1, -16];
