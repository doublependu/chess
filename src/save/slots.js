import { Game } from '../core/game.js';
import { START_FEN } from '../core/constants.js';

const KEYS = {
  settings: 'skychess.settings.v1',
  player: 'skychess.player.v1',
  slots: 'skychess.slots.v1',
  autosave: 'skychess.autosave.v1',
};
export const SLOT_COUNT = 3;
export const SCHEMA = 1;

export const store = {
  get(key, fallback = null) {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

export const DEFAULT_SETTINGS = {
  graphics: 'auto', difficulty: 'auto', animSpeed: 1, sound: true, volume: 0.7,
  reducedMotion: null, idleMotion: 'auto', showMoves: true, showSanInput: false,
};

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(store.get(KEYS.settings, {}) || {}) };
  if (s.reducedMotion === null) s.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return s;
}
export const saveSettings = (s) => store.set(KEYS.settings, s);
export const loadPlayer = () => store.get(KEYS.player, null);
export const savePlayer = (p) => store.set(KEYS.player, p);

/** Serializable snapshot of a game in progress. */
export function snapshot({ game, humanColor, director, label, thumb = null }) {
  return {
    schema: SCHEMA,
    savedAt: Date.now(),
    label,
    humanColor,
    seed: game.seed,
    startFen: game.startFen,
    moves: game.uciList(),
    director: director ? director.toJSON() : null,
    turn: game.turn,
    over: game.over,
    thumb,
  };
}

/** Replays a snapshot through the rules engine. Returns a Game, or null if the data is invalid. */
export function restoreGame(snap) {
  if (!snap || snap.schema !== SCHEMA || !Array.isArray(snap.moves)) return null;
  if (snap.moves.length > 2000 || !snap.moves.every((m) => typeof m === 'string')) return null;
  try {
    return Game.fromMoves(snap.moves, { seed: snap.seed >>> 0, startFen: snap.startFen || START_FEN });
  } catch {
    return null;
  }
}

export function loadSlots() {
  const raw = store.get(KEYS.slots, []);
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = Array.isArray(raw) ? raw[i] : null;
    out.push(s && restoreGame(s) ? s : null);
  }
  return out;
}

export function saveSlot(index, snap) {
  const slots = loadSlots();
  slots[index] = snap;
  if (store.set(KEYS.slots, slots)) return true;
  // Out of space: drop thumbnails and retry.
  for (const s of slots) if (s) s.thumb = null;
  return store.set(KEYS.slots, slots);
}

export const loadAutosave = () => {
  const s = store.get(KEYS.autosave, null);
  return s && restoreGame(s) ? s : null;
};
export const saveAutosave = (snap) => store.set(KEYS.autosave, { ...snap, thumb: null });
export const clearAutosave = () => store.remove(KEYS.autosave);

/** How to get from the current move list to a target: undo `back` moves, then play `forward`. */
export function rewindPath(current, target) {
  let k = 0;
  while (k < current.length && k < target.length && current[k] === target[k]) k++;
  return { common: k, back: current.length - k, forward: target.slice(k) };
}
