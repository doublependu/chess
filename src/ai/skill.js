// Estimates how good the human is, from move accuracy and results.
import { clamp, MIN_ELO, MAX_ELO } from './strength.js';

// Lichess formulas: https://lichess.org/page/accuracy
export const winPercent = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -2000, 2000))) - 1);

/** Accuracy (0..100) of a move given evals before/after, both from the mover's perspective. */
export function moveAccuracy(cpBefore, cpAfter) {
  const drop = winPercent(cpBefore) - winPercent(cpAfter);
  if (drop <= 0) return 100;
  return clamp(103.1668 * Math.exp(-0.04354 * drop) - 3.1669, 0, 100);
}

/** Centipawn loss of one move (capped so a single blunder doesn't dominate the average). */
export const moveLoss = (cpBefore, cpAfter) => clamp(cpBefore - cpAfter, 0, 600);

// ACPL measured for the AI itself at each strength level (playtest-output calibration run,
// 15k-node analysis). Using the AI's own curve keeps human estimates on the AI's scale.
const ACPL_TABLE = [[220, 300], [150, 500], [100, 700], [72, 900], [42, 1100], [27, 1300], [19, 1500], [14, 1750], [9.5, 2000], [6, 2300], [4, 2500]];

/** Performance rating (on the AI's strength scale) implied by an average centipawn loss. */
export function acplToElo(acpl) {
  if (!(acpl > ACPL_TABLE.at(-1)[0])) return ACPL_TABLE.at(-1)[1];
  if (acpl >= ACPL_TABLE[0][0]) return ACPL_TABLE[0][1];
  for (let i = 1; i < ACPL_TABLE.length; i++) {
    const [a1, e1] = ACPL_TABLE[i - 1], [a2, e2] = ACPL_TABLE[i];
    if (acpl <= a1 && acpl >= a2) {
      const t = (Math.log(a1) - Math.log(acpl)) / (Math.log(a1) - Math.log(a2));
      return e1 + (e2 - e1) * t;
    }
  }
  return ACPL_TABLE.at(-1)[1];
}

/** Moves played in already-decided positions say little about skill. */
export const isInformative = (cpBefore) => Math.abs(cpBefore) < 600;

export const expectedScore = (rating, opp) => 1 / (1 + Math.pow(10, (opp - rating) / 400));

export function newPlayerModel() {
  return { rating: 850, games: 0, history: [] }; // most visitors are casual players: start gentle
}

export function normalizeModel(m) {
  if (!m || typeof m.rating !== 'number' || !isFinite(m.rating)) return newPlayerModel();
  return {
    rating: clamp(m.rating, MIN_ELO, MAX_ELO + 200),
    games: Math.max(0, m.games | 0),
    history: Array.isArray(m.history) ? m.history.slice(-20) : [],
  };
}

/**
 * Updates the model after a game.
 * @param score 1 = human won, 0.5 draw, 0 lost
 * @param acpl human average centipawn loss over informative moves, or null
 * @param samples number of informative human moves behind `acpl`
 * @param accuracy mean Lichess-style accuracy (kept for display/history only)
 */
export function updateAfterGame(model, { aiElo, score, acpl = null, samples = 0, accuracy = null }) {
  const m = normalizeModel(model);
  // Streaks of the same result mean the estimate is off: move faster.
  let streak = 1;
  for (let i = m.history.length - 1; i >= 0 && m.history[i].score === score && score !== 0.5; i--) streak++;
  const K = Math.max(64, 180 / (1 + m.games * 0.5)) * Math.min(2.5, 1 + 0.4 * (streak - 1));
  let r = m.rating + K * (score - expectedScore(m.rating, aiElo));
  if (acpl != null && samples >= 8) {
    const w = m.games < 2 ? 0.3 : 0.04;
    r = r * (1 - w) + acplToElo(acpl) * w;
  }
  m.rating = clamp(Math.round(r), MIN_ELO, MAX_ELO + 200);
  m.games += 1;
  m.history.push({ score, aiElo: Math.round(aiElo), acpl: acpl == null ? null : Math.round(acpl), accuracy: accuracy == null ? null : Math.round(accuracy), at: Date.now() });
  m.history = m.history.slice(-20);
  return m;
}
