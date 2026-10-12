// Fails if the critical-path bundle (what's needed before the first interactive frame) is over budget.
// Usage: npm run perf:size [-- --budget 250]
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const bi = process.argv.indexOf('--budget');
const budgetKB = bi > 0 ? +process.argv[bi + 1] : 250;
if (!process.argv.includes('--no-build')) execSync('npx vite build', { stdio: 'ignore' });

const html = readFileSync('dist/index.html', 'utf8');
const critical = new Set(['index.html']);
for (const m of html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)) critical.add(m[1]);

const size = (f) => {
  const buf = readFileSync('dist/' + f);
  return { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length, br: brotliCompressSync(buf).length };
};
const kb = (n) => (n / 1024).toFixed(1).padStart(8) + ' KB';
let total = { raw: 0, gz: 0, br: 0 };
console.log('Critical path (loaded before first interaction):');
for (const f of critical) {
  const s = size(f);
  total = { raw: total.raw + s.raw, gz: total.gz + s.gz, br: total.br + s.br };
  console.log(`  ${f.padEnd(44)} ${kb(s.raw)} raw ${kb(s.gz)} gzip ${kb(s.br)} brotli`);
}
console.log(`  ${'TOTAL'.padEnd(44)} ${kb(total.raw)} raw ${kb(total.gz)} gzip ${kb(total.br)} brotli`);
console.log('\nDeferred (workers, physics, wasm):');
for (const f of readdirSync('dist/assets')) {
  const path = 'assets/' + f;
  if (critical.has(path)) continue;
  const raw = statSync('dist/' + path).size;
  const s = size(path);
  console.log(`  ${path.padEnd(44)} ${kb(raw)} raw ${kb(s.gz)} gzip`);
}
const ok = total.gz / 1024 <= budgetKB;
console.log(`\n${ok ? '✓' : '✗'} critical gzip ${(total.gz / 1024).toFixed(1)} KB (budget ${budgetKB} KB)`);
process.exitCode = ok ? 0 : 1;
