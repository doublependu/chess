import { describe, it, expect } from 'vitest';
import { Position, perft } from '../src/core/position.js';
import { moveToSan, sanToMove, moveToUci } from '../src/core/notation.js';
import { Game, RESULT } from '../src/core/game.js';
import { START_FEN, WHITE, BLACK } from '../src/core/constants.js';

// Reference numbers: https://www.chessprogramming.org/Perft_Results
const PERFT = [
  { name: 'start', fen: START_FEN, counts: [20, 400, 8902, 197281, 4865609] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', counts: [48, 2039, 97862, 4085603] },
  { name: 'pos3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', counts: [14, 191, 2812, 43238, 674624] },
  { name: 'pos4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', counts: [6, 264, 9467, 422333] },
  { name: 'pos4-mirrored', fen: 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1', counts: [6, 264, 9467, 422333] },
  { name: 'pos5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', counts: [44, 1486, 62379, 2103487] },
  { name: 'pos6', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', counts: [46, 2079, 89890, 3894594] },
];

describe('perft', () => {
  for (const { name, fen, counts } of PERFT) {
    it(name, () => {
      const pos = new Position(fen);
      const before = pos.toFEN();
      const hash = [pos.hashLo, pos.hashHi];
      counts.forEach((expected, i) => {
        expect(perft(pos, i + 1), `${name} depth ${i + 1}`).toBe(expected);
      });
      // make/unmake must restore everything
      expect(pos.toFEN()).toBe(before);
      expect([pos.hashLo, pos.hashHi]).toEqual(hash);
    }, 120000);
  }
});

describe('hashing', () => {
  it('incremental hash equals recomputed hash through random games', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let g = 0; g < 20; g++) {
      const pos = new Position();
      for (let i = 0; i < 120; i++) {
        const moves = pos.legalMoves();
        if (!moves.length) break;
        pos.makeMove(moves[Math.floor(rnd() * moves.length)]);
        const lo = pos.hashLo, hi = pos.hashHi;
        pos.computeHash();
        expect([pos.hashLo, pos.hashHi]).toEqual([lo, hi]);
      }
    }
  });
});

describe('FEN', () => {
  it('round-trips', () => {
    for (const { fen } of PERFT) {
      const p = new Position(fen);
      const again = new Position(p.toFEN());
      expect(again.toFEN()).toBe(p.toFEN());
    }
  });
  it('drops en-passant square when no capture is possible', () => {
    const g = Game.fromMoves(['e2e4']);
    expect(g.fen()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  });
  it('keeps en-passant square when a capture is possible', () => {
    const g = Game.fromMoves(['e2e4', 'a7a6', 'e4e5', 'd7d5']);
    expect(g.fen().split(' ')[3]).toBe('d6');
  });
});

describe('SAN', () => {
  it('disambiguates and annotates', () => {
    const pos = new Position('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const sans = pos.legalMoves().map((m) => moveToSan(pos, m));
    expect(sans).toContain('O-O');
    expect(sans).toContain('O-O-O');
    expect(sans).toContain('Rxa8+');
    const p2 = new Position('7k/8/8/8/8/8/1N3N2/K7 w - - 0 1');
    const s2 = p2.legalMoves().map((m) => moveToSan(p2, m));
    expect(s2).toContain('Nbd3');
    expect(s2).toContain('Nfd3');
    const p3 = new Position('7k/8/8/1N6/8/1N6/8/K7 w - - 0 1');
    const s3 = p3.legalMoves().map((m) => moveToSan(p3, m));
    expect(s3).toContain('N5d4');
    expect(s3).toContain('N3d4');
  });
  it('parses SAN', () => {
    const pos = new Position();
    expect(moveToUci(sanToMove(pos, 'Nf3'))).toBe('g1f3');
    expect(moveToUci(sanToMove(pos, 'e4'))).toBe('e2e4');
  });
  it('promotion SAN', () => {
    const pos = new Position('7k/P7/8/8/8/8/8/K7 w - - 0 1');
    const sans = pos.legalMoves().map((m) => moveToSan(pos, m));
    expect(sans).toEqual(expect.arrayContaining(['a8=Q+', 'a8=N', 'a8=R+', 'a8=B']));
  });
});

describe('game rules', () => {
  it("detects fool's mate", () => {
    const g = Game.fromMoves(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(g.result).toEqual({ status: RESULT.CHECKMATE, winner: BLACK });
    expect(g.records[3].san).toBe('Qh4#');
    expect(g.legalMoves()).toEqual([]);
  });
  it('detects stalemate', () => {
    const g = new Game({ startFen: 'k7/8/1Q6/8/8/8/8/K7 w - - 0 1' });
    g.play('b6c7');
    expect(g.result.status).toBe(RESULT.STALEMATE);
  });
  it('detects threefold repetition', () => {
    const g = Game.fromMoves(['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1']);
    expect(g.result.status).toBe(RESULT.PLAYING);
    g.play('f6g8');
    expect(g.result.status).toBe(RESULT.THREEFOLD);
  });
  it('detects insufficient material', () => {
    const g = new Game({ startFen: 'k7/8/8/8/8/8/1q6/KB6 w - - 0 1' });
    g.play('a1b2');
    expect(g.result.status).toBe(RESULT.INSUFFICIENT);
    const g2 = new Game({ startFen: 'k1b5/8/8/8/8/8/8/K1B5 w - - 0 1' });
    g2.updateResult();
    expect(g2.result.status).toBe(RESULT.PLAYING); // opposite-coloured bishops: not automatically drawn
    const g3 = new Game({ startFen: 'k1b5/8/8/8/8/8/8/KB6 w - - 0 1' });
    g3.updateResult();
    expect(g3.result.status).toBe(RESULT.INSUFFICIENT); // same-coloured bishops
  });
  it('detects fifty-move rule', () => {
    const g = new Game({ startFen: 'k7/8/8/8/8/8/8/KR6 w - - 99 80' });
    g.play('b1b2');
    expect(g.result.status).toBe(RESULT.FIFTY);
  });
  it('cannot castle through check', () => {
    const g = new Game({ startFen: 'r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1' });
    expect(g.legalUcis()).not.toContain('e1g1');
    expect(g.legalUcis()).toContain('e1c1');
  });
  it('handles en passant with a pinned pawn', () => {
    // The e5 pawn may not capture en passant because it would expose the king on the 5th rank.
    const g = new Game({ startFen: '8/8/8/K2pP2r/8/8/8/7k w - d6 0 1' });
    expect(g.legalUcis()).not.toContain('e5d6');
  });
  it('records captures, castles, promotions and en passant', () => {
    const g = Game.fromMoves(['e2e4', 'd7d5', 'e4d5']);
    expect(g.records[2].captured).toEqual({ type: 1, color: BLACK, square: 'd5' });
    const g2 = Game.fromMoves(['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
    expect(g2.records[4].enPassant).toBe(true);
    expect(g2.records[4].captured.square).toBe('d5');
    const g3 = new Game({ startFen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
    const rec = g3.play('e1g1');
    expect(rec.castle).toEqual({ rookFrom: 'h1', rookTo: 'f1', side: 'king' });
    const g4 = new Game({ startFen: '1r5k/P7/8/8/8/8/8/K7 w - - 0 1' });
    const promo = g4.play('a7b8q');
    expect(promo.promotion).toBe(5);
    expect(promo.captured.type).toBe(4);
  });
  it('undo restores state', () => {
    const g = Game.fromMoves(['e2e4', 'e7e5', 'g1f3']);
    const fen = g.fen();
    g.play('b8c6');
    g.undo();
    expect(g.fen()).toBe(fen);
    expect(g.turn).toBe(BLACK);
    while (g.undo());
    expect(g.fen()).toBe(START_FEN);
    expect(g.turn).toBe(WHITE);
  });
  it('rejects illegal moves', () => {
    const g = new Game();
    expect(() => g.play('e2e5')).toThrow();
    expect(() => g.play('xx')).toThrow();
  });
});
