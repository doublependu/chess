# Next 0: implementation summary and what to work on next

This answers `prompt_0.md` and follows `plan_0.md`. Everything in the plan's milestones M0–M10 is implemented. Deviations and open issues are listed below.

## What was built

| Area | Where | Notes |
|---|---|---|
| Rules engine | `src/core/` | 0x88 board, legal move generation, make/unmake, Zobrist hashing, FEN/SAN/UCI. All draw rules are automatic. Perft-verified (start position to depth 5, Kiwipete, positions 3–6) |
| AI | `src/ai/` | Alpha-beta in a Web Worker (PVS, TT, null move, LMR, quiescence, PeSTO eval, ~750k nodes/s) and a small opening book |
| Strength limiter | `src/ai/strength.js` | Depth/node budget, softmax over a candidate window, beginner "oversights", eval noise |
| Adaptive difficulty | `src/ai/skill.js`, `director.js` | Player rating from results plus ACPL (centipawn loss) on informative moves. ACPL is mapped onto the AI's own measured ACPL curve. First-5-game in-game calibration. Streak-scaled K. In-game comeback window that closes once a game is decided. The AI resigns only at 1200+ |
| Pieces | `src/render/pieces/` | Procedural, manifold by construction (tested): lathe profiles, extruded knight head, rook merlons, crown jewels, cross. Toon shading, rim light and an inverted-hull outline |
| Environment | `src/render/environment/` | "Sky Arena": floating low-poly island, cloud sea shader, gradient sky, pillars, banners, trees, grass and petals. All of it is driven by one shared wind uniform |
| Animation | `src/anim/` | Every clip is a pure `apply(t)`, so reverse playback is exact. Clips: idle, move, knight leap, castling (rook hops over the king), promotion morph, six attack styles, destruction, checkmate finale. Captures add hit-stop, slow motion, shockwave, sparks, camera shake and punch-in. "Gates" hold the strike until the shards are ready |
| Destruction | `src/destruction/` | Worker does three-pinata Voronoi fracture with an impact point, then a Rapier bake. Rapier runs for the first 2.8 s, then an analytic integrator continues. The main thread only replays keyframes. Pure-JS fallback simulator. LRU cache per capture |
| Checkpoints | `src/save/`, `src/game/controller.js` | 3 slots with thumbnails, plus autosave/Continue. Rewind: sepia time-warp grade, shards fly back and fuse, attacks play backwards, then a fast-forward along the checkpoint's own branch |
| Quality | `src/render/quality.js` | GPU-string, memory and core probe pick a tier, then a 2 s benchmark, then a dynamic-resolution governor that drops a tier as a last resort. High tier adds lazy-loaded bloom and vignette |
| Mobile | `index.html`, `src/game/input.js` | Full-screen `dvh` layout and safe areas. Orientation changes refit the camera. Pinch is routed to the game camera, page zoom is blocked |
| UI | `src/ui/ui.js` | GitHub corner on the loading, title, pause and game-over screens. Version badge `v.xxxx` (bottom-left) |
| Audio | `src/audio/synth.js` | Procedural WebAudio sounds, no files |
| Deploy | `wrangler.jsonc`, `public/_headers` | Workers static assets, `preview_urls: false`. `npm run deploy` warns on a dirty tree |

## Measured (Intel HD 630 laptop, Chromium)

- **Critical path:** 183 KB gzip (151 KB brotli) against a 250 KB budget. Rapier's wasm (1.15 MB gzip), the workers and the bloom code all load after first interaction.
- **Time to interactive** (`npm run perf:load`, headless):

  | Profile | TTI |
  |---|---|
  | Desktop broadband | 0.45 s |
  | 10 Mbps, 80 ms, 4× CPU | 1.41 s |
  | 5 Mbps, 150 ms, 6× CPU | 2.2 s |

- **Frame time** (`perf:fps --headed`): ~17.5 ms at p50 on every tier. This machine's compositor paces at ~57 fps; GPU time is 2.6 ms on Low and roughly 7–8 ms on Medium/High (the headed perf run reported no reading for those two). The first capture used to stall about 100 ms while shaders compiled; that's fixed by a warm-up render.
- **Destruction:** fracture 70–450 ms and bake 80–300 ms, depending on CPU load. On High under heavy load it took 443 ms + 1015 ms before the hybrid bake.
- **Unit tests:** 67 pass (`npm test`).
- **Browser playtests** (`npm run playtest`, production build, headless): all scenarios pass, covering pause/fork corner/version, promotion, context loss, checkpoint rewind/branch/fast-forward/after reload, rotation ×5 with touch input, and persona games on desktop and phone.
- **Balance** (`npm run playtest:balance -- --games 24 --seed 4242`): after the first 5 games the human scores 0.42 (beginner), 0.55 (casual), 0.53 (club) and 0.58 (strong). That's inside the 0.35–0.60 target. The beginner won 1 of their first 5 games.

## Bugs found by the playtest scripts and fixed

- Taps on a square behind the selected piece hit that piece instead. Fix: prefer the board square under the finger when it's a legal target.
- The board top z-fought with the slab, which looked like shadow acne.
- Rapier was pre-bundled twice by Vite in dev, so its wasm wasn't initialised. Fix: `optimizeDeps.exclude`.
- The AI resigned too early at low levels and couldn't convert won games (it stalemated instead). The depth-1 search now detects mate and stalemate.
- The skill estimate was inflated by Lichess-style accuracy, so ratings rose after losses. It now uses ACPL on the AI's own scale.
- The GitHub corner on overlays fell back to text after the loading screen was removed.
- Board coordinates were upside-down when playing Black.
- First-capture shader compile stalls.

## Deviations from plan_0

- Settings offer a graphics tier (Auto/Low/Medium/High), not individual toggles for shadows, post, resolution and particles.
- No move-list panel; captured pieces and material are shown in the player cards.
- The rewind uses a fixed budget of about 6.5 s, with debris playing back 3.2× faster.
- `perf:fps` gives meaningful numbers only with `--headed` on a real GPU (headless uses SwiftShader).

## Known issues and caveats

- Only Chromium was tested, with mobile emulation (Pixel 5 / iPhone UA). Safari/iOS (zoom blocking, `dvh`, WebGL2 performance) and real low-end Android are unverified.
- The sound effects are synthesized and haven't been listened to by a human yet.
- `wrangler dev` needs workerd's postinstall script, which npm 11 blocks by default: run `npm approve-scripts workerd` once. `wrangler deploy` works without it (dry run verified).
- `npx playwright install chromium` (needed for `@playwright/test` 1.64) replaced the older cached Chromium build. If the Playwright MCP browser stops launching, reinstall its browser.
- Strong players win their first few games while the AI calibrates up from 850; strong players start winning less after about 5–8 games.
- The knight is a single extruded silhouette, so it reads well in profile but is flat head-on.

## What to work on next (suggested order)

1. **Real-device pass:** iPhone Safari, a 2020–2021 entry Android (Mali-G52 / Adreno 610), and an iGPU laptop. Tune `LOW_GPU`/`MID_GPU` regexes, the governor thresholds and the Low tier, and confirm iOS can't get stuck zoomed.
2. **Human playtest feedback** on difficulty feel and animation pacing. Watch the videos in `playtest-output/ui-*/video`. If games feel long, consider making "Fast" the default animation speed on phones.
3. **Visual polish:** a better knight (lofted head), optional cartoon faces, a camera cut-in for queen/rook captures, a richer impact (dust ring, ground cracks), a proper sound-design pass.
4. **UX:** move list / PGN export, per-feature graphics toggles, an optional hint button, a "last game recap" replay using the reversible clips.
5. **Perf:** instance identical pieces (118 → ~40 draw calls on Low), prefetch fracture for likely captures while the human thinks, and cache baked shards in IndexedDB so a rewind after reload is exact.
6. **CI:** a GitHub Action running `npm test`, `perf:size` and a short `playtest` smoke run (headless), uploading reports as artifacts.
