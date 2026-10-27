// Recording the game frame by frame, on a clock of the film's own.
//
// Playwright's page.clock fakes the page's timers, requestAnimationFrame and performance.now; the overlay
// (overlay.js) sets CSS animations to the same time. Each frame the script moves that clock on by one animation
// frame (16 ms: Playwright fires requestAnimationFrame on a 16 ms grid), takes a screenshot over CDP and pipes it
// into ffmpeg as one 1/60 s frame. The film therefore runs 4 % slower than the game would (16 ms to 16.7 ms), evenly,
// with every frame drawn; and it is smooth however long a frame takes to draw. While the board holds a strike for the
// destruction worker's shards (`__filmApp.waiting()`), real time passes and the film's does not.
//
// Live: for what cannot run on a fake clock (a room, whose server keeps real time), frames come from CDP's screencast
// as the browser draws them, and are laid on a 60 fps grid by their timestamps.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STEP = 16;
export const FPS = 60;
/** Film time to video time: one 16 ms step is one 1/60 s frame. */
export const STRETCH = 1000 / FPS / STEP;
const OVERLAY = readFileSync(fileURLToPath(new URL('./overlay.js', import.meta.url)), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Prepares a page for filming: the fake clock (running, for now) and the overlay. Before the page is opened. */
export async function prepare(page) {
  await page.clock.install();
  await page.addInitScript({ content: OVERLAY });
}

/** An ffmpeg that takes JPEG frames on stdin and writes a high-quality intermediate file. */
function encoder(file, { fps = FPS, crf = 12 } = {}) {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
    // Even sizes for 4:2:0 (a 360×608 page at 16/9 is 640×1081).
    '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps), file], { stdio: ['pipe', 'inherit', 'inherit'] });
  let dead = null;
  const exited = once(ff, 'exit').then(([code]) => { dead = code; return code; });
  ff.stdin.on('error', () => {});
  return {
    // A frame for an ffmpeg that is gone (it could not open the encoder, say) is an error, not a wait for ever.
    async write(buf) {
      if (dead !== null) throw new Error(`ffmpeg exited with ${dead} while writing ${file}`);
      if (!ff.stdin.write(buf)) await Promise.race([once(ff.stdin, 'drain'), exited]);
    },
    async close() { ff.stdin.end(); const code = await exited; if (code) throw new Error(`ffmpeg exited with ${code} for ${file}`); },
  };
}

export class Recorder {
  constructor(page, { quality = 92 } = {}) {
    this.page = page;
    this.quality = quality;
    this.cdp = null;
    this.enc = null;
    this.frames = 0;
    this.marks = [];
  }

  async attach() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    await this.page.evaluate(() => window.__test.film());
    // CDP captures in CSS pixels unless asked for the device's: a 1280×720 page at 1.5× is a 1920×1080 frame.
    const { width, height } = this.page.viewportSize();
    const scale = await this.page.evaluate(() => devicePixelRatio);
    this.clip = { x: 0, y: 0, width, height, scale };
    return this;
  }

  /** The page's clock now (ms, performance.now()). */
  now() { return this.page.evaluate(() => performance.now()); }

  /** Stops the page's clock: from here on it moves only by step(). */
  async freeze() {
    const wall = await this.page.evaluate(() => Date.now());
    await this.page.clock.pauseAt(wall + 20);
    this.frozen = true;
    this.t = await this.now();
  }

  /** Lets the page's clock run with real time again (loading, a live segment). */
  async thaw() { await this.page.clock.resume(); this.frozen = false; }

  /** Starts writing frames to `file`. */
  async begin(file) {
    this.file = file;
    this.enc = encoder(file);
    this.frames = 0;
    this.marks = [];
    this.captions = [];
    /** Which stretches of the film's clock are in the video, and where: { from, to, video } (ms, ms, s). A cut starts a new one. */
    this.spans = [];
  }

  /** Waits (in real time) while the board holds for the destruction worker. */
  async settleWorkers(limitMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < limitMs && await this.page.evaluate(() => window.__filmApp?.waiting())) await sleep(15);
  }

  /** Moves the film's clock on by one step, and has CSS animations follow it. */
  async step() {
    await this.settleWorkers();
    await this.page.clock.runFor(STEP);
    this.t += STEP;
    await this.page.evaluate(() => window.__film.seek());
  }

  /** One frame: a step, then a screenshot into the file. */
  async frame() {
    const before = this.t;
    await this.step();
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.quality, optimizeForSpeed: true, clip: this.clip });
    await this.enc.write(Buffer.from(data, 'base64'));
    const span = this.spans[this.spans.length - 1];
    if (span && span.to === before) span.to = this.t;
    else this.spans.push({ from: before, to: this.t, video: this.frames / FPS });
    this.frames++;
  }

  /** Frames for `ms` of video. */
  async hold(ms) {
    const n = Math.round(ms / (1000 / FPS));
    for (let i = 0; i < n; i++) await this.frame();
  }

  /** Frames until `fn` (evaluated in the page) is true, or `maxMs` of video passed. Returns whether it came true. */
  async until(fn, maxMs = 20000, arg) {
    const n = Math.round(maxMs / (1000 / FPS));
    for (let i = 0; i < n; i++) {
      if (await this.page.evaluate(fn, arg)) return true;
      await this.frame();
    }
    return false;
  }

  /** Moves the film's clock on by `ms` without recording: a cut. */
  async skip(ms) {
    const n = Math.round(ms / STEP);
    for (let i = 0; i < n; i++) await this.step();
  }

  /** Skips until `fn` is true (a cut over a wait), at most `maxMs`. */
  async skipUntil(fn, maxMs = 30000, arg) {
    const n = Math.round(maxMs / STEP);
    for (let i = 0; i < n; i++) {
      if (await this.page.evaluate(fn, arg)) return true;
      await this.step();
    }
    return false;
  }

  /** The frame as it is now, as a PNG (a thumbnail). */
  async still(file) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png', clip: this.clip });
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  /** A named point in this segment, for chapters: seconds of video from its start. */
  mark(name) { this.marks.push({ name, at: this.frames / FPS }); }

  /** A caption on screen (overlay.js), noted for the subtitles file. */
  async say(text, o = {}) {
    const ms = o.ms ?? 3000;
    await this.page.evaluate(([t, opts]) => window.__film.caption(t, opts), [text, { ...o, ms }]);
    this.captions.push({ at: this.frames / FPS, seconds: ms / 1000, text: o.sub ? `${text}\n${o.sub}` : text });
  }

  /** A full-screen card (overlay.js), noted for the subtitles file. */
  async card(o) {
    await this.page.evaluate((opts) => { window.__film.card(opts); }, o);
    const text = [o.title?.replace(/<[^>]+>/g, ' '), ...(o.lines || []).map((l) => (typeof l === 'string' ? l : l.text)), o.url].filter(Boolean).join(' · ');
    if (text) this.captions.push({ at: this.frames / FPS, seconds: (o.ms ?? 3000) / 1000, text });
  }

  /** Finishes the file. Returns what was recorded, with the spans of the film's clock it shows, for its sound. */
  async end() {
    await this.enc.close();
    this.enc = null;
    return { file: this.file, frames: this.frames, seconds: this.frames / FPS, spans: this.spans, marks: this.marks, captions: this.captions };
  }

  /** The sounds of what was recorded, as a WAV file timed to its frames (a sound that began in a cut is left out). */
  async sound(seg, file) {
    const b64 = await this.page.evaluate((o) => window.__filmApp.renderAudio(o), { spans: seg.spans, seconds: seg.seconds, scale: STRETCH });
    writeFileSync(file, Buffer.from(b64, 'base64'));
    return file;
  }
}

/**
 * Real-time recording of a page through CDP's screencast, for a room (its server's heartbeats run in real time).
 * Frames arrive as the browser draws them; each is held until the next, on a 60 fps grid.
 */
export class LiveRecorder {
  constructor(page, { quality = 90, width, height } = {}) {
    this.page = page;
    this.opts = { format: 'jpeg', quality, everyNthFrame: 1, ...(width ? { maxWidth: width, maxHeight: height } : {}) };
  }

  async begin(file) {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.enc = encoder(file);
    this.file = file;
    this.frames = 0;
    this.t0 = null;
    this.last = null;
    this.queue = Promise.resolve();
    this.cdp.on('Page.screencastFrame', (f) => {
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      const buf = Buffer.from(f.data, 'base64');
      const t = f.metadata.timestamp;
      this.queue = this.queue.then(() => this.push(buf, t));
    });
    await this.cdp.send('Page.startScreencast', this.opts);
    this.started = Date.now();
  }

  /** Fills the grid up to time `t` with the previous frame, then takes this one. */
  async push(buf, t) {
    if (this.t0 === null) this.t0 = t;
    const slot = Math.round((t - this.t0) * FPS);
    while (this.last && this.frames < slot) { await this.enc.write(this.last); this.frames++; }
    this.last = buf;
  }

  /** Real-time wait while recording. */
  async hold(ms) { await sleep(ms); }

  async end() {
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await this.queue;
    // The last frame, up to the time the recording stopped.
    const slot = Math.round(((Date.now() - this.started) / 1000) * FPS);
    while (this.last && this.frames < slot) { await this.enc.write(this.last); this.frames++; }
    await this.enc.close();
    return { file: this.file, frames: this.frames, seconds: this.frames / FPS };
  }
}
