// Alpha-beta search: iterative deepening, PVS, transposition table, null move,
// late move reductions, check extension, quiescence with MVV-LVA ordering.
import { evaluate, PIECE_VALUE } from './eval.js';
import { pieceType, moveFrom, moveTo, movePromo, moveFlags, F_CAPTURE, F_EP } from '../core/constants.js';

export const INF = 32000;
export const MATE = 30000;
const MAX_PLY = 96;
const EXACT = 1, LOWER = 2, UPPER = 3;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Searcher {
  constructor(ttBits = 18) {
    const size = 1 << ttBits;
    this.ttMask = size - 1;
    this.ttKey = new Int32Array(size);
    this.ttMove = new Int32Array(size);
    this.ttScore = new Int16Array(size);
    this.ttDepth = new Int8Array(size);
    this.ttFlag = new Uint8Array(size);
    this.killers = new Int32Array(MAX_PLY * 2);
    this.history = new Int32Array(16 * 128);
    this.moveBuf = Array.from({ length: MAX_PLY + 1 }, () => []);
    this.scoreBuf = Array.from({ length: MAX_PLY + 1 }, () => new Int32Array(256));
    this.nodes = 0;
    this.stopped = false;
    this.qsLimit = 32;
    this.evalNoise = null;
  }

  clearTT() {
    this.ttKey.fill(0); this.ttMove.fill(0); this.ttFlag.fill(0);
  }

  checkLimits() {
    if (this.nodes >= this.maxNodes || now() >= this.deadline) this.stopped = true;
  }

  evaluate(pos) {
    const s = evaluate(pos);
    if (this.evalNoise) {
      // Deterministic per-position noise (weak "personality"/inaccuracy for low levels).
      const h = Math.imul(pos.hashLo ^ this.evalNoise.seed, 0x9e3779b1);
      return s + (((h >>> 16) & 0xff) / 255 - 0.5) * 2 * this.evalNoise.amp;
    }
    return s;
  }

  orderMoves(pos, moves, scores, ply, ttMove) {
    const b = pos.board;
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      let s;
      if (m === ttMove) s = 2_000_000;
      else {
        const flags = moveFlags(m);
        if (flags & F_CAPTURE) {
          const victim = (flags & F_EP) ? 1 : pieceType(b[moveTo(m)]);
          s = 1_000_000 + PIECE_VALUE[victim] * 10 - pieceType(b[moveFrom(m)]);
        } else if (movePromo(m)) s = 900_000 + movePromo(m);
        else if (m === k1) s = 800_000;
        else if (m === k2) s = 790_000;
        else s = this.history[b[moveFrom(m)] * 128 + moveTo(m)];
      }
      scores[i] = s;
    }
  }

  // Selection sort step: move the best remaining move into slot i.
  pick(moves, scores, i) {
    let best = i;
    for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j;
    if (best !== i) {
      const tm = moves[i]; moves[i] = moves[best]; moves[best] = tm;
      const ts = scores[i]; scores[i] = scores[best]; scores[best] = ts;
    }
    return moves[i];
  }

  quiesce(pos, alpha, beta, ply, qply) {
    if ((++this.nodes & 1023) === 0) this.checkLimits();
    if (this.stopped) return 0;
    const stand = this.evaluate(pos);
    if (stand >= beta) return stand;
    if (qply >= this.qsLimit || ply >= MAX_PLY) return stand;
    if (stand > alpha) alpha = stand;
    const moves = this.moveBuf[ply];
    moves.length = 0;
    pos.generate(moves, true);
    const scores = this.scoreBuf[ply];
    this.orderMoves(pos, moves, scores, ply, 0);
    let best = stand;
    for (let i = 0; i < moves.length; i++) {
      const m = this.pick(moves, scores, i);
      const flags = moveFlags(m);
      // Delta pruning
      if (!movePromo(m)) {
        const victim = (flags & F_EP) ? 1 : pieceType(pos.board[moveTo(m)]);
        if (stand + PIECE_VALUE[victim] + 200 < alpha) continue;
      }
      if (!pos.makeMove(m)) continue;
      const score = -this.quiesce(pos, -beta, -alpha, ply + 1, qply + 1);
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > best) best = score;
      if (score > alpha) {
        alpha = score;
        if (score >= beta) break;
      }
    }
    return best;
  }

  negamax(pos, depth, alpha, beta, ply, allowNull) {
    const inCheck = pos.inCheck();
    if (inCheck) depth++;
    if (depth <= 0) return this.quiesce(pos, alpha, beta, ply, 0);
    if ((++this.nodes & 1023) === 0) this.checkLimits();
    if (this.stopped) return 0;

    if (ply > 0) {
      if (pos.halfmove >= 100 || pos.repetitions() >= 1 || pos.insufficientMaterial()) return 0;
      // Mate distance pruning
      const ma = -MATE + ply, mb = MATE - ply - 1;
      if (alpha < ma) alpha = ma;
      if (beta > mb) beta = mb;
      if (alpha >= beta) return alpha;
    }
    if (ply >= MAX_PLY) return this.evaluate(pos);

    const pvNode = beta - alpha > 1;
    const idx = pos.hashLo & this.ttMask;
    let ttMove = 0;
    if (this.ttKey[idx] === pos.hashHi && this.ttFlag[idx]) {
      ttMove = this.ttMove[idx];
      if (!pvNode && this.ttDepth[idx] >= depth && ply > 0) {
        let s = this.ttScore[idx];
        if (s > MATE - MAX_PLY) s -= ply; else if (s < -MATE + MAX_PLY) s += ply;
        const f = this.ttFlag[idx];
        if (f === EXACT || (f === LOWER && s >= beta) || (f === UPPER && s <= alpha)) return s;
      }
    }

    // Null-move pruning
    if (allowNull && !pvNode && !inCheck && depth >= 3 && ply > 0 && pos.hasPieces(pos.side)) {
      if (this.evaluate(pos) >= beta) {
        pos.makeNull();
        const s = -this.negamax(pos, depth - 3, -beta, -beta + 1, ply + 1, false);
        pos.unmakeNull();
        if (this.stopped) return 0;
        if (s >= beta) return s >= MATE - MAX_PLY ? beta : s;
      }
    }

    const moves = this.moveBuf[ply];
    moves.length = 0;
    pos.generate(moves);
    const scores = this.scoreBuf[ply];
    this.orderMoves(pos, moves, scores, ply, ttMove);

    const origAlpha = alpha;
    let best = -INF, bestMove = 0, legal = 0;
    for (let i = 0; i < moves.length; i++) {
      const m = this.pick(moves, scores, i);
      if (!pos.makeMove(m)) continue;
      legal++;
      const quiet = !(moveFlags(m) & F_CAPTURE) && !movePromo(m);
      let score;
      if (legal === 1) {
        score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        let r = 0;
        if (depth >= 3 && legal > 3 && quiet && !inCheck && m !== this.killers[ply * 2] && m !== this.killers[ply * 2 + 1]) {
          r = legal > 8 ? 2 : 1;
          if (pos.inCheck()) r = 0;
        }
        score = -this.negamax(pos, depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && (r > 0 || score < beta)) {
          score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
        }
      }
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > best) {
        best = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) {
            if (quiet) {
              if (this.killers[ply * 2] !== m) {
                this.killers[ply * 2 + 1] = this.killers[ply * 2];
                this.killers[ply * 2] = m;
              }
              const hi = pos.board[moveFrom(m)] * 128 + moveTo(m);
              this.history[hi] += depth * depth;
              if (this.history[hi] > 700_000) for (let k = 0; k < this.history.length; k++) this.history[k] >>= 1;
            }
            break;
          }
        }
      }
    }
    if (legal === 0) return inCheck ? -MATE + ply : 0;

    let stored = best;
    if (stored > MATE - MAX_PLY) stored += ply; else if (stored < -MATE + MAX_PLY) stored -= ply;
    this.ttKey[idx] = pos.hashHi;
    this.ttMove[idx] = bestMove;
    this.ttScore[idx] = stored;
    this.ttDepth[idx] = depth;
    this.ttFlag[idx] = best <= origAlpha ? UPPER : best >= beta ? LOWER : EXACT;
    return best;
  }

  setLimits({ maxNodes = Infinity, timeMs = Infinity, qsLimit = 32, evalNoise = null } = {}) {
    this.nodes = 0;
    this.stopped = false;
    this.maxNodes = maxNodes;
    this.deadline = now() + timeMs;
    this.qsLimit = qsLimit;
    this.evalNoise = evalNoise;
    this.killers.fill(0);
    for (let k = 0; k < this.history.length; k++) this.history[k] >>= 2;
  }

  /**
   * Iterative deepening. Returns { move, score, depth, nodes }.
   * The last fully completed iteration wins; a partial iteration is used only if it found a better move first.
   */
  search(pos, { maxDepth = 64, maxNodes = Infinity, timeMs = Infinity, qsLimit = 32, evalNoise = null } = {}) {
    this.setLimits({ maxNodes, timeMs, qsLimit, evalNoise });
    const rootMoves = pos.legalMoves();
    if (!rootMoves.length) return { move: 0, score: pos.inCheck() ? -MATE : 0, depth: 0, nodes: 0 };
    let bestMove = rootMoves[0], bestScore = -INF, doneDepth = 0;
    for (let d = 1; d <= maxDepth; d++) {
      const score = this.negamax(pos, d, -INF, INF, 0, false);
      if (this.stopped && d > 1) break;
      const idx = pos.hashLo & this.ttMask;
      if (this.ttKey[idx] === pos.hashHi && this.ttMove[idx]) bestMove = this.ttMove[idx];
      bestScore = score;
      doneDepth = d;
      if (Math.abs(score) > MATE - MAX_PLY) break; // found a forced mate
      if (this.stopped) break;
    }
    return { move: bestMove, score: bestScore, depth: doneDepth, nodes: this.nodes };
  }

  /**
   * Scores every root move with a full window at `depth` (multi-PV style, used by the
   * strength limiter to pick plausible sub-optimal moves). Returns [{move, score}] best first.
   */
  scoreRoot(pos, depth, { maxNodes = Infinity, timeMs = Infinity, qsLimit = 32, evalNoise = null } = {}) {
    this.setLimits({ maxNodes, timeMs, qsLimit, evalNoise });
    let result = null;
    // Iterative deepening so the TT orders later iterations; keep the last complete one.
    for (let d = 1; d <= depth; d++) {
      const out = [];
      const moves = result ? result.map((r) => r.move) : pos.legalMoves();
      for (const m of moves) {
        pos.makeMove(m);
        let score;
        if (d <= 1) {
          // Even the shallowest look must know mate and stalemate.
          const replies = pos.legalMoves().length;
          if (replies === 0) score = pos.inCheck() ? MATE - 1 : 0;
          else if (pos.repetitions() >= 2 || pos.halfmove >= 100 || pos.insufficientMaterial()) score = 0;
          else score = -this.quiesce(pos, -INF, INF, 1, 0);
        } else score = -this.negamax(pos, d - 1, -INF, INF, 1, true);
        pos.unmakeMove();
        if (this.stopped) break;
        out.push({ move: m, score });
      }
      if (this.stopped && result) break;
      if (this.stopped) {
        // Even depth 1 ran out of budget: finish it with a cheap shallow quiescence.
        this.stopped = false;
        this.maxNodes = Infinity;
        this.deadline = Infinity;
        this.qsLimit = Math.min(this.qsLimit, 4);
        const seen = new Set(out.map((o) => o.move));
        for (const m of moves) {
          if (seen.has(m)) continue;
          pos.makeMove(m);
          out.push({ move: m, score: -this.quiesce(pos, -INF, INF, 1, 0) });
          pos.unmakeMove();
        }
        out.sort((a, b) => b.score - a.score);
        return out;
      }
      out.sort((a, b) => b.score - a.score);
      result = out;
      this.lastRootDepth = d;
      if (result.length && Math.abs(result[0].score) > MATE - MAX_PLY) break;
    }
    return result || [];
  }
}
