// A tiny opening book for variety. Lines are UCI move sequences from the start position.
const LINES = [
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7', // Ruy Lopez
  'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6', // Italian
  'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8e7', // Two Knights, quiet
  'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 b1c3 f8b4', // Scotch
  'e2e4 e7e5 g1f3 d7d6 d2d4 g8f6 b1c3 b8d7', // Philidor
  'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4', // Petrov
  'e2e4 e7e5 f2f4 e5f4 g1f3 g7g5', // King's Gambit
  'e2e4 e7e5 b1c3 g8f6 f2f4 d7d5', // Vienna
  'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6', // Najdorf
  'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5', // Sveshnikov
  'e2e4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7', // Closed Sicilian
  'e2e4 c7c5 c2c3 g8f6 e4e5 f6d5 d2d4 c5d4', // Alapin
  'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7', // French Classical
  'e2e4 e7e6 d2d4 d7d5 e4e5 c7c5 c2c3 b8c6', // French Advance
  'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5', // Caro-Kann
  'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6', // Scandinavian
  'e2e4 g8f6 e4e5 f6d5 d2d4 d7d6', // Alekhine
  'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6', // Pirc
  'e2e4 g7g6 d2d4 f8g7 b1c3 d7d6', // Modern
  'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7', // QGD
  'd2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6', // QGA
  'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4', // Slav
  'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8', // King's Indian
  'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8', // Nimzo-Indian
  'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6 g2g3 c8b7', // Queen's Indian
  'd2d4 g8f6 c2c4 c7c5 d4d5 e7e6 b1c3 e6d5 c4d5 d7d6', // Benoni
  'd2d4 d7d5 g1f3 g8f6 c1f4 e7e6 e2e3 c7c5', // London
  'd2d4 f7f5 g2g3 g8f6 f1g2 g7g6', // Dutch
  'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 d7d5', // English
  'g1f3 d7d5 g2g3 g8f6 f1g2 e7e6 e1g1 f8e7', // Reti
];

const BOOK = new Map();
for (const line of LINES) {
  const moves = line.split(' ');
  for (let i = 0; i < moves.length; i++) {
    const key = moves.slice(0, i).join(' ');
    if (!BOOK.has(key)) BOOK.set(key, new Map());
    const next = BOOK.get(key);
    next.set(moves[i], (next.get(moves[i]) || 0) + 1);
  }
}

export const BOOK_LINES = LINES;

/** Returns a book move (UCI) for the history, or null. */
export function bookMove(history, rng) {
  const next = BOOK.get(history.join(' '));
  if (!next) return null;
  let total = 0;
  for (const w of next.values()) total += w;
  let r = rng() * total;
  for (const [m, w] of next) { r -= w; if (r <= 0) return m; }
  return null;
}
