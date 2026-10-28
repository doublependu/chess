// Showcase videos of the game, recorded from the real production build as a person plays it, frame by frame
// (playtest/film/clock.mjs), and cut for YouTube (16:9, about 4½ min), a YouTube Short (9:16, under a minute) and X
// (1:1, under a minute, captioned to work muted). Everything goes to playtest-output/film-* (gitignored); the finished
// videos and the text to post with them are gathered in its upload/ folder.
//
// Usage:
//   npm run film                                    # all three cuts
//   node playtest/film.mjs --cut short              # one cut
//   node playtest/film.mjs --cut youtube --reels opera,rewind   # some reels only, to try them
//   node playtest/film.mjs --url-label chess.example.com --music track.mp3   # the end card's address (ch0.maize.live)
//   node playtest/film.mjs --no-build --url http://localhost:5173/
//
// The friends reel needs a p3p2 checkout next to this one (../p3p2, or --p3p2 <dir>), as `npm run playtest:room` does.
// Rendering uses the GPU in a headless browser; --headed shows the windows instead.
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { parseArgs, outDir, startServer } from './lib.mjs';
import { PRESETS } from './film/kit.mjs';
import { REELS } from './film/reels.mjs';
import { build, thumbnails } from './film/encode.mjs';
import { stopAll } from './rooms.mjs';

const args = parseArgs({ cut: 'all', reels: null, 'url-label': 'ch0.maize.live', music: null, p3p2: '../p3p2', build: true, url: null, headed: false, port: 4182 });

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

// ---------------------------------------------------------------- the upload folder: the videos and their posts

const site = String(args['url-label'] || '').replace(/^https?:\/\//, '');
const url = site ? `https://${site}` : '<the game\'s address>';
const yt = report.cuts.find((c) => c.name === 'youtube');
const UP = `${DIR}/upload`;
mkdirSync(UP, { recursive: true });
// Hard links: the folder takes no more space (a copy where a link can't be made).
const put = (from, to) => {
  if (!existsSync(from)) return;
  rmSync(to, { force: true });
  try { linkSync(from, to); } catch { copyFileSync(from, to); }
};
for (const c of report.cuts) put(c.file, `${UP}/${c.name}.mp4`);
if (yt) {
  put(`${DIR}/youtube/youtube.srt`, `${UP}/youtube.srt`);
  for (const t of yt.thumbnails || []) put(`${DIR}/youtube/${t}`, `${UP}/youtube-${t}`);
}
// A paragraph is one line: YouTube and X keep every line break that is pasted.
const block = (...lines) => ['```', ...lines, '```'];
const posts = [
  '# Sky Arena Chess: the posts', '',
  'The videos are in this folder. What is in a code block is ready to paste.', '',
  '## YouTube: youtube.mp4', '',
  'Title (one of):', '',
  ...block('Chess, but the pieces shatter (and you can rewind time)'), '',
  ...block('I made 3D chess where captured pieces shatter and time rewinds'), '',
  'Description:', '',
  ...block(
    `Play free in your browser: ${url}`,
    '',
    'Sky Arena Chess is 3D chess on a floating island. Captured pieces shatter with real physics, and the wind blows the '
      + 'shards away. Save a checkpoint and rewind time, shards and all. The AI estimates your level and aims for a fair '
      + 'fight. Send friends one link to play in a room: whoever is watching gets in line, and the winner stays on.',
    '',
    'No install, no sign-up.',
    '',
    'The Opera Game (Morphy, Paris 1858) is a replay: the AI is given Black\'s historical moves. The game against the AI '
      + 'after it is not scripted.',
    '',
    ...(yt ? ['Chapters:', yt.chapterText, ''] : []),
    'Source code (GPL-3.0), fork it: https://github.com/doublependu/chess',
    'More games: https://maize.live',
    'Multiplayer rooms: https://p3p2.me',
    '',
    '#chess #indiegame #browsergame',
  ), '',
  'Tags: chess, 3d chess, browser game, chess game, physics, three.js, webgl, indie game, game dev', '',
  `Thumbnail: ${(yt?.thumbnails || []).map((t) => `youtube-${t}`).join(' or ') || 'none'}. Subtitles: youtube.srt (English).`, '',
  '## YouTube Short: short.mp4', '',
  'Title:', '',
  ...block('Chess, but the pieces shatter 💥 #shorts'), '',
  'Description:', '',
  ...block(
    `Play free in your browser: ${site || url} (no install, no sign-up)`,
    '',
    'The moves are Morphy\'s Opera Game, Paris 1858, replayed. Then a checkpoint, a blunder, and time rewinds.',
    '',
    '#chess #gamedev #shorts',
  ), '',
  'A link in a Short\'s description can\'t be clicked, so the address is on the end card. Once the long video is up,',
  'set it as this Short\'s related video.', '',
  '## X: x.mp4', '',
  'Post:', '',
  ...block(
    'Chess, but captured pieces shatter 💥, you can rewind time ⏪, and friends take turns at the board: winner stays on.',
    '',
    `Free in your browser, no sign-up: ${url}`,
    'Open source: https://github.com/doublependu/chess',
    '',
    '#chess #gamedev',
  ), '',
  'A reply under it (optional):', '',
  ...block('Built with three.js and Rapier physics. Multiplayer rooms by https://p3p2.me'), '',
  'Alt text for the video:', '',
  ...block(
    'A 3D chess board on a floating island. A knight takes a queen, and the queen shatters. A player saves a checkpoint, '
      + 'loses their queen to a blunder, and rewinds time. Then a room with friends: one more joins, finds both seats taken '
      + 'and gets in line; after the game, the loser leaves the board and the one waiting sits down.',
  ), '',
];
writeFileSync(`${UP}/posts.md`, posts.join('\n'));
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
console.log(`\nReport: ${DIR}/report.md · videos and posts: ${UP}/`);
console.log(failed.length || report.errors.length ? `✗ ${failed.length} failed check(s), ${report.errors.length} page error(s)` : '✓ all videos made and checked');
process.exitCode = failed.length || report.errors.length ? 1 : 0;
