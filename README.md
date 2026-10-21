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
npm run playtest:room        # two players and a watcher in a p3p2 room (needs ../p3p2, or --server URL)
```

## Playing with a friend

👥 opens the [p3p2](https://p3p2.me/#start) room window: paste a room URL from a p3p2 server's portal and send the invite.
For testing on one machine use two browsers or a private window (two tabs of one browser are one player).
`npm run playtest:room -- --lag` runs the room test through p3p2's lag proxy.

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
playtest/        persona players, balance simulation, browser playtests
scripts/         perf and deploy helpers
ai/              prompts, plans and notes (see CLAUDE.md)
```

## Backed by

Man & Bot

Browse web games at [Maize.Live](https://maize.live)
, or watch on YouTube [@RadWebGame](https://www.youtube.com/@RadWebGame)
