// Frame-time and GPU-time per quality tier while playing captures.
// Headless Chromium renders with SwiftShader (CPU), so run with --headed on a machine with a real
// GPU for meaningful numbers; headless runs are only a smoke test.
// Usage: npm run perf:fps -- --headed
import { parseArgs, startServer, launch, outDir, openGame, idle, state, playMove, fenBoard } from '../playtest/lib.mjs';
import { writeFileSync } from 'node:fs';

const args = parseArgs({ url: null, build: true, headed: false, moves: 6 });
const server = await startServer({ url: args.url, build: args.build !== false && !args['no-build'] });
const browser = await launch({ headed: args.headed });
const out = [];
try {
  for (const tier of ['low', 'medium', 'high']) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await openGame(page, server.url + `?quality=${tier}`, { settings: { graphics: tier, animSpeed: 1, sound: false, difficulty: 2 } });
    await page.getByRole('button', { name: /Play White/ }).click();
    const samples = [];
    // Measure rAF intervals continuously while playing capture-heavy moves.
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const f = (n) => { window.__frames.push(n - last); last = n; requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
    for (let i = 0; i < args.moves; i++) {
      const s = await idle(page);
      if (s.over) break;
      const legal = await page.evaluate(() => window.__test.legal());
      const b = fenBoard(s.fen);
      const caps = legal.filter((u) => b[u.slice(2, 4)] && b[u.slice(2, 4)] === b[u.slice(2, 4)].toLowerCase());
      await playMove(page, caps[0] || legal[(i * 3) % legal.length]);
      await page.waitForTimeout(500);
      samples.push(await page.evaluate(() => window.__test.frameStats()));
    }
    await idle(page);
    const frames = await page.evaluate(() => window.__frames.slice(30));
    const gpu = await page.evaluate(() => window.__test.gpuTime(12));
    const info = await page.evaluate(() => window.__test.info());
    const ri = await page.evaluate(() => window.__test.renderInfo());
    frames.sort((a, b) => a - b);
    const pct = (q) => +frames[Math.floor(frames.length * q)].toFixed(1);
    const r = { tier, gpu: info.gpu, p50: pct(0.5), p95: pct(0.95), gpuMs: gpu && +gpu.toFixed(2), drawCalls: ri.calls, triangles: ri.triangles, pixelRatio: info.pixelRatio };
    out.push(r);
    console.log(`${tier.padEnd(7)} frame p50 ${r.p50} ms p95 ${r.p95} ms · GPU ${r.gpuMs ?? 'n/a'} ms · ${r.drawCalls} calls · ${r.triangles} tris · ${info.gpu}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.stop();
}
const dir = outDir('perf-fps');
writeFileSync(`${dir}/results.json`, JSON.stringify(out, null, 2));
