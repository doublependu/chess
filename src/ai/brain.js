// The AI player, independent of threads: used by the Web Worker and by the Node balance simulation.
import { Position } from '../core/position.js';
import { uciToMove, moveToUci } from '../core/notation.js';
import { START_FEN, moveFlags, F_CAPTURE } from '../core/constants.js';
import { Searcher, MATE } from './search.js';
import { strengthParams, pickMove, mulberry32 } from './strength.js';
import { bookMove } from './book.js';

const clampScore = (s) => (s > MATE - 500 ? 3000 : s < -MATE + 500 ? -3000 : s);

export function positionFrom(startFen = START_FEN, moves = []) {
  const pos = new Position(startFen);
  for (const u of moves) {
    const m = uciToMove(pos, u);
    if (!m) throw new Error('Illegal move in history: ' + u);
    pos.makeMove(m);
  }
  return pos;
}

export class Brain {
  constructor(ttBits = 18) {
    this.searcher = new Searcher(ttBits);
  }

  /**
   * Chooses a move for the side to move at the given strength.
   * @returns {{uci: string|null, score: number, depth: number, nodes: number, book: boolean, elo: number}}
   */
  chooseMove({ startFen = START_FEN, moves = [], elo = 1200, seed = 1, useBook = true }) {
    const pos = positionFrom(startFen, moves);
    const rng = mulberry32(seed ^ (moves.length * 2654435761));
    const params = strengthParams(elo);
    if (useBook && startFen === START_FEN && moves.length < 12 && rng() < 0.92) {
      const bm = bookMove(moves, rng);
      if (bm && uciToMove(pos, bm)) return { uci: bm, score: 0, depth: 0, nodes: 0, book: true, elo: params.elo };
    }
    if (params.strong) {
      const r = this.searcher.search(pos, { maxNodes: params.maxNodes, timeMs: params.timeMs });
      return { uci: r.move ? moveToUci(r.move) : null, score: clampScore(r.score), depth: r.depth, nodes: r.nodes, book: false, elo: params.elo };
    }
    if (params.oversight > 0 && rng() < params.oversight) {
      // A beginner-style oversight: any legal move, with a soft spot for captures.
      const legal = pos.legalMoves();
      const caps = legal.filter((m) => moveFlags(m) & F_CAPTURE);
      const pool = caps.length && rng() < 0.4 ? caps : legal;
      const m = pool[Math.floor(rng() * pool.length)];
      return { uci: moveToUci(m), score: 0, bestScore: 0, depth: 0, nodes: 0, book: false, oversight: true, elo: params.elo };
    }
    const evalNoise = params.noiseAmp > 2 ? { seed: seed | 0, amp: params.noiseAmp } : null;
    const scored = this.searcher.scoreRoot(pos, params.depth, {
      maxNodes: params.maxNodes, timeMs: params.timeMs, qsLimit: params.qsLimit, evalNoise,
    });
    const pick = pickMove(scored, params, rng);
    return {
      uci: pick ? moveToUci(pick.move) : null,
      score: pick ? clampScore(pick.score) : 0,
      bestScore: scored.length ? clampScore(scored[0].score) : 0,
      depth: this.searcher.lastRootDepth || 0,
      nodes: this.searcher.nodes,
      book: false,
      elo: params.elo,
    };
  }

  /** Full-strength evaluation for grading moves. Score is from the side to move's perspective. */
  analyze({ startFen = START_FEN, moves = [], maxNodes = 40000, timeMs = 400 }) {
    const pos = positionFrom(startFen, moves);
    if (!pos.legalMoves().length) {
      return { score: pos.inCheck() ? -3000 : 0, bestUci: null, depth: 0 };
    }
    const r = this.searcher.search(pos, { maxNodes, timeMs });
    return { score: clampScore(r.score), bestUci: r.move ? moveToUci(r.move) : null, depth: r.depth };
  }
}
