// Showcase videos of the game, recorded from the real production build as a person plays it, frame by frame
// (playtest/film/clock.mjs), and cut for YouTube (16:9, about 4½ min), a YouTube Short (9:16, under a minute) and X
// (1:1, under a minute, captioned to work muted). Everything goes to playtest-output/film-* (gitignored).
//
// Usage:
//   npm run film                                    # all three cuts
//   node playtest/film.mjs --cut short              # one cut
//   node playtest/film.mjs --cut youtube --reels opera,rewind   # some reels only, to try them
//   node playtest/film.mjs --url-label chess.example.com --music track.mp3
//   node playtest/film.mjs --no-build --url http://localhost:5173/
//
// The friends reel needs a p3p2 checkout next to this one (../p3p2, or --p3p2 <dir>), as `npm run playtest:room` does.
// Rendering uses the GPU in a headless browser; --headed shows the windows instead.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { parseArgs, outDir, startServer } from './lib.mjs';
import { PRESETS } from './film/kit.mjs';
import { REELS } from './film/reels.mjs';
import { build, thumbnails } from './film/encode.mjs';
import { stopAll } from './rooms.mjs';

const args = parseArgs({ cut: 'all', reels: null, 'url-label': '', music: null, p3p2: '../p3p2', build: true, url: null, headed: false, port: 4182 });

/** Which reels each cut is made of, in order, with their options. */
export const CUTS = {
  youtube: [['coldopen'], ['intro'], ['opera', { all: true }], ['closeup'], ['rewind'], ['promotion'], ['vsai', { plies: 12 }], ['friends'], ['devices'], ['settings'], ['outro']],
  short: [['coldopen'], ['opera', { from: 22 }], ['rewind', { brief: true }], ['outro']],
  x: [['coldopen'], ['rewind', { brief: true }], ['friends'], ['outro']],
};

const DIR = outDir('film');
const cuts = args.cut === 'all' ? Object.keys(CUTS) : String(args.cut).split(',');
const only = args.reels ? String(args.reels).split(',') : null;
const report = { started: new Date().toISOString(), args, cuts: [], errors: [] };
const log = (s) => console.log(s);

const server = await startServer({ url: args.url, build: args.build !== false && !args['no-build'], port: args.port });
const browser = await chromium.launch({
  headless: !args.headed,
  // The real GPU, also headless (without these, headless Chromium draws with SwiftShader, several times slower).
  args: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const cut of cuts) {
    if (!CUTS[cut]) { console.warn('unknown cut', cut); continue; }
    const dir = `${DIR}/${cut}`;
    mkdirSync(dir, { recursive: true });
    const env = { browser, url: server.url, preset: PRESETS[cut], dir, args, errors: report.errors, log };
    const t0 = Date.now();
    log(`[${cut}] recording`);
    const clips = [];
    for (const [name, opts] of CUTS[cut]) {
      if (only && !only.includes(name)) continue;
      // A reel that fails (a room's server too slow to answer, say) is tried once more, then left out and reported.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { clips.push(...await REELS[name](env, opts)); break; } catch (e) {
          const text = String(e?.stack || e).slice(0, 600);
          log(`  ${name}: failed (try ${attempt}): ${text.split('\n')[0]}`);
          if (attempt === 2) report.errors.push({ kind: 'reel', cut, reel: name, text });
        }
      }
    }
    log(`[${cut}] encoding ${clips.length} clips`);
    const r = build(cut, clips, { dir, music: args.music });
    if (cut === 'youtube') r.thumbnails = thumbnails(dir);
    r.minutes = +((Date.now() - t0) / 60000).toFixed(1);
    report.cuts.push(r);
    for (const c of r.checks) log(`  ${c.ok ? '✓' : c.soft ? '·' : '✗'} ${c.check}`);
    log(`  → ${r.file} (${r.seconds.toFixed(1)} s, made in ${r.minutes} min)`);
  }
} finally {
  await browser.close();
  server.stop();
  stopAll();
}

// ---------------------------------------------------------------- what goes with the videos

const url = args['url-label'] ? `https://${String(args['url-label']).replace(/^https?:\/\//, '')}` : '<the game\'s address>';
const yt = report.cuts.find((c) => c.name === 'youtube');
const description = [
  '# Sky Arena Chess: what goes with the videos', '',
  '## YouTube', '',
  'Title ideas:',
  '- Chess, but the pieces shatter (and time rewinds) | free browser game',
  '- I made 3D chess where captured pieces shatter and you can rewind time', '',
  'Description:', '',
  '```',
  'Sky Arena Chess: 3D chess on a floating island, free in your browser. Captured pieces shatter with real physics and the',
  'wind blows the shards away; checkpoints rewind time, shards and all; the AI estimates your level and aims for a fair',
  'fight; and friends can play in a room, taking turns: winner stays on.',
  '',
  `Play: ${url}`,
  'Source (GPL-3.0), fork it: https://github.com/doublependu/chess',
  'More games: https://maize.live',
  'Multiplayer rooms: https://p3p2.me',
  '',
  'The Opera Game (Morphy, Paris 1858) is a replay: the AI is given Black\'s historical moves. The game against the AI',
  'that follows is not scripted.',
  '',
  ...(yt ? ['Chapters:', yt.chapterText] : []),
  '',
  '#chess #threejs #webgl #gamedev #indiegame #browsergame',
  '```', '',
  'Thumbnails: ' + (yt?.thumbnails?.join(', ') || 'none') + '. Subtitles: youtube.srt.', '',
  '## YouTube Short', '',
  'Title: Chess, but the pieces shatter 💥 #chess #shorts', '',
  `Description: Free in your browser: ${url} · Rewind time, shards and all. #chess #gamedev #threejs`, '',
  '## X', '',
  '```',
  'Chess, but the pieces shatter 💥, time rewinds ⏪, and friends take turns: winner stays on.',
  '',
  `Free in your browser: ${url}`,
  'Open source: https://github.com/doublependu/chess',
  '#chess #gamedev #threejs',
  '```', '',
].join('\n');
writeFileSync(`${DIR}/description.md`, description);
report.finished = new Date().toISOString();
writeFileSync(`${DIR}/report.json`, JSON.stringify(report, null, 2));
const failed = report.cuts.flatMap((c) => c.checks.filter((x) => !x.ok && !x.soft).map((x) => `${c.name}: ${x.check}`));
writeFileSync(`${DIR}/report.md`, [
  `# Film ${report.started}`, '',
  ...report.cuts.map((c) => [`## ${c.name}: ${c.seconds.toFixed(1)} s, ${(c.bytes / 1e6).toFixed(1)} MB, made in ${c.minutes} min`, '',
    ...c.checks.map((x) => `- ${x.ok ? '✓' : x.soft ? '·' : '✗'} ${x.check}`), '', 'Clips: ' + c.starts.map((s) => `${s.clip} @${s.at}s`).join(', '), '',
    c.chapterText ? 'Chapters:\n' + c.chapterText : '', ''].join('\n')),
  `Page errors: ${report.errors.length ? JSON.stringify(report.errors).slice(0, 1500) : 'none'}`,
].join('\n'));
console.log(`\nReport: ${DIR}/report.md · description: ${DIR}/description.md`);
console.log(failed.length || report.errors.length ? `✗ ${failed.length} failed check(s), ${report.errors.length} page error(s)` : '✓ all videos made and checked');
process.exitCode = failed.length || report.errors.length ? 1 : 0;
