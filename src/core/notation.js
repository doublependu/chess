import {
  PAWN, KING, pieceType, moveFrom, moveTo, movePromo, moveFlags,
  F_CAPTURE, F_CASTLE, PIECE_CHARS, sqName, parseSq,
} from './constants.js';

export function moveToUci(m) {
  const promo = movePromo(m);
  return sqName(moveFrom(m)) + sqName(moveTo(m)) + (promo ? PIECE_CHARS[promo] : '');
}

// Finds the legal move matching a UCI string, or 0.
export function uciToMove(pos, uci) {
  if (typeof uci !== 'string' || uci.length < 4) return 0;
  const from = parseSq(uci.slice(0, 2));
  const to = parseSq(uci.slice(2, 4));
  const promo = uci.length > 4 ? PIECE_CHARS.indexOf(uci[4].toLowerCase()) : 0;
  for (const m of pos.legalMoves()) {
    if (moveFrom(m) === from && moveTo(m) === to && movePromo(m) === promo) return m;
  }
  return 0;
}

// SAN for a legal move in `pos` (position before the move). `legal` may be passed to avoid regenerating.
export function moveToSan(pos, m, legal = pos.legalMoves()) {
  const from = moveFrom(m), to = moveTo(m), flags = moveFlags(m), promo = movePromo(m);
  const piece = pos.board[from];
  const type = pieceType(piece);
  let san;
  if (flags & F_CASTLE) {
    san = to > from ? 'O-O' : 'O-O-O';
  } else if (type === PAWN) {
    san = (flags & F_CAPTURE) ? sqName(from)[0] + 'x' + sqName(to) : sqName(to);
    if (promo) san += '=' + PIECE_CHARS[promo].toUpperCase();
  } else {
    san = PIECE_CHARS[type].toUpperCase();
    if (type !== KING) {
      let sameFile = false, sameRank = false, ambiguous = false;
      for (const o of legal) {
        if (o === m || moveTo(o) !== to || moveFrom(o) === from) continue;
        if (pieceType(pos.board[moveFrom(o)]) !== type) continue;
        ambiguous = true;
        if ((moveFrom(o) & 7) === (from & 7)) sameFile = true;
        if ((moveFrom(o) >> 4) === (from >> 4)) sameRank = true;
      }
      if (ambiguous) {
        if (!sameFile) san += sqName(from)[0];
        else if (!sameRank) san += sqName(from)[1];
        else san += sqName(from);
      }
    }
    if (flags & F_CAPTURE) san += 'x';
    san += sqName(to);
  }
  if (pos.makeMove(m)) {
    if (pos.inCheck()) san += pos.legalMoves().length === 0 ? '#' : '+';
    pos.unmakeMove();
  }
  return san;
}

export function sanToMove(pos, san) {
  const clean = san.replace(/[+#!?]/g, '').replace(/0/g, 'O').trim();
  const legal = pos.legalMoves();
  for (const m of legal) {
    if (moveToSan(pos, m, legal).replace(/[+#]/g, '') === clean) return m;
  }
  // Be lenient with "e8Q" style promotions and long algebraic.
  const uciLike = clean.replace(/[x=-]/g, '').toLowerCase();
  for (const m of legal) if (moveToUci(m) === uciLike) return m;
  return 0;
}
