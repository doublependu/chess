// Plain-DOM user interface: HUD, menus, dialogs. Styles live inline in index.html.
const GLYPH = [
  ['', '♙', '♘', '♗', '♖', '♕', '♔'],
  ['', '♟', '♞', '♝', '♜', '♛', '♚'],
];
export const GITHUB_URL = 'https://github.com/doublependu/chess';
export const MAIZE_URL = 'https://maize.live';
/** How to make a room for playing with friends. */
export const P3P2_URL = 'https://p3p2.me/#start';

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

/** Tiny hyperscript helper. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);

export class UI {
  constructor({ audio }) {
    this.audio = audio;
    this.root = $('overlay-root');
    this.hud = $('hud');
    this.toastEl = $('toast');
    this.bannerEl = $('banner');
    this.stack = [];
    this.handlers = {};
    // The loading screen is removed after boot, so keep a copy of its GitHub corner.
    this.cornerTemplate = document.querySelector('#loading .github-corner')?.cloneNode(true) || null;
    for (const [id, action] of [['btn-menu', 'pause'], ['btn-save', 'save'], ['btn-load', 'load'], ['btn-view', 'resetView'], ['btn-people', 'people']]) {
      $(id).addEventListener('click', () => { this.audio?.click(); this.emit(action); });
    }
    const san = $('san-input');
    san.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { this.emit('san', san.value.trim()); san.value = ''; }
      if (e.key === 'Escape') san.blur();
    });
  }

  on(action, fn) { this.handlers[action] = fn; }
  emit(action, ...args) { this.handlers[action]?.(...args); }

  // ---------- loading ----------
  progress(pct, text) {
    const bar = $('load-bar');
    if (bar) bar.style.width = Math.max(4, Math.min(100, pct)) + '%';
    if (text) $('load-status').textContent = text;
  }
  hideLoading() {
    const l = $('loading');
    if (!l) return;
    l.classList.add('fade');
    setTimeout(() => l.remove(), 600);
  }
  fatal(html) {
    const l = $('loading');
    if (l) l.querySelector('.load-box').innerHTML = `<div class="unsupported">${html}</div>`;
  }

  githubCorner() {
    const src = this.cornerTemplate || document.querySelector('#loading .github-corner');
    if (src) return src.cloneNode(true);
    return h('a', { href: GITHUB_URL, class: 'github-corner', target: '_blank', rel: 'noopener', 'aria-label': 'Fork me on GitHub' }, 'Fork me on GitHub');
  }

  // ---------- overlays ----------
  get open() { return this.stack.length > 0; }
  get top() { return this.stack[this.stack.length - 1]?.name; }

  show(name, panel, { corner = false, clear = false, dismiss = null } = {}) {
    const ov = h('div', { class: 'overlay' + (clear ? ' clear' : ''), 'data-name': name });
    if (corner) ov.append(this.githubCorner());
    ov.append(panel);
    if (dismiss) ov.addEventListener('pointerdown', (e) => { if (e.target === ov) dismiss(); });
    this.root.append(ov);
    this.stack.push({ name, el: ov });
    const first = panel.querySelector('button:not([disabled])');
    first?.focus({ preventScroll: true });
    return ov;
  }

  close(name) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (!name || this.stack[i].name === name) {
        this.stack[i].el.remove();
        this.stack.splice(i, 1);
        if (name) return;
      }
    }
  }
  closeAll() { while (this.stack.length) this.stack.pop().el.remove(); }

  btn(label, onClick, cls = '', attrs = {}) {
    return h('button', { class: 'btn ' + cls, onclick: () => { this.audio?.click(); onClick(); }, ...attrs }, label);
  }

  /** "Play with a friend", and right under it where to get a room for it. */
  friendButton() {
    return [
      this.btn('👥 Play with a friend', () => this.emit('people')),
      h('p', { class: 'hint' }, 'Need a room? Make one free at ', link(P3P2_URL, 'p3p2.me ↗')),
    ];
  }

  showTitle({ hasAutosave, hasSlots, rating }) {
    this.closeAll();
    const panel = h('div', { class: 'panel' },
      h('h2', {}, 'Sky Arena Chess'),
      h('p', { class: 'lead' }, 'The AI adapts to how you play — expect a fair fight. Capture to shatter, save checkpoints to rewind time.'),
      h('div', { class: 'menu' },
        hasAutosave ? this.btn('Continue game', () => this.emit('continue'), 'primary') : null,
        h('div', { class: 'row' },
          this.btn('♔ Play White', () => this.emit('newGame', 0), hasAutosave ? '' : 'primary'),
          this.btn('♚ Play Black', () => this.emit('newGame', 1)),
        ),
        this.btn('🎲 Random side', () => this.emit('newGame', 'random')),
        ...this.friendButton(),
        this.btn('⏪ Load checkpoint', () => this.emit('load'), '', { disabled: !hasSlots }),
        this.btn('⚙ Settings', () => this.emit('settings')),
      ),
      h('p', { class: 'fineprint' }, rating ? `Your estimated level: ~${rating} · ` : '',
        h('a', { href: GITHUB_URL, target: '_blank', rel: 'noopener' }, 'Fork me on GitHub')),
    );
    this.show('title', panel, { corner: true });
  }

  showPause({ aiElo, rating, canSave, canResign }) {
    this.close('pause');
    const panel = h('div', { class: 'panel' },
      h('h2', {}, 'Paused'),
      h('p', { class: 'lead' }, `AI level ≈ ${aiElo} · your level ≈ ${rating}`),
      h('div', { class: 'menu' },
        this.btn('▶ Resume', () => this.emit('resume'), 'primary'),
        h('div', { class: 'row' },
          this.btn('💾 Save', () => this.emit('save'), '', { disabled: !canSave }),
          this.btn('⏪ Load', () => this.emit('load')),
        ),
        this.btn('♻ New game', () => this.emit('newGameMenu')),
        ...this.friendButton(),
        this.btn('🏳 Resign', () => this.emit('resign'), 'danger', { disabled: !canResign }),
        this.btn('⚙ Settings', () => this.emit('settings')),
      ),
      h('p', { class: 'fineprint' }, link(GITHUB_URL, 'Fork me on GitHub'), ' · ', link(MAIZE_URL, 'More games on Maize.Live')),
      h('p', { class: 'fineprint' }, 'Keys: ', h('span', { class: 'kbd' }, 'Esc'), ' pause, ', h('span', { class: 'kbd' }, '/'), ' type a move'),
    );
    this.show('pause', panel, { corner: true, dismiss: () => this.emit('resume') });
  }

  showNewGame() {
    const panel = h('div', { class: 'panel' },
      h('h2', {}, 'New game'),
      h('p', { class: 'lead' }, 'The current game will be abandoned (your checkpoints stay).'),
      h('div', { class: 'menu' },
        h('div', { class: 'row' },
          this.btn('♔ White', () => this.emit('newGame', 0), 'primary'),
          this.btn('♚ Black', () => this.emit('newGame', 1)),
        ),
        this.btn('🎲 Random side', () => this.emit('newGame', 'random')),
        this.btn('Cancel', () => this.close('newgame')),
      ),
    );
    this.show('newgame', panel, { dismiss: () => this.close('newgame') });
  }

  seg(options, value, onChange) {
    const wrap = h('div', { class: 'seg', role: 'radiogroup' });
    for (const [v, label] of options) {
      const b = h('button', { class: v === value ? 'on' : '', role: 'radio', 'aria-checked': String(v === value) }, label);
      b.addEventListener('click', () => {
        this.audio?.click();
        wrap.querySelectorAll('button').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
        b.classList.add('on'); b.setAttribute('aria-checked', 'true');
        onChange(v);
      });
      wrap.append(b);
    }
    return wrap;
  }

  showSettings(settings, info, onChange) {
    this.close('settings');
    const set = (k) => (v) => onChange(k, v);
    const panel = h('div', { class: 'panel' },
      h('h2', {}, 'Settings'),
      h('div', { class: 'setting' }, h('label', { class: 'h' }, `Graphics (auto picked: ${info.autoTier}; now: ${info.tier})`),
        this.seg([['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], settings.graphics, set('graphics'))),
      h('div', { class: 'setting' }, h('label', { class: 'h' }, 'AI difficulty'),
        this.seg([['auto', 'Adaptive'], [2, 'Easy'], [4, 'Fair'], [6, 'Hard'], [8, 'Expert'], [10, 'Max']], settings.difficulty, set('difficulty'))),
      h('div', { class: 'setting' }, h('label', { class: 'h' }, 'Animation speed'),
        this.seg([[1, 'Cinematic'], [1.8, 'Fast'], [4, 'Instant']], settings.animSpeed, set('animSpeed'))),
      h('div', { class: 'setting' }, h('label', { class: 'h' }, 'Sound'),
        this.seg([[true, 'On'], [false, 'Off']], settings.sound, set('sound'))),
      h('div', { class: 'setting' }, h('label', { class: 'h' }, `Idle animation (auto picked: ${info.idleAuto})`),
        this.seg([['auto', 'Auto'], ['full', 'Full'], ['calm', 'Calm'], ['off', 'Off']], settings.idleMotion, set('idleMotion'))),
      h('div', { class: 'setting' }, h('label', { class: 'h' }, 'Reduce motion (no camera shake)'),
        this.seg([[false, 'Off'], [true, 'On']], settings.reducedMotion, set('reducedMotion'))),
      h('div', { class: 'setting' }, h('label', { class: 'h' }, 'Show legal moves'),
        this.seg([[true, 'On'], [false, 'Off']], settings.showMoves, set('showMoves'))),
      h('div', { class: 'setting' }, h('label', { class: 'h' }, 'Move input box (type moves like Nf3)'),
        this.seg([[false, 'Off'], [true, 'On']], settings.showSanInput, set('showSanInput'))),
      h('p', { class: 'fineprint' }, `GPU: ${info.gpu} · ${info.fps} fps · resolution ×${info.pixelRatio}`),
      h('div', { class: 'menu' }, this.btn('Done', () => this.close('settings'), 'primary')),
    );
    this.show('settings', panel, { dismiss: () => this.close('settings') });
  }

  showSlots(mode, slots, onPick) {
    this.close('slots');
    const fmt = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const list = h('div', { class: 'slots' });
    slots.forEach((s, i) => {
      const thumb = s?.thumb ? h('img', { src: s.thumb, alt: '' }) : h('div', { class: 'thumb' });
      const b = h('button', { class: 'slot', disabled: mode === 'load' && !s },
        thumb,
        h('div', {},
          h('div', { class: 'label' }, `Slot ${i + 1}${s ? ' · ' + s.label : ' · empty'}`),
          h('div', { class: 'meta' }, s ? `${fmt(s.savedAt)} · you play ${s.humanColor === 0 ? 'White' : 'Black'}` : (mode === 'save' ? 'Save here' : '—')),
        ));
      b.addEventListener('click', () => { this.audio?.click(); onPick(i, s); });
      list.append(b);
    });
    const panel = h('div', { class: 'panel' },
      h('h2', {}, mode === 'save' ? 'Save checkpoint' : 'Load checkpoint'),
      h('p', { class: 'lead' }, mode === 'save' ? 'Pick a slot. You can rewind time back to it later.' : 'Time will rewind to the checkpoint.'),
      list,
      h('div', { class: 'menu', style: 'margin-top:12px' }, this.btn('Cancel', () => this.close('slots'))),
    );
    this.show('slots', panel, { dismiss: () => this.close('slots') });
  }

  confirm(text, okLabel = 'OK') {
    return new Promise((resolve) => {
      const done = (v) => { this.close('confirm'); resolve(v); };
      const panel = h('div', { class: 'panel' },
        h('p', { class: 'lead', style: 'font-size:16px;color:var(--text)' }, text),
        h('div', { class: 'row' }, this.btn('Cancel', () => done(false)), this.btn(okLabel, () => done(true), 'primary')),
      );
      this.show('confirm', panel, { dismiss: () => done(false) });
    });
  }

  pickPromotion(color) {
    return new Promise((resolve) => {
      const panel = h('div', { class: 'panel' },
        h('h2', {}, 'Promote to'),
        h('div', { class: 'promo' },
          ...[5, 4, 3, 2].map((t) => {
            const b = h('button', { 'aria-label': ['', '', 'Knight', 'Bishop', 'Rook', 'Queen'][t] }, GLYPH[color][t]);
            b.addEventListener('click', () => { this.close('promo'); resolve(t); });
            return b;
          }),
        ),
      );
      this.show('promo', panel, { dismiss: () => { this.close('promo'); resolve(null); } });
    });
  }

  showGameOver({ title, reason, glyph, ratingBefore, ratingAfter, aiNext, win }) {
    this.close('over');
    const delta = ratingAfter - ratingBefore;
    const panel = h('div', { class: 'panel', style: 'text-align:center' },
      h('div', { class: 'result-big' }, glyph),
      h('h2', {}, title),
      h('p', { class: 'lead' }, reason),
      ratingAfter ? h('p', { class: 'lead' }, `Your level: ${ratingBefore} → `, h('b', { style: `color:${delta >= 0 ? 'var(--ok)' : 'var(--danger)'}` }, `${ratingAfter}`),
        ` · next AI ≈ ${aiNext}`) : null,
      h('div', { class: 'menu' },
        this.btn(win ? 'Play again' : 'Rematch', () => this.emit('rematch'), 'primary'),
        h('div', { class: 'row' },
          this.btn('⏪ Load checkpoint', () => this.emit('load')),
          this.btn('👁 View board', () => this.close('over')),
        ),
        this.btn('♻ Switch sides', () => this.emit('switchSides')),
      ),
    );
    this.show('over', panel, { corner: true });
  }

  /** The game is over in a room: no rating, no checkpoints; the next game, with colours changed, for a player. */
  showRoomGameOver({ title, reason, glyph, win, onRematch }) {
    this.close('over');
    const panel = h('div', { class: 'panel', style: 'text-align:center' },
      h('div', { class: 'result-big' }, glyph),
      h('h2', {}, title),
      h('p', { class: 'lead' }, reason),
      h('div', { class: 'menu' },
        onRematch ? this.btn(win ? 'Play again' : 'Rematch', () => { this.close('over'); onRematch(); }, 'primary') : null,
        this.btn('👁 View board', () => this.close('over'), onRematch ? '' : 'primary'),
      ),
      onRematch ? h('p', { class: 'fineprint' }, 'The next game starts when one of you asks; you change colours.') : null,
    );
    this.show('over', panel, { corner: true });
  }

  /** The menu in a room, where Esc and ☰ lead. */
  showRoomMenu({ seated, canOffer, canAccept, canResign, canNew, canSit, onOffer, onAccept, onResign, onNew, onStand, onSit }) {
    this.close('pause');
    const act = (fn) => () => { this.close('pause'); fn(); };
    const panel = h('div', { class: 'panel' },
      h('h2', {}, 'Playing with friends'),
      h('p', { class: 'lead' }, seated ? 'The room keeps the game: close the page, and pick it up when you like.' : 'You are watching. The players are on the name plates.'),
      h('div', { class: 'menu' },
        this.btn('▶ Back to the board', () => this.emit('resume'), 'primary'),
        canSit ? this.btn('🪑 Take the free seat', act(onSit)) : null,
        canOffer ? this.btn('🤝 Offer a draw', act(onOffer)) : null,
        canAccept ? this.btn('🤝 Accept the draw', act(onAccept)) : null,
        canNew ? this.btn('♻ Next game', act(onNew)) : null,
        canResign ? this.btn('🏳 Resign', act(onResign), 'danger') : null,
        seated ? this.btn('🚪 Give up my seat', act(onStand)) : null,
        this.btn('⚙ Settings', () => this.emit('settings')),
      ),
      h('p', { class: 'fineprint' }, 'The 👥 button, bottom right, is the room: who is here, the invite, chat, and leaving.'),
      h('p', { class: 'fineprint' }, link(P3P2_URL, 'How rooms work: p3p2.me'), ' · ', link(MAIZE_URL, 'More games on Maize.Live')),
    );
    this.show('pause', panel, { corner: true, dismiss: () => this.emit('resume') });
  }

  // ---------- HUD ----------
  showHud(v) { this.hud.hidden = !v; }

  /** The names on the two plates: this page's side below, the other above. */
  setNames(you, them) {
    $('p-you').querySelector('.name').textContent = you;
    $('p-ai').querySelector('.name').textContent = them;
  }

  setSides(humanColor) {
    $('p-you').querySelector('.swatch').className = 'swatch ' + (humanColor === 0 ? 'w' : 'b');
    $('p-ai').querySelector('.swatch').className = 'swatch ' + (humanColor === 0 ? 'b' : 'w');
  }

  setTurn(humanTurn, { thinking = false, over = false, youText, aiText } = {}) {
    $('p-you').classList.toggle('active', humanTurn && !over);
    $('p-ai').classList.toggle('active', !humanTurn && !over);
    const ai = $('ai-status');
    ai.textContent = aiText ?? (thinking ? 'Thinking' : 'Adaptive');
    ai.classList.toggle('thinking', thinking);
    $('you-status').textContent = youText ?? (over ? 'Game over' : humanTurn ? 'Your move' : 'Waiting');
  }

  setCaptured(humanColor, game) {
    // Pieces each side has taken, shown as glyphs of the captured colour.
    const byYou = game.capturedBy(humanColor).sort((a, b) => b - a);
    const byAI = game.capturedBy(humanColor ^ 1).sort((a, b) => b - a);
    const mat = game.material() * (humanColor === 0 ? 1 : -1);
    $('caps-you').textContent = byYou.map((t) => GLYPH[humanColor ^ 1][t]).join('') + (mat > 0 ? ` +${mat}` : '');
    $('caps-ai').textContent = byAI.map((t) => GLYPH[humanColor][t]).join('') + (mat < 0 ? ` +${-mat}` : '');
  }

  setSaveEnabled(v) { $('btn-save').disabled = !v; $('btn-save').style.opacity = v ? 1 : 0.4; }

  /** In a room there are no checkpoints: their two buttons go. */
  setRoomMode(on) { $('hud-actions-top').hidden = on; }

  toast(text, ms = 2600) {
    const el = h('div', {}, text);
    this.toastEl.append(el);
    setTimeout(() => el.remove(), ms);
  }

  banner(text, ms = 1200, color) {
    const b = this.bannerEl;
    b.textContent = text;
    b.style.background = color || '';
    b.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.remove('show'), ms);
  }

  setRewinding(on) {
    $('rewind-fx').classList.toggle('on', on);
  }

  setSanInput(v) { $('san-input').hidden = !v; }
  focusSan() { const s = $('san-input'); if (!s.hidden) s.focus(); }
}

export { GLYPH };
