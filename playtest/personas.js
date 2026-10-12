// Simulated human players. They deliberately use a different move-choice model than the AI
// (random oversights + shallow search) so the balance sim isn't the AI playing itself.
import { Searcher } from '../src/ai/search.js';
import { positionFrom } from '../src/ai/brain.js';
import { moveToUci } from '../src/core/notation.js';
import { moveFlags, F_CAPTURE } from '../src/core/constants.js';

export const PERSONAS = {
  beginner: { label: 'Beginner', oversight: 0.28, depth: 1, nodes: 3000, qs: 0, temperature: 120, thinkMs: [2500, 9000], misTap: 0.12 },
  casual: { label: 'Casual (~800)', oversight: 0.14, depth: 2, nodes: 12000, qs: 2, temperature: 60, thinkMs: [2000, 7000], misTap: 0.06 },
  club: { label: 'Club (~1400)', oversight: 0.05, depth: 3, nodes: 60000, qs: 8, temperature: 25, thinkMs: [1500, 5000], misTap: 0.03 },
  strong: { label: 'Strong (~2000)', oversight: 0.01, depth: 6, nodes: 400000, qs: 32, temperature: 6, thinkMs: [1000, 4000], misTap: 0.01 },
};

export class PersonaPlayer {
  constructor(persona, rng) {
    this.p = persona;
    this.rng = rng;
    this.searcher = new Searcher(16);
  }

  choose(startFen, moves) {
    const pos = positionFrom(startFen, moves);
    const legal = pos.legalMoves();
    if (!legal.length) return null;
    if (this.rng() < this.p.oversight) {
      // An "oversight": a random move, biased toward captures (humans love grabbing material).
      const caps = legal.filter((m) => moveFlags(m) & F_CAPTURE);
      const pool = caps.length && this.rng() < 0.5 ? caps : legal;
      return moveToUci(pool[Math.floor(this.rng() * pool.length)]);
    }
    const scored = this.searcher.scoreRoot(pos, this.p.depth, { maxNodes: this.p.nodes, qsLimit: this.p.qs });
    const best = scored[0].score;
    let total = 0;
    const w = scored.map((s) => { const x = Math.exp((s.score - best) / this.p.temperature); total += x; return x; });
    let r = this.rng() * total;
    for (let i = 0; i < scored.length; i++) { r -= w[i]; if (r <= 0) return moveToUci(scored[i].move); }
    return moveToUci(scored[0].move);
  }
}
