import { describe, it, expect } from 'vitest';
import { Brain, positionFrom } from '../src/ai/brain.js';
import { Searcher } from '../src/ai/search.js';
import { evaluate } from '../src/ai/eval.js';
import { strengthParams, pickMove, mulberry32 } from '../src/ai/strength.js';
import { BOOK_LINES } from '../src/ai/book.js';
import { winPercent, moveAccuracy, updateAfterGame, newPlayerModel, expectedScore } from '../src/ai/skill.js';
import { Director, gameBaseElo } from '../src/ai/director.js';
import { Game } from '../src/core/game.js';
import { Position } from '../src/core/position.js';
import { moveToUci } from '../src/core/notation.js';

describe('evaluation', () => {
  it('is symmetric', () => {
    const fens = [
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    ];
    const mirror = (fen) => {
      const [board, side, castle] = fen.split(' ');
      const rows = board.split('/').reverse().map((r) => r.replace(/[a-z]/gi, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())));
      const c2 = castle === '-' ? '-' : castle.replace(/[a-z]/gi, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).split('').sort().join('');
      return `${rows.join('/')} ${side === 'w' ? 'b' : 'w'} ${c2} - 0 1`;
    };
    for (const f of fens) {
      expect(evaluate(new Position(f))).toBe(evaluate(new Position(mirror(f))));
    }
  });
  it('likes extra material', () => {
    expect(evaluate(new Position('4k3/8/8/8/8/8/8/3QK3 w - - 0 1'))).toBeGreaterThan(800);
  });
});

describe('search', () => {
  it('finds mate in one', () => {
    const s = new Searcher(16);
    const pos = new Position('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    const r = s.search(pos, { maxDepth: 4 });
    expect(moveToUci(r.move)).toBe('d1d8');
  });
  it('finds mate in two', () => {
    const s = new Searcher(16);
    // 1. Qh6+?? no — classic: 1.Qxh7+? Use a known two-mover: White Qg6, Kf6 vs Kh8: 1.Qg7#? (that's one).
    const pos = new Position('r1bq2r1/b4pk1/p1pp1p2/1p2pP2/1P2P1PB/3P4/1PPQ2P1/R3K2R w - - 0 1');
    const r = s.search(pos, { maxDepth: 6, timeMs: 10000 });
    expect(moveToUci(r.move)).toBe('d2h6');
  });
  it('wins a hanging queen', () => {
    const s = new Searcher(16);
    const pos = new Position('rnb1kbnr/pppp1ppp/8/4p1q1/4P3/3P4/PPP2PPP/RNBQKBNR w KQkq - 1 3');
    const r = s.search(pos, { maxDepth: 4 });
    expect(moveToUci(r.move)).toBe('c1g5');
  });
  it('respects node budgets', () => {
    const s = new Searcher(16);
    const r = s.search(new Position(), { maxNodes: 5000 });
    expect(r.nodes).toBeLessThan(7000);
    expect(r.move).not.toBe(0);
  });
});

describe('brain', () => {
  it('always returns legal moves across strengths', () => {
    const brain = new Brain(16);
    for (const elo of [300, 700, 1200, 1700, 2100]) {
      const g = new Game({ seed: elo });
      for (let i = 0; i < 16 && !g.over; i++) {
        const r = brain.chooseMove({ moves: g.uciList(), elo, seed: 7 + i });
        expect(g.legalUcis()).toContain(r.uci);
        g.play(r.uci);
      }
    }
  }, 60000);
  it('book lines are legal', () => {
    for (const line of BOOK_LINES) {
      expect(() => Game.fromMoves(line.split(' '))).not.toThrow();
    }
  });
  it('analyze reports a big advantage after a blunder', () => {
    const brain = new Brain(16);
    // Black to move can take a free queen on h4? Position after 1.e4 e5 2.Qh5 Nc6 3.Qxe5+?? no: use direct FEN.
    const r = brain.analyze({ startFen: 'rnb1kbnr/pppp1ppp/8/4p1q1/4P3/3P4/PPP2PPP/RNBQKBNR w KQkq - 1 3', moves: [] });
    expect(r.score).toBeGreaterThan(600);
  });
  it('positionFrom rejects illegal histories', () => {
    expect(() => positionFrom(undefined, ['e2e5'])).toThrow();
  });
});

describe('strength', () => {
  it('params are monotonic', () => {
    let prev = strengthParams(300);
    for (let e = 400; e <= 2400; e += 100) {
      const p = strengthParams(e);
      expect(p.maxNodes).toBeGreaterThanOrEqual(prev.maxNodes);
      expect(p.temperature).toBeLessThanOrEqual(prev.temperature);
      expect(p.window).toBeLessThanOrEqual(prev.window);
      prev = p;
    }
  });
  it('pickMove stays inside the window', () => {
    const scored = [{ move: 1, score: 100 }, { move: 2, score: 90 }, { move: 3, score: -400 }];
    const rng = mulberry32(3);
    const params = strengthParams(1500);
    for (let i = 0; i < 200; i++) expect(pickMove(scored, params, rng).move).not.toBe(3);
  });
});

describe('skill model', () => {
  it('win percent and accuracy', () => {
    expect(winPercent(0)).toBeCloseTo(50);
    expect(winPercent(300)).toBeGreaterThan(70);
    expect(moveAccuracy(50, 60)).toBe(100);
    expect(moveAccuracy(0, -900)).toBeLessThan(20);
    expect(moveAccuracy(0, -30)).toBeGreaterThan(85);
  });
  it('rating moves toward results', () => {
    const start = newPlayerModel().rating;
    let m = newPlayerModel();
    for (let i = 0; i < 5; i++) m = updateAfterGame(m, { aiElo: start, score: 1 });
    expect(m.rating).toBeGreaterThan(start + 150);
    let m2 = newPlayerModel();
    for (let i = 0; i < 5; i++) m2 = updateAfterGame(m2, { aiElo: start, score: 0 });
    expect(m2.rating).toBeLessThan(start - 150);
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5);
  });
});

describe('director', () => {
  it('eases off when far ahead and caps fight-back', () => {
    const d = new Director(1200);
    let e = 0;
    for (let i = 0; i < 10; i++) e = d.moveElo(900);
    expect(e).toBeLessThan(1050);
    const d2 = new Director(1200);
    for (let i = 0; i < 10; i++) e = d2.moveElo(-900);
    expect(e).toBeLessThanOrEqual(1280);
    expect(e).toBeGreaterThan(1200);
  });
  it('streak breaker lowers after losses', () => {
    const base = gameBaseElo({ rating: 1200, history: [] });
    const lower = gameBaseElo({ rating: 1200, history: [{ score: 0 }, { score: 0 }, { score: 0 }] });
    expect(lower).toBeLessThan(base - 150);
  });
  it('resigns only after a sustained hopeless position, and never at beginner level', () => {
    const d = new Director(1300);
    for (let i = 0; i < 3; i++) expect(d.shouldResign(-1500)).toBe(false);
    expect(d.shouldResign(-1500)).toBe(true);
    const weak = new Director(700);
    for (let i = 0; i < 10; i++) expect(weak.shouldResign(-2000)).toBe(false);
  });
  it('converts decided games instead of easing off', () => {
    const d = new Director(1000);
    let e = 0;
    for (let i = 0; i < 12; i++) e = d.moveElo(1800);
    expect(e).toBeGreaterThanOrEqual(1050);
  });
  it('the weakest level still sees stalemate', () => {
    const brain = new Brain(16);
    // White to move: Qb6?? would stalemate; any weak engine must avoid it.
    for (let seed = 1; seed < 30; seed++) {
      const r = brain.chooseMove({ startFen: 'k7/8/2Q5/8/8/8/8/1K6 w - - 0 1', elo: 300, seed, useBook: false });
      if (r.oversight) continue;
      expect(r.uci).not.toBe('c6b6');
    }
  });
  it('serializes', () => {
    const d = new Director(1300, 2);
    d.moveElo(500);
    d.observeHumanMove(20, -10);
    const d2 = Director.fromJSON(JSON.parse(JSON.stringify(d)));
    expect(d2.toJSON()).toEqual(d.toJSON());
  });
});
