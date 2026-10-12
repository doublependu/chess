// Time-to-interactive under throttled network + CPU (cold cache), measured from navigation start
// to the app's `tti` performance mark (first rendered frame with input attached).
// Usage: npm run perf:load [-- --runs 3 --url http://localhost:4173/]
import { parseArgs, startServer, launch, outDir } from '../playtest/lib.mjs';
import { writeFileSync } from 'node:fs';

const args = parseArgs({ runs: 3, url: null, build: true });
const PROFILES = [
  { name: 'desktop broadband', down: 50e6, up: 10e6, latency: 20, cpu: 1, warn: 1500, fail: 2500 },
  { name: 'mid mobile (10 Mbps, 80 ms, 4x CPU)', down: 10e6, up: 3e6, latency: 80, cpu: 4, warn: 2000, fail: 3000 },
  { name: 'slow mobile (5 Mbps, 150 ms, 6x CPU)', down: 5e6, up: 1e6, latency: 150, cpu: 6, warn: 3000, fail: 4000 },
];

const server = await startServer({ url: args.url, build: args.build !== false && !args['no-build'] });
const browser = await launch();
const results = [];
let failed = false;
try {
  for (const p of PROFILES) {
    const runs = [];
    for (let i = 0; i < args.runs; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: p.latency, downloadThroughput: p.down / 8, uploadThroughput: p.up / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
      await page.goto(server.url, { waitUntil: 'commit' });
      await page.waitForFunction(() => performance.getEntriesByName('tti').length > 0, null, { timeout: 30000, polling: 50 });
      const t = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return { tti: performance.getEntriesByName('tti')[0].startTime, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, dcl: nav?.domContentLoadedEventEnd };
      });
      runs.push(t);
      await ctx.close();
    }
    runs.sort((a, b) => a.tti - b.tti);
    const med = runs[Math.floor(runs.length / 2)];
    const status = med.tti > p.fail ? 'FAIL' : med.tti > p.warn ? 'warn' : 'ok';
    if (status === 'FAIL') failed = true;
    results.push({ profile: p.name, ttiMs: Math.round(med.tti), fcpMs: Math.round(med.fcp || 0), status, runs });
    console.log(`${status.padEnd(4)} ${p.name.padEnd(40)} TTI ${Math.round(med.tti)} ms (first paint ${Math.round(med.fcp || 0)} ms) [warn > ${p.warn}, fail > ${p.fail}]`);
  }
} finally {
  await browser.close();
  server.stop();
}
const dir = outDir('perf-load');
writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2));
console.log(failed ? '✗ load budget exceeded' : '✓ load budget met');
process.exitCode = failed ? 1 : 0;
