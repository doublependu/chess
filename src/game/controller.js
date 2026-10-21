import { Game, RESULT } from '../core/game.js';
import { START_FEN, TYPE_NAMES } from '../core/constants.js';
import { buildMoveClip } from '../anim/clips.js';
import { finaleClip } from '../anim/finale.js';
import { Director, gameBaseElo } from '../ai/director.js';
import { newPlayerModel, normalizeModel, updateAfterGame } from '../ai/skill.js';
import { clamp, MAX_ELO } from '../ai/strength.js';
import {
  snapshot, restoreGame, loadSlots, saveSlot, loadAutosave, saveAutosave, clearAutosave, rewindPath,
  loadPlayer, savePlayer,
} from '../save/slots.js';
import { globalUniforms } from '../render/materials.js';
import { GLYPH } from '../ui/ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const levelElo = (L) => clamp(350 + (L - 1) * 230, 300, MAX_ELO);

export class Controller {
  constructor({ stage, ui, ai, audio, settings }) {
    this.stage = stage;
    this.ui = ui;
    this.ai = ai;
    this.audio = audio;
    this.settings = settings;
    this.player = normalizeModel(loadPlayer() || newPlayerModel());
    this.game = new Game();
    this.humanColor = 0;
    this.director = new Director(gameBaseElo(this.player), this.player.games);
    this.token = 0;
    this.phase = 'title'; // title | human | ai | animating | rewinding | over
    this.paused = false;
    this.selected = null;
    this.legalFrom = new Map();
    this.preEval = null; // human-perspective eval before the human's move
    this.evalForAI = 0;
    this.lastAIElo = this.director.base;
    this.rated = false;
    this.finale = null;
    this.events = [];
    /** In a room (`src/net/company.js`): the table is the truth, and the other side is a person. Null: the AI. */
    this.room = null;
    /** The move this page sent and has not seen come back yet: { n, ply, uci }. */
    this.sent = null;
    /** Which of the table's games the board shows. */
    this.roomN = 0;
    stage.views.reset(this.game.pieces());
  }

  log(type, data = {}) {
    this.events.push({ t: Math.round(performance.now()), type, ...data });
    if (this.events.length > 500) this.events.shift();
  }

  /** The colour this page plays: against the AI, the human's; in a room, its seat, or -1 for somebody watching. */
  get mySeat() { return this.room ? this.room.table.seatOf(this.room.me) : this.humanColor; }
  get humanTurn() { return this.game.turn === this.mySeat && !this.game.over; }
  get canInteract() { return this.phase === 'human' && !this.paused && !this.ui.open && !this.stage.animator.busy; }
  get animSpeed() { return this.settings.animSpeed || 1; }

  aiEloFor(evalForAI) {
    if (this.settings.difficulty !== 'auto') return levelElo(+this.settings.difficulty);
    return this.director.moveElo(evalForAI);
  }

  // ------------------------------------------------------------------ game lifecycle

  newGame(color) {
    if (this.room) return;
    this.token++;
    this.ai.cancel();
    this.stage.animator.finishAll();
    this.clearFinale();
    this.ui.closeAll();
    this.humanColor = color === 'random' ? (Math.random() < 0.5 ? 0 : 1) : color;
    this.game = new Game();
    this.director = new Director(gameBaseElo(this.player), this.player.games);
    this.lastAIElo = this.director.base;
    this.rated = false;
    this.preEval = null;
    this.evalForAI = 0;
    this.stage.views.reset(this.game.pieces());
    this.stage.setSide(this.humanColor);
    this.stage.rig.resetView();
    this.ui.setSides(this.humanColor);
    this.ui.showHud(true);
    this.stage.refreshInsets();
    this.log('newGame', { humanColor: this.humanColor, aiBase: Math.round(this.director.base) });
    this.afterPositionChange();
    this.nextTurn();
  }

  /** Restores a snapshot directly (no rewind animation) — used by "Continue". */
  restore(snap) {
    if (this.room) return false;
    const game = restoreGame(snap);
    if (!game) { this.ui.toast('That save could not be read.'); return false; }
    this.token++;
    this.ai.cancel();
    this.stage.animator.finishAll();
    this.clearFinale();
    this.ui.closeAll();
    this.game = game;
    this.humanColor = snap.humanColor === 1 ? 1 : 0;
    this.director = snap.director ? Director.fromJSON(snap.director, gameBaseElo(this.player)) : new Director(gameBaseElo(this.player), this.player.games);
    this.rated = game.over;
    this.preEval = null;
    this.replayViews();
    this.stage.setSide(this.humanColor);
    this.ui.setSides(this.humanColor);
    this.ui.showHud(true);
    this.stage.refreshInsets();
    this.afterPositionChange();
    if (game.over) this.showGameOver(false);
    else this.nextTurn();
    return true;
  }

  /** Rebuilds view bookkeeping (including captured pieces) by replaying the game logically. */
  replayViews() {
    const views = this.stage.views;
    views.reset(new Game({ startFen: this.game.startFen }).pieces());
    for (const rec of this.game.records) views.applyMove(rec);
    views.syncAll();
  }

  nextTurn() {
    if (this.game.over) { this.onGameOver(); return; }
    if (this.room) {
      if (this.humanTurn && !this.sent) this.startHumanTurn();
      else if (this.sent) { this.phase = 'sent'; this.roomHud(); }
      else this.waitForMove();
      return;
    }
    if (this.game.turn === this.humanColor) this.startHumanTurn();
    else this.aiTurn();
  }

  startHumanTurn() {
    this.phase = 'human';
    this.ui.setTurn(true);
    if (this.room) { this.roomHud(); return; }
    // Analyse the position while the human thinks (for grading their move).
    const token = this.token;
    const moves = this.game.uciList();
    this.preEval = null;
    this.prePromise = this.ai.analyze({ startFen: this.game.startFen, moves })
      .then((r) => { if (token === this.token) { this.preEval = r.score; this.evalForAI = -r.score; } })
      .catch(() => {});
  }

  // ------------------------------------------------------------------ human input

  select(square) {
    this.selected = square;
    this.stage.selected = square ? this.stage.views.at(square) : null;
    this.legalFrom.clear();
    if (square) {
      for (const u of this.game.legalUcis()) {
        if (u.startsWith(square)) {
          const to = u.slice(2, 4);
          if (!this.legalFrom.has(to)) this.legalFrom.set(to, []);
          this.legalFrom.get(to).push(u);
        }
      }
    }
    this.updateHighlights();
  }

  /**
   * @param square what was tapped (front-most piece surface, else the board square)
   * @param floor the board square under the finger — preferred when it's a legal target, because
   *   from a low camera angle the selected piece's own body covers the square right behind it.
   */
  onSquareTap(square, floor = null) {
    if (!this.canInteract || !square) return;
    if (this.selected && floor && floor !== square && this.legalFrom.has(floor) && !this.legalFrom.has(square)) square = floor;
    const piece = this.game.pieceAt(square);
    const own = piece && piece.color === this.mySeat;
    if (this.selected) {
      if (square === this.selected) { this.select(null); return; }
      if (this.legalFrom.has(square)) { this.tryMove(this.selected, square); return; }
      if (own) { this.select(square); this.audio.click(); return; }
      this.rejectMove();
      return;
    }
    if (own) { this.select(square); this.audio.click(); }
  }

  rejectMove() {
    const v = this.stage.views.at(this.selected);
    if (v) {
      // a quick "no" shake
      const start = performance.now();
      const shake = () => {
        const t = (performance.now() - start) / 1000;
        v.idleG.position.x = t < 0.3 ? Math.sin(t * 60) * 0.05 * (1 - t / 0.3) : 0;
        if (t < 0.3) requestAnimationFrame(shake);
      };
      shake();
    }
    this.select(null);
  }

  async tryMove(from, to) {
    const options = this.legalFrom.get(to) || [];
    if (!options.length) return;
    let uci = options[0];
    if (options.length > 1) {
      const type = await this.ui.pickPromotion(this.mySeat);
      if (!type) { this.select(null); return; }
      uci = options.find((u) => u.endsWith(' pnbrqk'[type])) || options[0];
    }
    this.select(null);
    await this.humanMove(uci);
  }

  onSan(text) {
    if (!this.canInteract || !text) return;
    const legal = this.game.legalMoves();
    const ucis = this.game.legalUcis();
    let uci = ucis.find((u) => u === text.toLowerCase());
    if (!uci) {
      // Compare against the SAN of each legal move.
      const clean = text.replace(/[+#!?]/g, '');
      for (let i = 0; i < legal.length && !uci; i++) {
        if (this.game.describe(legal[i], legal).san.replace(/[+#]/g, '') === clean) uci = ucis[i];
      }
    }
    if (!uci) { this.ui.toast(`"${text}" isn't a legal move here.`); return; }
    this.select(null);
    this.humanMove(uci);
  }

  async humanMove(uci) {
    if (this.room) { this.sendMove(uci); return; }
    const token = this.token;
    const pre = this.preEval;
    const rec = this.game.play(uci);
    this.log('human', { uci, san: rec.san });
    const anim = this.animateMove(rec);
    this.afterPositionChange(rec);
    // Grade the move (cheap fixed-budget analysis) while it animates.
    const moves = this.game.uciList();
    this.gradePromise = this.game.over ? Promise.resolve() : this.ai.analyze({ startFen: this.game.startFen, moves })
      .then((r) => {
        if (token !== this.token) return;
        this.evalForAI = r.score;
        if (pre !== null && this.game.ply > 8) this.director.observeHumanMove(pre, -r.score);
      })
      .catch(() => {});
    this.phase = 'animating';
    await anim.blocking;
    if (token !== this.token) return;
    this.nextTurn();
  }

  // ------------------------------------------------------------------ AI

  async aiTurn() {
    const token = this.token;
    this.phase = 'ai';
    this.ui.setTurn(false, { thinking: true });
    const started = performance.now();
    try {
      await Promise.race([this.gradePromise, sleep(1500)]);
      if (token !== this.token) return;
      if (this.settings.difficulty === 'auto' && this.director.shouldResign(this.evalForAI) && this.game.ply > 30) {
        await this.whenUnpaused(token);
        if (token !== this.token) return;
        this.game.resign(this.game.turn);
        this.log('aiResign');
        this.onGameOver();
        return;
      }
      const elo = this.aiEloFor(this.evalForAI);
      this.lastAIElo = elo;
      const res = await this.ai.chooseMove({ startFen: this.game.startFen, moves: this.game.uciList(), elo, seed: this.game.seed });
      if (token !== this.token) return;
      // Give the AI a human-feeling pause even when it answers instantly.
      const minThink = (res.book ? 450 : 650) + Math.random() * 650;
      const elapsed = performance.now() - started;
      if (elapsed < minThink) await sleep((minThink - elapsed) / Math.min(2, this.animSpeed));
      await this.whenUnpaused(token);
      if (token !== this.token || !res.uci) return;
      const rec = this.game.play(res.uci);
      this.log('ai', { uci: res.uci, san: rec.san, elo, score: res.score, book: res.book, oversight: !!res.oversight });
      this.ui.setTurn(false, { thinking: false });
      const anim = this.animateMove(rec);
      this.afterPositionChange(rec);
      this.phase = 'animating';
      await anim.blocking;
      if (token !== this.token) return;
      this.nextTurn();
    } catch (e) {
      if (e?.cancelled || token !== this.token) return;
      console.error('AI failed', e);
      this.ui.toast('The AI stumbled — retrying…');
      await sleep(500);
      if (token === this.token) this.aiTurn();
    }
  }

  whenUnpaused(token) {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => { if (!this.paused || token !== this.token) resolve(); else setTimeout(check, 100); };
      check();
    });
  }

  // ------------------------------------------------------------------ animation & HUD

  animateMove(rec, { speed = this.animSpeed, quick = false } = {}) {
    const inv = this.stage.views.applyMove(rec);
    const clip = buildMoveClip(this.stage, rec, inv, { audio: this.audio, gameSeed: this.game.seed });
    const s = quick ? speed * 2.5 : speed;
    const handle = this.stage.animator.play(clip, { speed: s });
    handle.done.then(() => { if (!this.stage.animator.active) this.stage.views.syncAll(); });
    handle.blocking.then(() => this.updateHighlights());
    return handle;
  }

  afterPositionChange(rec) {
    const g = this.game;
    this.stage.sideToMove = g.turn;
    this.stage.checkSquare = g.inCheck() ? g.kingSquare(g.turn) : null;
    this.ui.setCaptured(this.humanColor, g);
    this.ui.setTurn(this.humanTurn, { over: g.over });
    // A room's game is the room's: nobody saves a checkpoint of it, or overwrites their own game with it.
    this.ui.setSaveEnabled(!this.room && g.ply > 0 && this.phase !== 'rewinding');
    if (rec?.check && !rec.mate) {
      setTimeout(() => { this.audio.check(); this.ui.banner('Check!', 1100); }, 350 / this.animSpeed);
    }
    this.updateHighlights();
    if (this.room) this.roomHud();
    else if (g.ply > 0) saveAutosave(this.snap('Autosave'));
  }

  updateHighlights() {
    const map = new Map();
    const last = this.game.records[this.game.records.length - 1];
    if (last) { map.set(last.from, 'last'); map.set(last.to, 'last'); }
    if (this.selected) map.set(this.selected, 'selected');
    if (this.stage.checkSquare && !this.stage.animator.busy) map.set(this.stage.checkSquare, 'check');
    this.stage.board.setHighlights(map);
    const quiet = [], caps = [];
    if (this.selected && this.settings.showMoves) {
      for (const to of this.legalFrom.keys()) {
        const p = this.game.pieceAt(to);
        const ep = this.legalFrom.get(to)[0] && this.game.pieceAt(this.selected)?.type === 1 && to[0] !== this.selected[0] && !p;
        (p || ep ? caps : quiet).push(to);
      }
    }
    this.stage.board.setMarkers(quiet, caps);
  }

  // ------------------------------------------------------------------ game over

  onGameOver() {
    this.phase = 'over';
    this.ui.setTurn(false, { over: true });
    const r = this.game.result;
    if (r.status === RESULT.CHECKMATE && !this.finale) {
      const king = this.stage.views.at(this.game.kingSquare(r.winner ^ 1));
      if (king) {
        this.finale = finaleClip(this.stage, king, { audio: this.audio, seed: this.game.seed ^ 0xbeef, key: `${this.game.seed}:finale:${this.game.ply}` });
        const h = this.stage.animator.play(this.finale, { speed: Math.min(2, this.animSpeed) });
        h.blocking.then(() => this.showGameOver(true));
        return;
      }
    }
    setTimeout(() => this.showGameOver(true), 500);
  }

  clearFinale() {
    if (!this.finale) return;
    this.finale = null;
  }

  showGameOver(rate) {
    if (this.room) { this.showRoomGameOver(); return; }
    const r = this.game.result;
    const human = this.humanColor;
    const score = r.winner === null ? 0.5 : r.winner === human ? 1 : 0;
    const before = this.player.rating;
    if (rate && !this.rated && this.settings.difficulty === 'auto') {
      this.rated = true;
      this.player = updateAfterGame(this.player, {
        aiElo: this.director.base, score, acpl: this.director.acpl(), samples: this.director.losses.length,
        accuracy: this.director.meanAccuracy(),
      });
      savePlayer(this.player);
    } else if (rate && !this.rated) this.rated = true;
    this.audio.jingle(score >= 0.5);
    const reasons = {
      [RESULT.CHECKMATE]: 'by checkmate', [RESULT.STALEMATE]: 'Stalemate', [RESULT.THREEFOLD]: 'Threefold repetition',
      [RESULT.FIFTY]: 'Fifty-move rule', [RESULT.INSUFFICIENT]: 'Insufficient material', [RESULT.RESIGN]: 'by resignation',
    };
    const title = score === 1 ? 'You win!' : score === 0 ? 'The AI wins' : 'Draw';
    const reason = r.winner === null ? reasons[r.status] : `${r.winner === human ? 'You won' : 'AI won'} ${reasons[r.status]}`;
    this.log('gameOver', { status: r.status, score });
    clearAutosave();
    this.ui.showGameOver({
      title, reason, win: score === 1,
      glyph: score === 1 ? GLYPH[human][6] : score === 0 ? GLYPH[human ^ 1][6] : '½',
      ratingBefore: before, ratingAfter: this.player.rating,
      aiNext: Math.round(gameBaseElo(this.player)),
    });
  }

  resign() {
    if (this.room) {
      if (!this.game.over && this.mySeat !== -1) this.room.submit({ t: 'resign', n: this.room.table.n });
      this.ui.closeAll();
      return;
    }
    if (this.game.over || this.phase === 'rewinding') return;
    this.token++;
    this.ai.cancel();
    this.game.resign(this.humanColor);
    this.ui.closeAll();
    this.onGameOver();
  }

  // ------------------------------------------------------------------ pause

  pause() {
    if (this.phase === 'title' || this.paused) return;
    if (this.room) { this.roomMenu(); return; }
    this.paused = true;
    this.stage.animator.timeScale = 0;
    this.select(null);
    this.ui.showPause({
      aiElo: Math.round(this.settings.difficulty === 'auto' ? this.lastAIElo : levelElo(+this.settings.difficulty)),
      rating: this.player.rating,
      canSave: this.game.ply > 0 && this.phase !== 'rewinding',
      canResign: !this.game.over && this.phase !== 'rewinding',
    });
  }

  resume() {
    this.paused = false;
    this.stage.animator.timeScale = 1;
    this.ui.close('pause');
  }

  // ------------------------------------------------------------------ checkpoints

  snap(label) {
    return snapshot({ game: this.game, humanColor: this.humanColor, director: this.director, label });
  }

  label() {
    const g = this.game;
    const moveNo = Math.ceil(g.ply / 2);
    const side = g.turn === 0 ? 'White' : 'Black';
    const mat = g.material() * (this.humanColor === 0 ? 1 : -1);
    return `Move ${moveNo} · ${side} to move${mat ? ` · ${mat > 0 ? '+' : ''}${mat}` : ''}`;
  }

  thumbnail() {
    try {
      const { renderer, scene, rig } = this.stage;
      renderer.render(scene, rig.camera);
      const src = renderer.domElement;
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const g = c.getContext('2d');
      const ar = src.width / src.height, tar = 160 / 120;
      let sw = src.width, sh = src.height, sx = 0, sy = 0;
      if (ar > tar) { sw = src.height * tar; sx = (src.width - sw) / 2; } else { sh = src.width / tar; sy = (src.height - sh) / 2; }
      g.drawImage(src, sx, sy, sw, sh, 0, 0, 160, 120);
      return c.toDataURL('image/jpeg', 0.72);
    } catch {
      return null;
    }
  }

  openSave() {
    if (this.room) return;
    if (this.game.ply === 0 || this.phase === 'rewinding') { this.ui.toast('Make a move first.'); return; }
    const slots = loadSlots();
    this.ui.showSlots('save', slots, async (i, existing) => {
      if (existing && !(await this.ui.confirm(`Overwrite slot ${i + 1}?`, 'Overwrite'))) return;
      const snap = this.snap(this.label());
      this.ui.close('slots');
      snap.thumb = this.thumbnail();
      if (saveSlot(i, snap)) { this.ui.toast(`Saved to slot ${i + 1}`); this.log('save', { slot: i }); }
      else this.ui.toast('Could not save (storage full or blocked).');
    });
  }

  openLoad() {
    if (this.room) return;
    const slots = loadSlots();
    if (!slots.some(Boolean)) { this.ui.toast('No checkpoints saved yet.'); return; }
    this.ui.showSlots('load', slots, (i, snap) => {
      if (!snap) return;
      this.ui.closeAll();
      if (this.phase === 'title') { this.restore(snap); return; }
      this.resume();
      this.rewindTo(snap);
    });
  }

  /**
   * Rewinds time to a checkpoint: plays moves backwards (shards fly back and fuse), then
   * fast-forwards along the checkpoint's own line if it diverged from the current game.
   */
  async rewindTo(snap) {
    const target = restoreGame(snap);
    if (!target) { this.ui.toast('That checkpoint could not be read.'); return; }
    const token = ++this.token;
    this.ai.cancel();
    this.select(null);
    this.ui.closeAll();
    this.stage.animator.finishAll();
    this.phase = 'rewinding';
    this.ui.setSaveEnabled(false);
    this.log('rewind', { from: this.game.ply, to: target.ply });
    const path = rewindPath(this.game.uciList(), target.uciList());
    const stage = this.stage;
    const steps = path.back + path.forward.length + (this.finale ? 1 : 0);
    const budget = 6.5;
    // Estimated natural time per ply ~1.0s (captures longer); speed up long rewinds.
    const speed = Math.max(1.25, Math.min(8, (steps * 1.1) / budget)) * Math.max(1, this.animSpeed * 0.8);
    stage.frozen = true;
    this.ui.setRewinding(true);
    this.audio.rewind(Math.min(budget, steps * 1.1 / speed + 0.6));
    const warp = (v) => { globalUniforms.uTimeWarp.value = v; };
    for (let i = 0; i <= 10; i++) { warp(i / 10); await sleep(25); }
    if (token !== this.token) return;

    // Undo the checkmate finale first.
    if (this.finale) {
      const f = finaleClip(stage, this.finale.king, { audio: null, seed: this.finale.seed, key: this.finale.key });
      await Promise.race([f.prepared, sleep(1500)]);
      const h = stage.animator.play(f, { reverse: true, speed: speed * 1.4, speedFn: (t, c) => (t > c.blocking ? 3 : 1) });
      await h.done;
      this.finale = null;
    }

    // Reverse plies, newest first. Kick off every destruction request up front.
    const views = stage.views;
    const plan = [];
    for (let i = 0; i < path.back; i++) {
      const { rec, inv } = views.history[views.history.length - 1 - i];
      plan.push({ rec, inv });
    }
    const clips = plan.map(({ rec, inv }) => buildMoveClip(stage, rec, inv, { audio: null, gameSeed: this.game.seed, reverse: true }));
    for (let i = 0; i < clips.length; i++) {
      if (token !== this.token) return;
      const clip = clips[i];
      if (clip.prepared && !clip.ready?.()) await Promise.race([clip.prepared, sleep(1500)]);
      // Debris rushes back quickly, then the attack plays backwards at the rewind speed.
      const h = stage.animator.play(clip, { reverse: true, speed, speedFn: (t, c) => (t > c.blocking ? 3.2 : 1) });
      await h.done;
      const undone = views.undoMove();
      this.game.undo();
      if (undone?.inv.promoted) views.discard(undone.inv.promoted);
      views.syncAll();
      this.stage.sideToMove = this.game.turn;
      this.ui.setCaptured(this.humanColor, this.game);
    }
    if (token !== this.token) return;

    // Fast-forward along the checkpoint's line (different branch or later save).
    if (path.forward.length) {
      this.game.seed = target.seed;
      for (const uci of path.forward) {
        if (token !== this.token) return;
        const rec = this.game.play(uci);
        const h = this.animateMove(rec, { speed: speed * 1.2 });
        this.ui.setCaptured(this.humanColor, this.game);
        await h.blocking;
      }
    }
    stage.animator.finishAll();
    // Adopt the checkpoint exactly.
    this.game = target;
    this.replayViews();
    if (snap.humanColor !== this.humanColor) {
      this.humanColor = snap.humanColor === 1 ? 1 : 0;
      stage.setSide(this.humanColor);
      this.ui.setSides(this.humanColor);
    }
    this.director = snap.director ? Director.fromJSON(snap.director, gameBaseElo(this.player)) : this.director;
    this.rated = false;
    this.preEval = null;
    for (let i = 10; i >= 0; i--) { warp(i / 10); await sleep(30); }
    stage.frozen = false;
    this.ui.setRewinding(false);
    this.ui.toast('Time rewound to the checkpoint');
    this.phase = 'animating';
    this.afterPositionChange();
    if (token !== this.token) return;
    this.nextTurn();
  }

  // ------------------------------------------------------------------ a room

  /**
   * Into a room. `room` is `src/net/company.js`'s handle: `table`, `me` (this player's id), `submit(op)`,
   * `presence(pid)`. The game against the AI is left where it was; its autosave stays for later.
   */
  enterRoom(room) {
    this.room = room;
    this.ui.setRoomMode(true);
    this.paused = false;
    this.stage.animator.timeScale = 1;
    this.adoptTable();
  }

  /** Out of the room: back to the title, and to the AI. */
  leaveRoom() {
    if (!this.room) return;
    this.room = null;
    this.sent = null;
    clearTimeout(this.sentTimer);
    this.token++;
    this.stage.animator.finishAll();
    this.clearFinale();
    this.ui.closeAll();
    this.ui.setNames('You', 'AI');
    this.ui.setRoomMode(false);
    this.game = new Game();
    this.humanColor = 0;
    this.stage.views.reset(this.game.pieces());
    this.stage.setSide(0);
    this.ui.setSides(0);
    this.select(null);
    this.phase = 'title';
    this.onLeftRoom?.();
  }

  /** The board as the table has it, at once and without animation: on entering, and whenever the two disagree. */
  adoptTable() {
    const t = this.room.table;
    this.token++;
    this.ai.cancel();
    this.stage.animator.finishAll();
    this.clearFinale();
    this.ui.closeAll();
    this.select(null);
    this.sent = null;
    clearTimeout(this.sentTimer);
    this.roomN = t.n;
    this.game = t.copy();
    const seat = this.mySeat;
    this.humanColor = seat === -1 ? 0 : seat;
    this.replayViews();
    this.stage.setSide(this.humanColor);
    this.ui.setSides(this.humanColor);
    this.ui.showHud(true);
    this.stage.refreshInsets();
    this.phase = 'between';
    this.afterPositionChange();
    this.log('table', { n: t.n, ply: t.moves.length });
    if (this.game.over) { this.phase = 'over'; this.ui.setTurn(false, { over: true }); this.roomHud(); }
    else this.nextTurn();
  }

  /**
   * The table changed: catch the board up with it, one move at a time and animated, or all at once when it is not
   * a move or two further along the same game. Called again when each animation is done.
   */
  follow() {
    if (!this.room) return;
    const t = this.room.table;
    if (this.phase === 'animating') return;
    const mine = this.game.uciList();
    const same = this.roomN === t.n && mine.length <= t.moves.length && mine.every((u, i) => u === t.moves[i]);
    // Somebody sat down or got up: which side this page plays may have changed.
    const seat = this.mySeat;
    if (!same || (seat !== -1 && seat !== this.humanColor)) { this.adoptTable(); return; }
    if (mine.length < t.moves.length) {
      const rec = this.game.play(t.moves[mine.length]);
      if (this.sent && this.sent.ply <= rec.ply) { this.sent = null; clearTimeout(this.sentTimer); }
      this.select(null);
      const token = this.token;
      const anim = this.animateMove(rec);
      this.afterPositionChange(rec);
      this.phase = 'animating';
      anim.blocking.then(() => {
        if (token !== this.token) return;
        this.phase = 'between';
        this.follow();
      });
      return;
    }
    if (t.ended && !this.game.over) {
      if (t.ended.how === 'resign') this.game.resign(t.ended.by);
      else this.game.agree();
      this.select(null);
      this.afterPositionChange();
    }
    if (this.game.over) {
      if (this.phase !== 'over') this.onGameOver();
      this.roomHud();
      return;
    }
    if (this.phase !== 'human') this.nextTurn();
    else this.roomHud();
  }

  /** The other side's move: it comes through the table. */
  waitForMove() {
    this.phase = 'remote';
    this.ui.setTurn(false);
    this.roomHud();
  }

  /** This side's move, as an op: the board plays it when it comes back, as every other page does. */
  sendMove(uci) {
    const t = this.room.table;
    const sent = { n: t.n, ply: this.game.ply, uci };
    if (!this.room.submit({ t: 'move', ...sent })) {
      this.ui.toast('Not connected: the move was not sent. Try again in a moment.');
      return;
    }
    this.sent = sent;
    this.phase = 'sent';
    this.log('sent', sent);
    this.roomHud();
    // An op on its way when the connection drops never arrives (p3p2 sends it once). So it goes again: the table
    // takes a ply only once, so a copy that comes late changes nothing. After a few tries the move is the player's
    // to make again.
    clearTimeout(this.sentTimer);
    let tries = 1;
    const again = () => {
      if (this.sent !== sent || !this.room) return;
      if (tries < 4 && this.room.submit({ t: 'move', ...sent })) {
        tries++;
        this.log('resent', sent);
        this.sentTimer = setTimeout(again, 4000);
        return;
      }
      this.sent = null;
      if (this.phase === 'sent') {
        this.ui.toast('The move did not reach the room: play it again.');
        this.nextTurn();
      }
    };
    this.sentTimer = setTimeout(again, 4000);
  }

  /** Who is where, whose move it is, and who is not here: the two name plates. */
  roomHud() {
    if (!this.room) return;
    const t = this.room.table;
    const seat = this.mySeat;
    const bottom = seat === -1 ? 0 : seat;
    const top = bottom ^ 1;
    const plate = (c) => (t.seats[c] ? t.names[c] : c === 0 ? 'White: empty seat' : 'Black: empty seat');
    this.ui.setNames(seat === -1 ? plate(bottom) : `${t.names[seat]} (you)`, plate(top));
    const status = (c) => {
      if (this.game.over) return 'Game over';
      if (!t.seats[c]) return 'Waiting for a player';
      const here = this.room.presence(t.seats[c]);
      const away = here === 'away' ? ' · away' : here === 'lost' ? ' · connection lost' : here === null ? ' · not here' : '';
      if (c === seat && this.phase === 'sent') return 'Sending…';
      if (t.offer && t.offer.ply === t.moves.length && t.offer.by === c) return (c === seat ? 'Draw offered' : 'Offers a draw') + away;
      return (this.game.turn === c ? (c === seat ? 'Your move' : 'To move') : 'Waiting') + away;
    };
    this.ui.setTurn(this.game.turn === bottom && !this.game.over, { over: this.game.over, youText: status(bottom), aiText: status(top) });
  }

  /** The game is over: who won, said from where this page sits, and the next game for whoever is seated. */
  showRoomGameOver() {
    const t = this.room.table;
    const r = this.game.result;
    const seat = this.mySeat;
    const reasons = {
      [RESULT.CHECKMATE]: 'by checkmate', [RESULT.STALEMATE]: 'Stalemate', [RESULT.THREEFOLD]: 'Threefold repetition',
      [RESULT.FIFTY]: 'Fifty-move rule', [RESULT.INSUFFICIENT]: 'Insufficient material', [RESULT.RESIGN]: 'by resignation',
      [RESULT.AGREED]: 'Agreed',
    };
    const who = (c) => t.names[c] || (c === 0 ? 'White' : 'Black');
    const title = r.winner === null ? 'Draw' : r.winner === seat ? 'You win!' : `${who(r.winner)} wins`;
    const reason = r.winner === null ? reasons[r.status] : `${r.winner === seat ? 'You won' : `${who(r.winner)} won`} ${reasons[r.status]}`;
    this.log('gameOver', { status: r.status, winner: r.winner });
    if (seat !== -1) this.audio.jingle(r.winner === null || r.winner === seat);
    this.ui.showRoomGameOver({
      title, reason, win: r.winner === seat,
      glyph: r.winner === null ? '½' : GLYPH[r.winner][6],
      onRematch: seat === -1 ? null : () => this.room?.submit({ t: 'new', n: t.n }),
    });
  }

  /** The menu in a room: no saving, no AI; a draw, resigning, and the seat. */
  roomMenu() {
    const t = this.room.table;
    const seat = this.mySeat;
    const playing = seat !== -1 && !this.game.over;
    const free = t.seats.indexOf(null);
    const standing = t.offer && t.offer.ply === t.moves.length;
    this.ui.showRoomMenu({
      seated: seat !== -1,
      canOffer: playing && !standing,
      // The question about a draw is asked once; an answer lost on the way (or a "Cancel" regretted) is given here.
      canAccept: playing && standing && t.offer.by !== seat,
      onAccept: () => this.room?.submit({ t: 'accept', n: t.n, ply: t.moves.length }),
      canResign: playing,
      canNew: seat !== -1 && (this.game.over || t.moves.length === 0),
      canSit: seat === -1 && free !== -1,
      onOffer: () => this.room?.submit({ t: 'offer', n: t.n, ply: t.moves.length }),
      onResign: async () => { if (await this.ui.confirm('Resign this game?', 'Resign')) this.resign(); },
      onNew: () => this.room?.submit({ t: 'new', n: t.n }),
      onStand: async () => {
        const lose = playing && t.moves.length > 0;
        if (!lose || (await this.ui.confirm('Give up your seat? The game in progress counts as lost.', 'Give up the seat'))) this.room?.submit({ t: 'stand' });
      },
      onSit: () => this.room?.sit(free),
    });
  }

  /** The other side offers a draw. */
  async offered(by) {
    const t = this.room.table;
    if (this.mySeat === -1 || this.mySeat === by) return;
    const ply = t.moves.length;
    const yes = await this.ui.confirm(`${t.names[by] || 'Your opponent'} offers a draw.`, 'Accept the draw');
    if (yes && this.room && this.room.table.offer?.ply === ply) this.room.submit({ t: 'accept', n: t.n, ply });
  }

  // ------------------------------------------------------------------ debug/test hooks

  state() {
    return {
      fen: this.game.fen(), startFen: this.game.startFen, ply: this.game.ply, turn: this.game.turn, humanColor: this.humanColor, phase: this.phase,
      over: this.game.over, result: this.game.result, busy: this.stage.animator.busy, animating: this.stage.animator.active,
      paused: this.paused, overlay: this.ui.top || null, aiElo: Math.round(this.lastAIElo), rating: this.player.rating,
      tier: this.stage.tierName, moves: this.game.uciList(),
      room: this.room ? {
        seat: this.mySeat, n: this.room.table.n, seats: this.room.table.seats.slice(), names: this.room.table.names.slice(),
        moves: this.room.table.moves.slice(), offer: this.room.table.offer, fingerprint: this.room.table.fingerprint(), sent: this.sent,
      } : null,
    };
  }

  /** Verifies the scene matches the rules engine (used by playtests). */
  checkScene() {
    const problems = [];
    const pieces = this.game.pieces();
    const views = this.stage.views;
    // After checkmate the mated king explodes on purpose.
    const r = this.game.result;
    const matedKing = r.status === RESULT.CHECKMATE && this.phase === 'over' ? this.game.kingSquare(r.winner ^ 1) : null;
    for (const p of pieces) {
      if (p.square === matedKing) continue;
      const v = views.at(p.square);
      if (!v) { problems.push(`no view on ${p.square}`); continue; }
      if (v.type !== p.type || v.color !== p.color) problems.push(`${p.square}: view ${TYPE_NAMES[v.type]}/${v.color} vs ${TYPE_NAMES[p.type]}/${p.color}`);
      if (!v.root.visible) problems.push(`${p.square}: invisible`);
      const dx = v.root.position.x - (p.square.charCodeAt(0) - 97 - 3.5);
      const dz = v.root.position.z - (3.5 - (p.square.charCodeAt(1) - 49));
      if (!this.stage.animator.active && Math.hypot(dx, dz) > 0.05) problems.push(`${p.square}: misplaced by ${Math.hypot(dx, dz).toFixed(2)}`);
    }
    const visible = views.views.filter((v) => v.root.visible && v.alive).length;
    const expected = pieces.length - (matedKing ? 1 : 0);
    if (!this.stage.animator.active && visible !== expected) problems.push(`visible views ${visible} != pieces ${expected}`);
    return problems;
  }
}

export { START_FEN };
