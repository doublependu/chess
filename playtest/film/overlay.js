// Injected into the page by the film script (page.addInitScript), before the game's own code: what a recording
// shows on top of the game, and the one thing the film's clock cannot reach by itself.
//
// - seek(): CSS animations and transitions run on the browser's own clock, not the page's (which the film fakes). Each
//   frame, every one of them (also in open shadow roots: p3p2's button) is paused and set to the film's time.
// - A cursor that follows the mouse (screenshots have none), with a ripple on each press; on touch, a fingertip.
// - Captions, title cards, an end card, a time-lapse badge and fades, styled like the game.
// It is plain browser JavaScript with no imports: addInitScript takes it as a string.
(() => {
  if (window.__film) return;
  const now = () => performance.now();
  const started = new WeakMap();
  const done = new WeakSet();
  const css = `
  #film-layer { position: fixed; inset: 0; z-index: 2147483600; pointer-events: none; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif; color: #f6eedd; }
  #film-layer * { box-sizing: border-box; }
  .film-cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; margin: -2px 0 0 -3px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
  .film-finger { position: absolute; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; background: rgba(255,255,255,.35); border: 2px solid rgba(255,255,255,.85); box-shadow: 0 0 18px rgba(255,255,255,.35); }
  .film-ripple { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; border: 3px solid #f2c46d; }
  .film-caption { position: absolute; left: 50%; transform: translateX(-50%); max-width: min(88%, 900px); text-align: center;
    padding: .5em 1em; border-radius: .7em; background: rgba(22, 18, 38, .82); border: 1px solid rgba(255, 236, 200, .22);
    font-weight: 700; line-height: 1.25; text-shadow: 0 2px 6px rgba(0,0,0,.4); box-shadow: 0 10px 40px rgba(0,0,0,.35); }
  .film-caption small { display: block; font-weight: 500; color: #c9bda6; font-size: .62em; margin-top: .25em; }
  .film-card { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 6%;
    background: radial-gradient(120% 90% at 50% 100%, rgba(243,183,124,.92) 0%, rgba(180,99,122,.92) 40%, rgba(58,45,102,.94) 75%, rgba(27,21,48,.97) 100%); }
  .film-card h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 700; margin: 0 0 .25em; line-height: 1.02;
    text-shadow: 0 3px 0 rgba(0,0,0,.25), 0 12px 30px rgba(0,0,0,.35); }
  .film-card p { margin: .35em 0; color: #f6eedd; font-weight: 600; }
  .film-card p.dim { color: #e8dcc6; font-weight: 500; }
  .film-card .url { display: inline-block; margin-top: .6em; padding: .35em .9em; border-radius: .6em; background: linear-gradient(180deg, #f2c46d, #e09a3a); color: #2a1a05; font-weight: 800; }
  .film-badge { position: absolute; top: 4%; right: 4%; padding: .3em .7em; border-radius: .6em; background: rgba(0,0,0,.55); font-weight: 800; letter-spacing: .05em; }
  .film-fade { position: absolute; inset: 0; background: #000; opacity: 0; }
  .film-title { position: absolute; left: 0; right: 0; text-align: center; padding: 0 6%; }
  .film-title h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 700; margin: 0; line-height: 1.02; letter-spacing: .01em;
    text-shadow: 0 3px 0 rgba(0,0,0,.3), 0 10px 34px rgba(0,0,0,.55); }
  .film-title p { margin: .4em 0 0; font-weight: 700; text-shadow: 0 2px 10px rgba(0,0,0,.7); }
  .film-split { position: absolute; top: 3%; padding: .25em .7em; border-radius: .5em; background: rgba(0,0,0,.55); font-weight: 800; }
  `;
  let layer, cursor, finger, fade, badge;
  const ready = () => {
    if (layer) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    layer = document.createElement('div');
    layer.id = 'film-layer';
    cursor = document.createElement('div');
    cursor.className = 'film-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2l7.5 19 2.6-7.4L20.5 11z" fill="#fff" stroke="#1b1530" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    cursor.style.display = 'none';
    finger = document.createElement('div');
    finger.className = 'film-finger';
    finger.style.display = 'none';
    fade = document.createElement('div');
    fade.className = 'film-fade';
    layer.append(cursor, finger, fade);
    document.body.append(layer);
  };
  if (document.body) ready(); else addEventListener('DOMContentLoaded', ready);

  /** Element.animate, whose time the film sets with everything else. */
  const anim = (el, frames, ms, opts = {}) => el.animate(frames, { duration: ms, fill: 'both', easing: 'ease', ...opts });

  const ripple = (x, y) => {
    const r = document.createElement('div');
    r.className = 'film-ripple';
    r.style.left = x + 'px'; r.style.top = y + 'px';
    layer.append(r);
    anim(r, [{ transform: 'scale(.6)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }], 520).finished.then(() => r.remove(), () => r.remove());
  };

  addEventListener('pointermove', (e) => {
    if (!layer) return;
    if (e.pointerType === 'touch') { finger.style.left = e.clientX + 'px'; finger.style.top = e.clientY + 'px'; return; }
    cursor.style.display = film.cursor ? '' : 'none';
    cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  }, true);
  addEventListener('pointerdown', (e) => {
    if (!layer || !film.cursor) return;
    if (e.pointerType === 'touch') {
      finger.style.display = '';
      finger.style.left = e.clientX + 'px'; finger.style.top = e.clientY + 'px';
    } else cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px) scale(.88)`;
    ripple(e.clientX, e.clientY);
  }, true);
  addEventListener('pointerup', (e) => {
    if (!layer) return;
    if (e.pointerType === 'touch') {
      const f = finger;
      anim(f, [{ opacity: 1 }, { opacity: 0 }], 260).finished.then(() => { f.style.display = 'none'; f.getAnimations().forEach((a) => a.cancel()); }, () => {});
    } else cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  }, true);

  const place = (el, pos) => {
    const s = film.safe;
    if (pos === 'top') el.style.top = `${s.top}%`;
    else if (pos === 'center') { el.style.top = '50%'; el.style.transform = 'translate(-50%, -50%)'; }
    else el.style.bottom = `${s.bottom}%`;
    el.style.left = `${50 + (s.left - s.right) / 2}%`;
    el.style.maxWidth = `${Math.min(88, 100 - s.left - s.right - 4)}%`;
  };

  const film = {
    cursor: true,
    /** Margins (% of the screen) captions keep clear of: a Short's buttons sit on the right and at the bottom. */
    safe: { top: 6, bottom: 7, left: 4, right: 4 },
    /** Font size of captions, in px (scales with the recording's size). */
    size: 30,
    config(o) { Object.assign(this, o); },

    /** CSS animations to the film's time. Called by the script after each step of the clock. */
    seek() {
      const t = now();
      const all = document.getAnimations();
      for (const el of document.querySelectorAll('p3p2-panel')) if (el.shadowRoot) all.push(...el.shadowRoot.getAnimations());
      for (const a of all) {
        if (done.has(a)) continue;
        if (!started.has(a)) {
          started.set(a, t - (a.currentTime || 0));
          a.pause();
        }
        // A paused animation never finishes by itself: past its end, it is finished, and its promise resolves.
        const at = t - started.get(a);
        const end = a.effect?.getComputedTiming?.().endTime;
        if (Number.isFinite(end) && at >= end) { done.add(a); a.finish(); } else a.currentTime = at;
      }
    },

    caption(text, { ms = 3000, pos = 'bottom', sub = '', size = this.size } = {}) {
      ready();
      const el = document.createElement('div');
      el.className = 'film-caption';
      el.style.fontSize = size + 'px';
      el.textContent = text;
      if (sub) { const s = document.createElement('small'); s.textContent = sub; el.append(s); }
      place(el, pos);
      layer.insertBefore(el, fade);
      const base = pos === 'center' ? 'translate(-50%, -50%)' : 'translateX(-50%)';
      const a = anim(el, [
        { opacity: 0, transform: `${base} translateY(12px)` }, { opacity: 1, transform: `${base} translateY(0)`, offset: Math.min(0.5, 280 / ms) },
        { opacity: 1, transform: `${base} translateY(0)`, offset: Math.max(0.5, 1 - 280 / ms) }, { opacity: 0, transform: `${base} translateY(-6px)` },
      ], ms, { easing: 'linear' });
      a.finished.then(() => el.remove(), () => el.remove());
    },

    /** A full-screen card: { title, lines, url, ms }. Stays `ms`, fading in and out. */
    card({ title = '', lines = [], url = '', ms = 3000, size = this.size * 2.2, fadeIn = 400, fadeOut = 400 } = {}) {
      ready();
      const el = document.createElement('div');
      el.className = 'film-card';
      const box = document.createElement('div');
      if (title) { const h = document.createElement('h1'); h.innerHTML = title; h.style.fontSize = size + 'px'; box.append(h); }
      for (const l of lines) {
        const p = document.createElement('p');
        p.textContent = typeof l === 'string' ? l : l.text;
        if (l.dim) p.className = 'dim';
        p.style.fontSize = (this.size * (l.scale || 0.95)) + 'px';
        box.append(p);
      }
      if (url) { const u = document.createElement('div'); u.className = 'url'; u.textContent = url; u.style.fontSize = (this.size * 1.05) + 'px'; box.append(u); }
      el.append(box);
      layer.insertBefore(el, fade);
      const a = anim(el, [{ opacity: 0 }, { opacity: 1, offset: fadeIn / ms }, { opacity: 1, offset: 1 - fadeOut / ms }, { opacity: fadeOut ? 0 : 1 }], ms, { easing: 'linear' });
      a.finished.then(() => { if (fadeOut) el.remove(); }, () => el.remove());
      return el;
    },

    /** A big title straight over the scene (no card): { text (HTML), sub, ms, pos: 'center' | 'top' | 'bottom', size }. */
    title({ text, sub = '', ms = 3000, pos = 'center', size = this.size * 2.6, fadeIn = 500, fadeOut = 500 } = {}) {
      ready();
      const el = document.createElement('div');
      el.className = 'film-title';
      const h = document.createElement('h1');
      h.innerHTML = text;
      h.style.fontSize = size + 'px';
      el.append(h);
      if (sub) { const p = document.createElement('p'); p.textContent = sub; p.style.fontSize = (this.size * 1.0) + 'px'; el.append(p); }
      if (pos === 'top') el.style.top = `${this.safe.top + 2}%`;
      else if (pos === 'bottom') el.style.bottom = `${this.safe.bottom + 2}%`;
      else { el.style.top = '50%'; el.style.transform = 'translateY(-50%)'; }
      layer.insertBefore(el, fade);
      const a = anim(h.parentElement, [
        { opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0)', offset: fadeIn / ms },
        { opacity: 1, filter: 'blur(0)', offset: 1 - fadeOut / ms }, { opacity: fadeOut ? 0 : 1, filter: 'blur(0)' },
      ], ms, { easing: 'linear' });
      a.finished.then(() => { if (fadeOut) el.remove(); }, () => el.remove());
    },

    /** Removes cards left on screen (an end card with no fade out). */
    clearCards() { layer?.querySelectorAll('.film-card, .film-caption, .film-title').forEach((e) => e.remove()); },

    /** A corner badge ("4×" during a time-lapse), or null to remove it. */
    badge(text) {
      ready();
      if (badge) { badge.remove(); badge = null; }
      if (!text) return;
      badge = document.createElement('div');
      badge.className = 'film-badge';
      badge.style.fontSize = (this.size * 0.8) + 'px';
      badge.textContent = text;
      layer.insertBefore(badge, fade);
    },

    /** Fades the screen to black (to = 1) or back (to = 0). */
    fade(to, ms = 400) {
      ready();
      const from = +getComputedStyle(fade).opacity;
      fade.getAnimations().forEach((a) => a.cancel());
      fade.style.opacity = String(to);
      if (ms > 0) anim(fade, [{ opacity: from }, { opacity: to }], ms, { fill: 'none', easing: 'linear' });
    },

    hideCursor() { if (cursor) cursor.style.display = 'none'; if (finger) finger.style.display = 'none'; },
  };
  window.__film = film;
})();
