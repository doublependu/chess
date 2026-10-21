import { describe, expect, it } from 'vitest';
import { Table, seedOf } from '../src/net/table.js';
import { RESULT } from '../src/core/game.js';

const ADA = 'ada-player-id-0001';
const GRACE = 'grace-player-id-002';
const ED = 'edsger-player-id-03';

/** A table with Ada on white and Grace on black. */
function seated() {
  const t = new Table();
  t.apply({ t: 'sit', c: 0, name: 'Ada' }, ADA);
  t.apply({ t: 'sit', c: 1, name: 'Grace' }, GRACE);
  return t;
}

const move = (t, uci, pid) => t.apply({ t: 'move', n: t.n, ply: t.moves.length, uci }, pid);

describe('the table in a room', () => {
  it('seats: first come, one each, and nobody in two', () => {
    const t = new Table();
    expect(t.apply({ t: 'sit', c: 0, name: 'Ada' }, ADA)).toEqual({ t: 'sit', c: 0 });
    // Taken, and Ada cannot have the other one too.
    expect(t.apply({ t: 'sit', c: 0, name: 'Grace' }, GRACE)).toBeNull();
    expect(t.apply({ t: 'sit', c: 1, name: 'Ada' }, ADA)).toBeNull();
    expect(t.apply({ t: 'sit', c: 1, name: 'Grace' }, GRACE)).toEqual({ t: 'sit', c: 1 });
    expect(t.seats).toEqual([ADA, GRACE]);
    expect(t.names).toEqual(['Ada', 'Grace']);
    expect(t.seatOf(ED)).toBe(-1);
    expect(t.apply({ t: 'sit', c: 2 }, ED)).toBeNull();
  });

  it('moves: only the side on move, only the next ply, only legal ones', () => {
    const t = seated();
    expect(move(t, 'e7e5', GRACE)).toBeNull();
    expect(move(t, 'e2e4', ED)).toBeNull();
    expect(move(t, 'e2e5', ADA)).toBeNull();
    expect(move(t, 'e2e4', ADA).rec.san).toBe('e4');
    // The same ply twice: the second is too late.
    expect(t.apply({ t: 'move', n: 1, ply: 0, uci: 'd2d4' }, ADA)).toBeNull();
    expect(t.apply({ t: 'move', n: 1, ply: 1, uci: 'e7e5' }, ADA)).toBeNull();
    expect(move(t, 'e7e5', GRACE)).not.toBeNull();
    expect(t.moves).toEqual(['e2e4', 'e7e5']);
    // Rubbish is ignored.
    for (const op of [null, 5, {}, { t: 'move', n: 1, ply: 2, uci: 'g1f3; drop' }, { t: 'fly' }]) expect(t.apply(op, ADA)).toBeNull();
    expect(t.apply({ t: 'move', n: 1, ply: 2, uci: 'g1f3' }, '')).toBeNull();
  });

  it('a game ends by checkmate, resignation, or a draw both agree to', () => {
    const mate = seated();
    for (const [i, u] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) move(mate, u, i % 2 ? GRACE : ADA);
    expect(mate.game.result).toEqual({ status: RESULT.CHECKMATE, winner: 1 });
    expect(move(mate, 'a2a3', ADA)).toBeNull();

    const resigned = seated();
    move(resigned, 'e2e4', ADA);
    expect(resigned.apply({ t: 'resign', n: 1 }, ED)).toBeNull();
    expect(resigned.apply({ t: 'resign', n: 1 }, GRACE)).toEqual({ t: 'resign', c: 1 });
    expect(resigned.game.result).toEqual({ status: RESULT.RESIGN, winner: 0 });

    const drawn = seated();
    move(drawn, 'e2e4', ADA);
    // Accepting an offer that was not made, or your own, does nothing.
    expect(drawn.apply({ t: 'accept', n: 1, ply: 1 }, GRACE)).toBeNull();
    expect(drawn.apply({ t: 'offer', n: 1, ply: 1 }, ADA)).toEqual({ t: 'offer', c: 0 });
    expect(drawn.apply({ t: 'accept', n: 1, ply: 1 }, ADA)).toBeNull();
    expect(drawn.apply({ t: 'accept', n: 1, ply: 1 }, GRACE)).toEqual({ t: 'accept', c: 1 });
    expect(drawn.game.result).toEqual({ status: RESULT.AGREED, winner: null });

    // An offer lapses with the next move.
    const lapsed = seated();
    lapsed.apply({ t: 'offer', n: 1, ply: 0 }, GRACE);
    move(lapsed, 'e2e4', ADA);
    expect(lapsed.offer).toBeNull();
    expect(lapsed.apply({ t: 'accept', n: 1, ply: 0 }, ADA)).toBeNull();
  });

  it('the next game: when this one is over or not begun, with colours changed', () => {
    const t = seated();
    move(t, 'e2e4', ADA);
    expect(t.apply({ t: 'new', n: 1 }, ADA)).toBeNull();
    t.apply({ t: 'resign', n: 1 }, ADA);
    expect(t.apply({ t: 'new', n: 1 }, ED)).toBeNull();
    expect(t.apply({ t: 'new', n: 1 }, GRACE)).toEqual({ t: 'new', n: 2 });
    expect(t.seats).toEqual([GRACE, ADA]);
    expect(t.moves).toEqual([]);
    expect(t.history).toEqual([{ white: 'Ada', black: 'Grace', winner: 1, how: RESULT.RESIGN, plies: 1 }]);
    // An op for the old game does nothing to the new one.
    expect(t.apply({ t: 'move', n: 1, ply: 0, uci: 'e2e4' }, GRACE)).toBeNull();
    expect(t.apply({ t: 'new', n: 1 }, GRACE)).toBeNull();
    expect(t.game.seed).toBe(seedOf(2));
  });

  it('getting up: the seat is free, and a game begun is lost', () => {
    const t = seated();
    expect(t.apply({ t: 'stand' }, ED)).toBeNull();
    expect(t.apply({ t: 'stand' }, GRACE)).toEqual({ t: 'stand', c: 1, lost: false });
    t.apply({ t: 'sit', c: 1, name: 'Edsger' }, ED);
    move(t, 'e2e4', ADA);
    expect(t.apply({ t: 'stand' }, ED)).toEqual({ t: 'stand', c: 1, lost: true });
    expect(t.game.result).toEqual({ status: RESULT.RESIGN, winner: 0 });
    expect(t.seats).toEqual([ADA, null]);
  });

  it('a snapshot, and the ops after it, give the table that the ops alone give', () => {
    const ops = [
      [{ t: 'sit', c: 0, name: 'Ada' }, ADA], [{ t: 'sit', c: 1, name: 'Grace' }, GRACE],
      [{ t: 'move', n: 1, ply: 0, uci: 'e2e4' }, ADA], [{ t: 'offer', n: 1, ply: 1 }, ADA],
      [{ t: 'move', n: 1, ply: 1, uci: 'c7c5' }, GRACE], [{ t: 'resign', n: 1 }, GRACE], [{ t: 'new', n: 1 }, ADA],
      [{ t: 'move', n: 2, ply: 0, uci: 'g1f3' }, GRACE], [{ t: 'move', n: 2, ply: 1, uci: 'd7d5' }, ADA],
    ];
    const all = new Table();
    for (const [op, pid] of ops) all.apply(op, pid);
    for (let cut = 0; cut <= ops.length; cut++) {
      const before = new Table();
      for (const [op, pid] of ops.slice(0, cut)) before.apply(op, pid);
      const after = new Table(JSON.parse(JSON.stringify(before.save())));
      for (const [op, pid] of ops.slice(cut)) after.apply(op, pid);
      expect(after.fingerprint(), `cut at ${cut}`).toBe(all.fingerprint());
      expect(after.save()).toEqual(all.save());
    }
  });

  it('a snapshot that is not one gives an empty table, and a move that will not play ends the list there', () => {
    expect(new Table({ n: 'x' }).save()).toEqual(new Table().save());
    const t = new Table({ n: 3, seats: [ADA, 5], names: ['Ada', 'x'], moves: ['e2e4', 'e2e4', 'd2d4'], history: [] });
    expect(t.seats).toEqual([ADA, null]);
    expect(t.moves).toEqual(['e2e4']);
    expect(t.copy().fen()).toBe(t.game.fen());
  });
});
