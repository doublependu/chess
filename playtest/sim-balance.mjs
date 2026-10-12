// Headless balance simulation: each persona plays a series of games against the adaptive AI,
// starting from a fresh skill model, exactly as a new player would.
// Usage: node playtest/sim-balance.mjs [--games 30] [--personas beginner,casual,club,strong]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Game, RESULT } from '../src/core/game.js';
import { Brain } from '../src/ai/brain.js';
import { Director, gameBaseElo } from '../src/ai/director.js';
import { newPlayerModel, updateAfterGame } from '../src/ai/skill.js';
import { mulberry32 } from '../src/ai/strength.js';
import { PERSONAS, PersonaPlayer } from './personas.js';

const MAX_PLIES = 220;

function playGame({ brain, persona, model, humanColor, seed, analysisNodes }) {
  const rng = mulberry32(seed);
  const human = new PersonaPlayer(persona, rng);
  const game = new Game({ seed });
  const director = new Director(gameBaseElo(model), model.games);
  const startElo = director.base;
  let preEval = null; // human-perspective eval before the human moves
  let evalForAI = 0;
  let aiGifts = 0, maxAIAdv = -Infinity, maxHumanAdv = -Infinity;
  const elos = [];
  while (!game.over && game.ply < MAX_PLIES) {
    const moves = game.uciList();
    if (game.turn === humanColor) {
      if (preEval === null) preEval = brain.analyze({ moves, maxNodes: analysisNodes }).score;
      const uci = human.choose(game.startFen, moves);
      game.play(uci);
      if (game.over) break;
      const post = brain.analyze({ moves: game.uciList(), maxNodes: analysisNodes }).score; // AI to move
      if (game.ply > 8) director.observeHumanMove(preEval, -post);
      evalForAI = post;
      preEval = null;
    } else {
      if (director.shouldResign(evalForAI)) { game.resign(game.turn); break; }
      const elo = director.moveElo(evalForAI);
      elos.push(elo);
      const r = brain.chooseMove({ moves, elo, seed: seed + game.ply });
      game.play(r.uci);
      if (game.over) break;
      const a = brain.analyze({ moves: game.uciList(), maxNodes: analysisNodes });
      preEval = a.score; // human to move
      const aiView = -a.score;
      if (r.bestScore !== undefined && r.bestScore - aiView > 300 && evalForAI > -300) aiGifts++;
      maxAIAdv = Math.max(maxAIAdv, aiView);
      maxHumanAdv = Math.max(maxHumanAdv, a.score);
      evalForAI = aiView;
    }
  }
  let score;
  if (game.over) {
    const w = game.result.winner;
    score = w === null ? 0.5 : w === humanColor ? 1 : 0;
  } else {
    // Adjudicate very long games by evaluation.
    score = evalForAI > 400 ? 0 : evalForAI < -400 ? 1 : 0.5;
  }
  const accuracy = director.meanAccuracy();
  const acpl = director.acpl();
  const meanElo = elos.length ? elos.reduce((a, b) => a + b, 0) / elos.length : startElo;
  return {
    score, plies: game.ply, status: game.over ? game.result.status : 'adjudicated',
    startElo: Math.round(startElo), meanElo: Math.round(meanElo), accuracy: accuracy && Math.round(accuracy),
    acpl: acpl && Math.round(acpl), samples: director.losses.length,
    aiGifts, comeback: score === 1 && maxAIAdv > 300, maxAIAdv, maxHumanAdv,
    humanMoves: Math.floor(game.ply / 2), pgn: game.records.map((r) => r.san).join(' '),
    // Same as the game controller: the calibrated base (in-game easing is a deliberate handicap).
    aiEloUsed: director.base,
  };
}

function runPersona({ key, games, seed, analysisNodes }) {
  const persona = PERSONAS[key];
  const brain = new Brain(18);
  let model = newPlayerModel();
  const results = [];
  for (let g = 0; g < games; g++) {
    const humanColor = g % 2;
    const r = playGame({ brain, persona, model, humanColor, seed: seed + g * 7919, analysisNodes });
    model = updateAfterGame(model, { aiElo: r.aiEloUsed, score: r.score, acpl: r.acpl, samples: r.samples, accuracy: r.accuracy });
    results.push({ game: g + 1, humanColor, ...r, ratingAfter: model.rating });
    if (parentPort) parentPort.postMessage({ progress: { key, game: g + 1, score: r.score, rating: model.rating, startElo: r.startElo, meanElo: r.meanElo, acpl: r.acpl, accuracy: r.accuracy } });
  }
  return results;
}

function summarize(key, results) {
  const window = (a, b) => results.slice(a, b);
  const mean = (xs, f) => (xs.length ? xs.reduce((s, x) => s + f(x), 0) / xs.length : NaN);
  const after5 = window(5, results.length);
  return {
    persona: PERSONAS[key].label,
    games: results.length,
    scoreAll: mean(results, (r) => r.score),
    scoreFirst5: mean(window(0, 5), (r) => r.score),
    scoreAfter5: mean(after5, (r) => r.score),
    winsFirst5: window(0, 5).filter((r) => r.score === 1).length,
    finalRating: results.at(-1)?.ratingAfter,
    meanPlies: mean(results, (r) => r.plies),
    comebacks: results.filter((r) => r.comeback).length,
    aiGiftsPerGame: mean(results, (r) => r.aiGifts),
    statuses: results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}),
  };
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
  const games = +arg('games', 24);
  const keys = arg('personas', Object.keys(PERSONAS).join(',')).split(',');
  const seed = +arg('seed', 1234);
  const analysisNodes = +arg('analysis-nodes', 15000);
  const outDir = `playtest-output/balance-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  mkdirSync(outDir, { recursive: true });
  const all = {};
  const t0 = Date.now();
  await Promise.all(keys.map((key) => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { key, games, seed, analysisNodes } });
    w.on('message', (msg) => {
      if (msg.progress) {
        const p = msg.progress;
        console.log(`[${p.key}] game ${p.game}: ${p.score === 1 ? 'human won' : p.score === 0 ? 'AI won' : 'draw'} (AI ${p.startElo}→avg ${p.meanElo}, ACPL ${p.acpl}, acc ${p.accuracy}, player rating -> ${p.rating})`);
      } else if (msg.results) { all[key] = msg.results; resolve(); }
    });
    w.on('error', reject);
  })));
  const summary = Object.fromEntries(keys.map((k) => [k, summarize(k, all[k])]));
  writeFileSync(`${outDir}/results.json`, JSON.stringify({ games, seed, analysisNodes, summary, results: all }, null, 2));
  const pgn = keys.flatMap((k) => all[k].map((r) => `[Event "balance ${k} #${r.game}"]\n[Result "${r.score === 1 ? (r.humanColor === 0 ? '1-0' : '0-1') : r.score === 0 ? (r.humanColor === 0 ? '0-1' : '1-0') : '1/2-1/2'}"]\n\n${r.pgn}\n`));
  writeFileSync(`${outDir}/games.pgn`, pgn.join('\n'));
  console.log('\n=== Balance summary ===');
  console.table(Object.fromEntries(Object.entries(summary).map(([k, s]) => [k, {
    games: s.games, 'score first5': s.scoreFirst5.toFixed(2), 'score after5': s.scoreAfter5.toFixed(2),
    'wins first5': s.winsFirst5, rating: s.finalRating, plies: s.meanPlies.toFixed(0), comebacks: s.comebacks, 'gifts/game': s.aiGiftsPerGame.toFixed(2),
  }])));
  // Acceptance targets from ai/plan_0.md §14.3
  let ok = true;
  for (const [k, s] of Object.entries(summary)) {
    if (s.games > 5 && (s.scoreAfter5 < 0.35 || s.scoreAfter5 > 0.6)) { ok = false; console.log(`✗ ${k}: score after game 5 = ${s.scoreAfter5.toFixed(2)} (target 0.35–0.60)`); }
  }
  if (summary.beginner && summary.beginner.winsFirst5 < 1) { ok = false; console.log('✗ beginner won none of the first 5 games'); }
  console.log(ok ? '✓ balance targets met' : '✗ balance targets NOT met');
  console.log(`Output: ${outDir} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  process.exitCode = ok ? 0 : 1;
} else {
  const results = runPersona(workerData);
  parentPort.postMessage({ results });
}
