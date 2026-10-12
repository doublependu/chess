// Adaptive difficulty: picks the AI strength for a game and nudges it move by move so
// the human always has a real chance, without the AI visibly throwing the game.
import { clamp, MIN_ELO, MAX_ELO } from './strength.js';
import { acplToElo, moveLoss, moveAccuracy, isInformative } from './skill.js';

export const TARGET_OFFSET = 0; // the in-game comeback window already tilts close games toward the human

export function streaks(history) {
  let losses = 0, wins = 0;
  for (let i = history.length - 1; i >= 0; i--) { if (history[i].score === 0) losses++; else break; }
  for (let i = history.length - 1; i >= 0; i--) { if (history[i].score === 1) wins++; else break; }
  return { losses, wins };
}

export function gameBaseElo(model) {
  let base = model.rating + TARGET_OFFSET;
  const { losses, wins } = streaks(model.history || []);
  if (losses >= 2) base -= Math.min(300, 100 * (losses - 1));
  if (wins >= 3) base += Math.min(240, 80 * (wins - 2));
  return clamp(base, MIN_ELO, MAX_ELO);
}

export class Director {
  constructor(baseElo, gamesPlayed = 0) {
    this.base = baseElo;
    this.current = baseElo;
    this.gamesPlayed = gamesPlayed;
    this.accuracies = [];
    this.losses = []; // centipawn loss per informative human move
    this.losingStreak = 0; // consecutive AI moves while hopelessly lost
    this.lastElo = baseElo;
  }

  /** Called before each AI move with the latest evaluation from the AI's perspective (cp). */
  moveElo(evalForAI) {
    let target = this.base;
    if (evalForAI > 250) {
      // AI is clearly ahead: open a comeback window, gradually. Once the game is truly decided
      // (> ~10 pawns) close it again so the AI converts instead of shuffling into a stalemate.
      const room = Math.min(300, Math.max(200, this.base * 0.15));
      let ease = Math.min(1, (evalForAI - 250) / 700);
      if (evalForAI > 1000) ease *= Math.max(0, 1 - (evalForAI - 1000) / 500);
      target -= room * ease;
      // The conversion boost scales with level: against true beginners the AI stays beatable.
      if (evalForAI > 1000) target = Math.max(target, Math.min(1100, this.base + Math.max(0, Math.min(300, (this.base - 300) / 3))));
    } else if (evalForAI < -250) {
      // Human ahead: fight back a little, but never above base + 80.
      target += 80 * Math.min(1, (-evalForAI - 250) / 500);
    }
    this.current += (target - this.current) * 0.35;
    this.lastElo = clamp(Math.round(this.current), MIN_ELO, MAX_ELO);
    return this.lastElo;
  }

  /**
   * Feed each human move's evaluation before/after (human perspective, cp).
   * Early games recalibrate the base quickly from the running ACPL.
   */
  observeHumanMove(cpBefore, cpAfter) {
    if (!isInformative(cpBefore)) return;
    this.accuracies.push(moveAccuracy(cpBefore, cpAfter));
    this.losses.push(moveLoss(cpBefore, cpAfter));
    const n = this.losses.length;
    if (this.gamesPlayed < 5 && n >= 6 && n % 2 === 0) {
      const recent = this.losses.slice(-14);
      const acpl = recent.reduce((a, b) => a + b, 0) / recent.length;
      const perf = acplToElo(acpl) + TARGET_OFFSET;
      this.base = clamp(this.base + (perf - this.base) * 0.4, MIN_ELO, MAX_ELO);
    }
  }

  meanAccuracy() {
    if (!this.accuracies.length) return null;
    return this.accuracies.reduce((a, b) => a + b, 0) / this.accuracies.length;
  }

  acpl() {
    if (!this.losses.length) return null;
    return this.losses.reduce((a, b) => a + b, 0) / this.losses.length;
  }

  /**
   * The AI resigns after four consecutive moves in a hopeless position — but only at club level
   * and above: games between beginners swing wildly, so a weak AI plays on.
   */
  shouldResign(evalForAI) {
    this.losingStreak = evalForAI <= -1000 ? this.losingStreak + 1 : 0;
    return this.base >= 1200 && this.losingStreak >= 4;
  }

  toJSON() {
    return {
      base: this.base, current: this.current, gamesPlayed: this.gamesPlayed,
      accuracies: this.accuracies.slice(), losses: this.losses.slice(), losingStreak: this.losingStreak,
    };
  }

  static fromJSON(o, fallbackElo = 1000) {
    const d = new Director(typeof o?.base === 'number' ? o.base : fallbackElo, o?.gamesPlayed | 0);
    if (typeof o?.current === 'number') d.current = o.current;
    if (Array.isArray(o?.accuracies)) d.accuracies = o.accuracies.filter((x) => typeof x === 'number');
    if (Array.isArray(o?.losses)) d.losses = o.losses.filter((x) => typeof x === 'number');
    d.losingStreak = o?.losingStreak | 0;
    return d;
  }
}
