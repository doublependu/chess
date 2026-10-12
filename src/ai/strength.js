// Maps a target Elo to search limits and a "plausible mistake" move picker.
import { MATE } from './search.js';

export const MIN_ELO = 300;
export const MAX_ELO = 2400;
export const STRONG_ELO = 2000;

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function strengthParams(elo) {
  const e = clamp(elo, MIN_ELO, MAX_ELO);
  return {
    elo: e,
    // At the top we simply play the engine's best move from a normal alpha-beta search.
    strong: e >= STRONG_ELO,
    depth: e >= STRONG_ELO ? 64 : clamp(Math.floor((e - 400) / 300) + 1, 1, 5),
    maxNodes: Math.round(1000 * Math.pow(2, (e - 300) / 250)),
    timeMs: 300 + 1700 * ((e - MIN_ELO) / (MAX_ELO - MIN_ELO)),
    // Weak levels don't look at the opponent's recaptures: they grab defended pieces, like beginners do.
    qsLimit: e < 800 ? 0 : e < 1100 ? 2 : e < 1500 ? 6 : 32,
    // Softmax temperature (cp) and candidate window (cp below the best move).
    temperature: 180 * Math.exp(-(e - 300) / 450),
    window: e >= STRONG_ELO ? 0 : 500 * Math.exp(-(e - 300) / 450),
    // Low levels also see the board a little blurry...
    noiseAmp: 60 * Math.exp(-(e - 300) / 350),
    // ...and sometimes simply overlook things (a random legal move).
    oversight: e >= 1400 ? 0 : 0.45 * Math.exp(-(e - 300) / 260),
  };
}

/**
 * Picks a move among scored root moves ([{move, score}] sorted best first).
 * Never considers moves outside the window, so mistakes stay "plausible" for the level.
 */
export function pickMove(scored, params, rng) {
  if (!scored.length) return null;
  const best = scored[0].score;
  // Always convert a forced mate the search actually found (except at the very bottom).
  if (best > MATE - 200 && params.elo >= 600) return scored[0];
  const cands = scored.filter((s) => best - s.score <= params.window);
  if (cands.length <= 1 || params.temperature < 1) return scored[0];
  const T = params.temperature;
  let total = 0;
  const w = cands.map((c) => { const x = Math.exp((c.score - best) / T); total += x; return x; });
  let r = rng() * total;
  for (let i = 0; i < cands.length; i++) { r -= w[i]; if (r <= 0) return cands[i]; }
  return cands[cands.length - 1];
}

export function mulberry32(a) {
  a >>>= 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
