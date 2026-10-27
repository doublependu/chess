import { describe, expect, it } from 'vitest';
import { Table, seedOf, LINE_MAX } from '../src/net/table.js';
import { RESULT } from '../src/core/game.js';

const ADA = 'ada-player-id-0001';
const GRACE = 'grace-player-id-002';
const ED = 'edsger-player-id-03';
const LIN = 'lin-player-id-00004';
const MO = 'mo-player-id-000005';

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

describe('taking turns: the line', () => {
  /** Ada on white, Grace on black, and Ed then Lin in line. */
  function waiting() {
    const t = seated();
    t.apply({ t: 'line', name: 'Ed' }, ED);
    t.apply({ t: 'line', name: 'Lin' }, LIN);
    return t;
  }
  const names = (t) => t.line.map((e) => e.name);

  it('getting in line: once, in order, and not from a seat', () => {
    const t = seated();
    expect(t.apply({ t: 'line', name: 'Ed' }, ED)).toEqual({ t: 'line', pid: ED, place: 0 });
    expect(t.apply({ t: 'line', name: 'Ed again' }, ED)).toBeNull();
    expect(t.apply({ t: 'line', name: 'Ada' }, ADA)).toBeNull();
    expect(t.apply({ t: 'line', name: 'Lin' }, LIN)).toEqual({ t: 'line', pid: LIN, place: 1 });
    expect(names(t)).toEqual(['Ed', 'Lin']);
    expect(t.placeOf(LIN)).toBe(1);
    expect(t.apply({ t: 'unline' }, ED)).toEqual({ t: 'unline', pid: ED });
    expect(t.apply({ t: 'unline' }, ED)).toBeNull();
    expect(names(t)).toEqual(['Lin']);
  });

  it('the line is not longer than LINE_MAX', () => {
    const t = seated();
    for (let i = 0; i < LINE_MAX + 3; i++) t.apply({ t: 'line', name: `P${i}` }, `player-${i}`);
    expect(t.line.length).toBe(LINE_MAX);
  });

  it('a free seat goes to the first in line, at once, and only to them', () => {
    const t = waiting();
    // Grace gets up before a move: Ed sits down in her place, and the game is still to play.
    expect(t.apply({ t: 'stand' }, GRACE)).toEqual({ t: 'stand', c: 1, lost: false, filled: [{ c: 1, pid: ED }] });
    expect(t.seats).toEqual([ADA, ED]);
    expect(names(t)).toEqual(['Lin']);
    // Getting in line with a seat free is sitting down.
    const empty = new Table();
    empty.apply({ t: 'sit', c: 0, name: 'Ada' }, ADA);
    expect(empty.apply({ t: 'line', name: 'Ed' }, ED)).toEqual({ t: 'line', pid: ED, place: 0, filled: [{ c: 1, pid: ED }] });
    expect(empty.line).toEqual([]);
    // A seat does not go to somebody behind the first in line (as when a sit and a stand cross).
    const t2 = seated();
    t2.apply({ t: 'line', name: 'Ed' }, ED);
    t2.seats[1] = null;
    expect(t2.apply({ t: 'sit', c: 1, name: 'Mo' }, MO)).toBeNull();
    expect(t2.apply({ t: 'sit', c: 1, name: 'Ed' }, ED)).toEqual({ t: 'sit', c: 1 });
    expect(t2.line).toEqual([]);
  });

  it('the next game: the winner stays and changes colour, the loser goes to the back, the first in line comes in', () => {
    const t = waiting();
    move(t, 'e2e4', ADA);
    t.apply({ t: 'resign', n: 1 }, GRACE);
    expect(t.leaving()).toBe(1);
    // Somebody further back cannot start it; the first in line can.
    expect(t.apply({ t: 'new', n: 1 }, LIN)).toBeNull();
    expect(t.apply({ t: 'new', n: 1 }, ED)).toEqual({ t: 'new', n: 2, out: { c: 1, pid: GRACE, name: 'Grace' } });
    expect(t.seats).toEqual([ED, ADA]);
    expect(t.names).toEqual(['Ed', 'Ada']);
    expect(names(t)).toEqual(['Lin', 'Grace']);
    // Ada (black now) loses by checkmate: Lin comes in, and Ed stays, on black.
    for (const [u, p] of [['f2f3', ED], ['e7e5', ADA], ['g2g4', ED], ['d8h4', ADA]]) move(t, u, p);
    expect(t.game.result.winner).toBe(1);
    t.apply({ t: 'new', n: 2 }, ADA);
    expect(t.seats).toEqual([ADA, LIN]);
    expect(names(t)).toEqual(['Grace', 'Ed']);
  });

  it('after a draw the one who has sat longer goes; sat down together, the one who had white', () => {
    const t = waiting();
    move(t, 'e2e4', ADA);
    t.apply({ t: 'offer', n: 1, ply: 1 }, GRACE);
    t.apply({ t: 'accept', n: 1, ply: 1 }, ADA);
    // Both sat down for game 1: white (Ada) goes.
    expect(t.leaving()).toBe(0);
    t.apply({ t: 'new', n: 1 }, GRACE);
    expect(t.seats).toEqual([GRACE, ED]);
    expect(t.since).toEqual([1, 2]);
    // Another draw: Grace has sat since game 1, Ed since game 2, so Grace goes, though she has white again.
    move(t, 'e2e4', GRACE);
    t.apply({ t: 'offer', n: 2, ply: 1 }, ED);
    t.apply({ t: 'accept', n: 2, ply: 1 }, GRACE);
    expect(t.leaving()).toBe(0);
    t.apply({ t: 'new', n: 2 }, ED);
    // Ed stays and changes colour; Lin takes the other side.
    expect(t.seats).toEqual([ED, LIN]);
    expect(names(t)).toEqual(['Ada', 'Grace']);
  });

  it('nobody waiting, or a game without moves: the two play on, as before there was a line', () => {
    const t = seated();
    move(t, 'e2e4', ADA);
    t.apply({ t: 'resign', n: 1 }, ADA);
    expect(t.leaving()).toBe(-1);
    t.apply({ t: 'new', n: 1 }, ADA);
    expect(t.seats).toEqual([GRACE, ADA]);
    const fresh = waiting();
    expect(fresh.apply({ t: 'new', n: 1 }, ADA)).toEqual({ t: 'new', n: 2 });
    expect(fresh.seats).toEqual([GRACE, ADA]);
    expect(names(fresh)).toEqual(['Ed', 'Lin']);
  });

  it('a loser who already got up is not sent out again: the seat is the newcomer\'s', () => {
    const t = waiting();
    move(t, 'e2e4', ADA);
    // Grace gives up her seat in a game begun: she loses it, and Ed takes the seat.
    expect(t.apply({ t: 'stand' }, GRACE)).toEqual({ t: 'stand', c: 1, lost: true, filled: [{ c: 1, pid: ED }] });
    expect(t.leaving()).toBe(-1);
    t.apply({ t: 'new', n: 1 }, ED);
    expect(t.seats).toEqual([ED, ADA]);
    // Grace is not put in line: she got up.
    expect(names(t)).toEqual(['Lin']);
  });

  it('skipping somebody who is not there: only while somebody waits, by the other player or the line', () => {
    const t = seated();
    expect(t.apply({ t: 'skip', n: 1, c: 1 }, ADA)).toBeNull();
    t.apply({ t: 'line', name: 'Ed' }, ED);
    t.apply({ t: 'line', name: 'Lin' }, LIN);
    expect(t.apply({ t: 'skip', n: 1, c: 1 }, GRACE)).toBeNull();
    expect(t.apply({ t: 'skip', n: 1, c: 1 }, MO)).toBeNull();
    expect(t.apply({ t: 'skip', n: 2, c: 1 }, ADA)).toBeNull();
    // Before a move: Grace goes, not into the line, and Ed sits down for the same game.
    expect(t.apply({ t: 'skip', n: 1, c: 1 }, LIN)).toEqual({ t: 'skip', c: 1, pid: GRACE, name: 'Grace', lost: false, filled: [{ c: 1, pid: ED }] });
    expect(t.seats).toEqual([ADA, ED]);
    expect(names(t)).toEqual(['Lin']);
    expect(t.over).toBe(false);
    // In a game begun, it counts as a loss for the one who is gone.
    move(t, 'e2e4', ADA);
    expect(t.apply({ t: 'skip', n: 1, c: 1 }, ADA)).toEqual({ t: 'skip', c: 1, pid: ED, name: 'Ed', lost: true, filled: [{ c: 1, pid: LIN }] });
    expect(t.game.result).toEqual({ status: RESULT.RESIGN, winner: 0 });
    t.apply({ t: 'new', n: 1 }, LIN);
    expect(t.seats).toEqual([LIN, ADA]);
    expect(t.line).toEqual([]);
  });

  it('a v1 snapshot loads with nobody in line, and plays on as v1 did', () => {
    const v1 = { n: 4, seats: [ADA, GRACE], names: ['Ada', 'Grace'], moves: ['e2e4'], ended: { how: 'resign', by: 1 }, offer: null, history: [] };
    const t = new Table(v1);
    expect(t.line).toEqual([]);
    expect(t.since).toEqual([4, 4]);
    expect(t.finished).toEqual([ADA, GRACE]);
    t.apply({ t: 'new', n: 4 }, ADA);
    expect(t.seats).toEqual([GRACE, ADA]);
    // A line that names a seated player, or somebody twice, is cleaned up.
    const odd = new Table({ ...v1, line: [{ pid: ADA, name: 'Ada' }, { pid: ED, name: 'Ed' }, { pid: ED, name: 'Ed' }, { pid: 5 }] });
    expect(odd.line).toEqual([{ pid: ED, name: 'Ed' }]);
  });

  it('pages that see the same log, duplicates and all, agree; and a snapshot anywhere changes nothing', () => {
    const ops = [
      [{ t: 'sit', c: 0, name: 'Ada' }, ADA], [{ t: 'sit', c: 1, name: 'Grace' }, GRACE],
      [{ t: 'line', name: 'Ed' }, ED], [{ t: 'line', name: 'Ed' }, ED], [{ t: 'line', name: 'Lin' }, LIN],
      [{ t: 'move', n: 1, ply: 0, uci: 'e2e4' }, ADA], [{ t: 'move', n: 1, ply: 0, uci: 'e2e4' }, ADA],
      [{ t: 'resign', n: 1 }, GRACE], [{ t: 'new', n: 1 }, ADA], [{ t: 'new', n: 1 }, ED], [{ t: 'new', n: 1 }, ADA],
      [{ t: 'line', name: 'Mo' }, MO], [{ t: 'unline' }, LIN], [{ t: 'skip', n: 2, c: 0 }, ADA],
      [{ t: 'move', n: 2, ply: 0, uci: 'd2d4' }, GRACE], [{ t: 'offer', n: 2, ply: 1 }, ADA], [{ t: 'accept', n: 2, ply: 1 }, GRACE],
      [{ t: 'line', name: 'Lin' }, LIN], [{ t: 'new', n: 2 }, MO],
    ];
    const all = new Table();
    for (const [op, pid] of ops) all.apply(op, pid);
    expect(all.n).toBe(3);
    for (let cut = 0; cut <= ops.length; cut++) {
      const before = new Table();
      for (const [op, pid] of ops.slice(0, cut)) before.apply(op, pid);
      const after = new Table(JSON.parse(JSON.stringify(before.save())));
      for (const [op, pid] of ops.slice(cut)) after.apply(op, pid);
      expect(after.fingerprint(), `cut at ${cut}`).toBe(all.fingerprint());
      expect(after.save()).toEqual(all.save());
    }
  });
});
