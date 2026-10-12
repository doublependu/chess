import { describe, it, expect } from 'vitest';
import { snapshot, restoreGame, rewindPath } from '../src/save/slots.js';
import { Game } from '../src/core/game.js';
import { Director } from '../src/ai/director.js';

describe('checkpoints', () => {
  it('round-trips a game', () => {
    const g = Game.fromMoves(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], { seed: 99 });
    const snap = JSON.parse(JSON.stringify(snapshot({ game: g, humanColor: 0, director: new Director(1100), label: 'x' })));
    const g2 = restoreGame(snap);
    expect(g2.fen()).toBe(g.fen());
    expect(g2.seed).toBe(99);
    expect(g2.records.map((r) => r.seed)).toEqual(g.records.map((r) => r.seed));
    expect(Director.fromJSON(snap.director).base).toBe(1100);
  });
  it('rejects corrupt or illegal data', () => {
    expect(restoreGame(null)).toBeNull();
    expect(restoreGame({ schema: 1, moves: ['e2e5'] })).toBeNull();
    expect(restoreGame({ schema: 1, moves: 'e2e4' })).toBeNull();
    expect(restoreGame({ schema: 99, moves: [] })).toBeNull();
    expect(restoreGame({ schema: 1, moves: [42] })).toBeNull();
  });
  it('computes rewind paths', () => {
    expect(rewindPath(['a', 'b', 'c', 'd'], ['a', 'b'])).toEqual({ common: 2, back: 2, forward: [] });
    expect(rewindPath(['a', 'b', 'c'], ['a', 'x', 'y'])).toEqual({ common: 1, back: 2, forward: ['x', 'y'] });
    expect(rewindPath(['a'], ['a', 'b'])).toEqual({ common: 1, back: 0, forward: ['b'] });
    expect(rewindPath([], [])).toEqual({ common: 0, back: 0, forward: [] });
  });
});
