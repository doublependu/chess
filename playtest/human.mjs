// Playing like a person: the pointer travels to where it is going on a curved path at a human pace and lands a
// little past its mark, pieces get looked at before one is picked, now and then a piece is picked up and put back, a
// move takes longer to find when there is more to think about, and a phone is tapped (or dragged on) by a finger.
//
// Shared by the playtests (play-ui.mjs: the `fast` style, so a run does not take all day) and the film script
// (film.mjs: the `cinematic` style, on the film's clock). Time passes through `wait(ms)`: the page's own timeouts in a
// playtest, recorded frames in a film.
import { fenBoard } from './lib.mjs';

const STYLES = {
  // Pointer speed (px per ms at full stride), pauses, and how often a person hesitates.
  fast: { speed: 2.6, minMove: 60, settle: 40, press: 50, look: 0, changeMind: 0, overshoot: 0.04, thinkScale: 0.15 },
  cinematic: { speed: 1.25, minMove: 220, settle: 140, press: 80, look: 0.45, changeMind: 0.1, overshoot: 0.07, thinkScale: 1 },
};

export class Human {
  /**
   * @param page a Playwright page
   * @param o.wait (ms) => Promise: lets time pass (and, in a film, records it)
   * @param o.touch a finger instead of a mouse (CDP touch events, so a drag is a real one)
   * @param o.rng () => [0, 1)
   * @param o.style 'fast' | 'cinematic'
   */
  constructor(page, { wait, touch = false, rng = Math.random, style = 'cinematic' } = {}) {
    this.page = page;
    this.wait = wait || ((ms) => page.waitForTimeout(ms));
    this.touch = touch;
    this.rng = rng;
    this.s = STYLES[style] || STYLES.cinematic;
    this.at = null;
    this.cdp = null;
  }

  async touchEvent(type, x, y) {
    this.cdp ||= await this.page.context().newCDPSession(this.page);
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1 }] });
  }

  /** Where a square is on screen (on the piece's body when one stands there). */
  square(sq, y = null) { return this.page.evaluate(([s, h]) => window.__test.squareToScreen(s, h), [sq, y]); }

  /**
   * The pointer to (x, y): a minimum-jerk stride along a slight arc, past the mark and back, in steps of one frame.
   * A finger does not travel: it lifts and comes down where it is going.
   */
  async moveTo(x, y, { down = false } = {}) {
    if (this.touch && !down) { this.at = { x, y }; return; }
    const from = this.at || { x: x + 180 * (this.rng() - 0.5), y: y + 140 };
    const dx = x - from.x, dy = y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) { this.at = { x, y }; return; }
    // Fitts-ish: longer strides are faster, but not proportionally longer.
    const ms = Math.max(this.s.minMove, 120 + Math.sqrt(dist) * 22 / this.s.speed);
    const n = Math.max(2, Math.round(ms / 16));
    const bend = (this.rng() - 0.5) * 0.35 * dist;
    const nx = -dy / dist, ny = dx / dist;
    const over = 1 + this.s.overshoot * (0.5 + this.rng());
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      // Minimum jerk (10u³ − 15u⁴ + 6u⁵), aimed a little long, then a short correction in the last fifth.
      const mj = u * u * u * (10 - 15 * u + 6 * u * u);
      const k = u < 0.8 ? mj * over : over + (1 - over) * ((u - 0.8) / 0.2);
      const arc = Math.sin(Math.PI * Math.min(1, u * 1.1)) * bend;
      const px = from.x + dx * k + nx * arc, py = from.y + dy * k + ny * arc;
      if (this.touch) await this.touchEvent('touchMove', px, py);
      else await this.page.mouse.move(px, py);
      await this.wait(16);
    }
    this.at = { x, y };
  }

  async press() {
    const { x, y } = this.at;
    if (this.touch) {
      await this.touchEvent('touchStart', x, y);
      await this.wait(this.s.press);
      await this.touchEvent('touchEnd', x, y);
    } else {
      await this.page.mouse.down();
      await this.wait(this.s.press);
      await this.page.mouse.up();
    }
  }

  /** Clicks (or taps) a point. */
  async clickAt(x, y) {
    await this.moveTo(x, y);
    await this.wait(this.s.settle);
    await this.press();
  }

  /** Clicks (or taps) the middle of an element, scrolled into view first (a tall panel scrolls). */
  async click(locator) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const b = await locator.boundingBox();
    if (!b) throw new Error('nothing to click');
    await this.clickAt(b.x + b.width * (0.45 + this.rng() * 0.1), b.y + b.height * (0.4 + this.rng() * 0.2));
  }

  /** How long a person would look at a position before moving: longer with more choice, a capture to weigh, or check. */
  thinkMs(state) {
    const legal = state.legal ?? 30;
    let base = 900 + legal * 35;
    if (state.capture) base *= 1.4;
    if (state.check) base *= 1.3;
    const g = Math.sqrt(-2 * Math.log(1 - this.rng())) * Math.cos(2 * Math.PI * this.rng());
    return Math.min(8000, Math.max(400, base * Math.exp(0.45 * g))) * this.s.thinkScale;
  }

  /**
   * Plays one move through the board, as a person: maybe a look at another piece first, maybe a piece picked up
   * and put back; then the piece, and its square (by two clicks, or a drag); and the promotion picker if it opens.
   */
  async play(uci, { drag = false } = {}) {
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    const s = await this.page.evaluate(() => window.__test.state());
    const mine = Object.entries(fenBoard(s.fen))
      .filter(([sq, p]) => (s.humanColor === 0 ? p === p.toUpperCase() : p === p.toLowerCase()) && sq !== from)
      .map(([sq]) => sq);
    if (mine.length && this.rng() < this.s.look) {
      const other = mine[Math.floor(this.rng() * mine.length)];
      const p = await this.square(other);
      await this.moveTo(p.x, p.y);
      await this.wait(200 + this.rng() * 300);
      if (this.rng() < this.s.changeMind) {
        // Picked up, and put back down: tapping it again lets it go.
        await this.press();
        await this.wait(450 + this.rng() * 350);
        await this.press();
        await this.wait(200);
      }
    }
    const a = await this.square(from);
    const b = await this.square(to, 0.02);
    if (drag && !this.touch) {
      await this.moveTo(a.x, a.y);
      await this.wait(this.s.settle);
      await this.page.mouse.down();
      await this.wait(this.s.press);
      await this.moveTo(b.x, b.y);
      await this.wait(this.s.settle / 2);
      await this.page.mouse.up();
    } else if (drag) {
      await this.moveTo(a.x, a.y);
      await this.touchEvent('touchStart', a.x, a.y);
      await this.wait(this.s.press);
      await this.moveTo(b.x, b.y, { down: true });
      await this.touchEvent('touchEnd', b.x, b.y);
    } else {
      await this.clickAt(a.x, a.y);
      await this.wait(120 + this.rng() * 180);
      await this.clickAt(b.x, b.y);
    }
    if (uci.length > 4) {
      const pick = this.page.locator('.promo button').nth(Math.max(0, 'qrbn'.indexOf(uci[4])));
      for (let i = 0; i < 40 && !(await pick.isVisible().catch(() => false)); i++) await this.wait(50);
      await this.wait(300);
      await this.click(pick);
    }
  }
}
