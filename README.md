# chess

**Sky Arena Chess** — a static, in-browser 3D chess game. The AI is written in JavaScript and adapts to how well you play. Pieces leap, attack and shatter (real fracturing + physics), the debris is blown off a floating island by a gust of wind, and loading a checkpoint rewinds time: shards fly back and fuse, attacks play backwards.

- Classic chess rules (castling, en passant, promotion, check/mate/stalemate, threefold, fifty-move, insufficient material)
- Adaptive AI in a Web Worker: it estimates your level from your moves and results and aims for a fair fight
- three.js, procedural toon-style pieces and environment (no model/texture downloads)
- Fracturing with [three-pinata](https://github.com/dgreenheck/three-pinata), physics with [Rapier](https://rapier.rs) (lazy-loaded)
- 3 checkpoint slots with a time-rewind animation, plus autosave/continue
- Device probe + Low/Medium/High graphics tiers, dynamic resolution, works on phones (portrait/landscape)

## Setup and run

```bash
npm install
npm run dev
```

## Initial setup

```bash
npm create vite@latest . -- --template vanilla
claude --dangerously-skip-permissions
```

## Deploy

Deploys `dist/` to Cloudflare Workers static assets (`wrangler.jsonc`, `preview_urls: false`).
The version badge in the bottom-left corner shows `v.<first 4 characters of the deployed commit>`; `npm run deploy` warns if the working tree has uncommitted changes.

```bash
npx wrangler login
npm run deploy
```

## Tests, playtests and performance

```bash
npm test                     # unit tests: rules/perft, AI, director, saves, animation timeline, camera fit, geometry
npm run playtest:balance     # headless AI-vs-persona games: checks the adaptive difficulty stays fair
npm run playtest             # drives the real build in Chromium like a human (taps, drags, rotation, saves/rewind)
npm run perf:size            # critical-path bundle budget (250 KB gzip)
npm run perf:load            # time-to-interactive under throttled network/CPU
npm run perf:fps -- --headed # frame/GPU time per graphics tier (needs a real GPU)
npm run playtest:room        # four people in a p3p2 room, taking turns (needs ../p3p2, or --server URL)
npm run film                 # showcase videos: YouTube (16:9), a Short (9:16) and X (1:1); see "Videos" below
```

## Playing with a friend

A room is joined by its invite link, which the owner of a [p3p2](https://p3p2.me/#start) server sends out (or shows on
the server's front page): everybody opens it, the owner too, and the first two in play. p3p2's own button, bottom right
(or "Play with a friend" in the menus), opens the room window: who's here, chat, and the same link and its QR code to
pass on. The button shows how many are in the room and when chat came in.
For testing on one machine use two browsers or a private window (two tabs of one browser are one player).
`npm run playtest:room -- --lag` runs the room test through p3p2's lag proxy.

More than two take turns. Whoever finds both seats taken is asked "Do you want to play or just keep watching?", and
gets in line to play (or out of it) from ☰ later. Winner stays on: when a game is over and somebody waits, the loser
goes to the back of the line and the first in line sits down (after a draw, the one who has sat longer goes); the next
game starts by itself after 15 s, or at once with "Start now". A seated player who is not there can be skipped by the
other player or the first in line: after a minute before the first move, after two in a game begun (which then counts
as their loss). With nobody waiting, nothing changes: the two play on, changing colours. All of it is the game's own
ops in the room's log (`src/net/table.js`); p3p2 needs nothing new.

## Videos

`npm run film` records the production build as a person plays it (a cursor, or a finger on a phone) and cuts three
videos into `playtest-output/film-*/`: `youtube/youtube.mp4` (1920×1080, about 4½ minutes, with chapters, subtitles
and two thumbnails), `short/short.mp4` (1080×1920, under a minute) and `x/x.mp4` (1080×1080, under a minute, captioned
to work muted), with `description.md` (titles, descriptions, chapters, links) and a report of checks on each.

- It renders frame by frame on a clock of its own (Playwright's fake clock, CSS animations set to the same time), so
  a video is smooth at 60 fps however slow the machine; the game's sounds are rendered afterwards from the same
  `Synth` code into the same timeline. The room reel is recorded in real time instead (its server keeps real time).
- Options: `--cut youtube|short|x`, `--reels opera,rewind` (some reels only), `--url-label <the game's address>` for
  the end card, `--music <file>` for music under the game's sounds, `--p3p2 <dir>` for the room reel's server.
- It uses the GPU from a headless browser (`--use-gl=angle --use-angle=gl-egl`); `--headed` shows the windows.

Playtest output (videos, traces, reports, PGNs) goes to `playtest-output/`, which is git-ignored. The first browser run may need `npx playwright install chromium`.

URL options: `?quality=low|medium|high` forces a graphics tier, `?test=1` exposes read-only test hooks (`window.__test`) in production builds.

## Project layout

```
src/core/        chess rules (0x88 board, move generation, FEN/SAN, game state)
src/ai/          search + evaluation, strength limiter, skill model, difficulty director, worker
src/render/      stage, camera, board, procedural pieces, environment, particles, quality tiers
src/anim/        reversible clips (move, knight leap, attacks, destruction, castling, promotion, finale)
src/destruction/ fracture + physics bake worker, shard playback, wind gust
src/save/        checkpoint slots, autosave, rewind path
src/game/        controller (game flow, AI turns, rewind) and pointer input
playtest/        persona players, the human-like driver, balance simulation, browser playtests, room helpers
playtest/film/   the film script's clock, overlay, reels and encoder (npm run film)
scripts/         perf and deploy helpers
ai/              prompts, plans and notes (see CLAUDE.md)
```

## Backed by

Man & Bot

Browse web games at [Maize.Live](https://maize.live)
, or watch on YouTube [@RadWebGame](https://www.youtube.com/@RadWebGame)
