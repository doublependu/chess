# Plan 0: 3D chess with an adaptive AI, destructible pieces and time-rewind checkpoints

Answers `ai/prompt_0.md`. Constraints come from `CLAUDE.md`: first interaction in 2–3 s (1 s ideal, 4 s max), smooth on 5-year-old iGPU PCs and entry-level phones, and the client detects the device to choose a default graphics level that the player can change.

---

## 1. Key decisions

| Area | Decision | Why |
|---|---|---|
| Build | Vite 8, **plain JavaScript** (the `vanilla` template the README names), JSDoc types | Matches the README and needs no build-time type tooling |
| Rendering | three.js r186 `WebGLRenderer` (WebGL2), with procedural geometry only | No model or texture downloads, so first load stays small. WebGPU is skipped because support on low-end phones is less mature |
| Art style | Stylized toon look: `MeshToonMaterial`, inverted-hull outlines, squash and stretch | Covers the prompt's "animation style" and is cheap on iGPUs |
| Chess rules | Our own engine core in `src/core`, written once and used by both the game and the AI, checked by perft | The prompt asks for an AI written in client JS. One shared rule implementation means the game and the AI can't disagree |
| AI | Custom alpha-beta engine in a module **Web Worker**, plus an adaptive skill controller | Gives full control over how the AI makes "plausible" mistakes, which a Stockfish skill level doesn't |
| Fracture | `@dgreenheck/three-pinata` 2.x (MIT) for Voronoi fracture with impact points, inner-face material and seeds, run in a worker | It's a maintained real-time fracture library that handles non-convex meshes. It **requires manifold meshes**, so piece geometry is built watertight on purpose |
| Physics | **Rapier** (`@dimforge/rapier3d`, Apache-2.0) in a physics worker, loaded lazily after the game is interactive | Convex-hull colliders, CCD (fast shards don't pass through the board), deterministic. Measured cost: the wasm is 3.08 MB raw / **1.17 MB gzip**, so it must stay off the critical path. Fallback: `cannon-es` (~50 KB gzip) if the M0 spike shows problems |
| Destruction model | **Simulate first, then play back.** Physics for a capture runs headless in the worker during the attack wind-up, and the main thread plays the recorded keyframes | No physics cost on the main thread, the same smoothness on every device, and reverse playback just reads the frames backwards |
| UI | Plain DOM and CSS over the canvas, no framework | Keeps the bundle small |
| Persistence | `localStorage` (JSON with a schema version) | The data is small and needs no server |
| Deploy | Cloudflare **Workers static assets** with `wrangler deploy` and `preview_urls: false` | Cloudflare's current static-hosting path |
| Tests | Vitest for units, Playwright for end-to-end runs and playtests | Standard tools. Playwright can record video |

## 2. Budgets (checked by scripts, see §14)

- **Critical path**: `index.html` with inline CSS and SVG (≤ 10 KB br) plus one JS entry chunk (three subset and game code, **≤ 250 KB gzip**). No fonts, textures or models on this path.
- **Time to interactive (TTI)**: from navigation to the first rendered frame with input handlers attached, marked as `performance.mark('tti')`.
  - Target is ≤ 1.5 s on desktop broadband and ≤ 2.5 s on a "mid mobile" profile (10 Mbps, 80 ms RTT, 4× CPU throttle).
  - The test fails above 3 s, which leaves margin under the 4 s maximum.
- **Deferred loads**, all after TTI: Rapier and the physics worker, three-pinata and the fracture worker, extra environment detail for higher tiers, and audio synthesis.
  - The AI worker (about 20 KB) starts loading in parallel with the main chunk.
- **Frame rate**: 60 fps on Medium and High. The Low tier may cap at 30 fps when only idle animations are running.
  - A capture must not drop a frame on the main thread, because physics and fracture run in workers.
- **Shader compile**: use few material variants (one toon material per side, driven by uniforms) and `renderer.compileAsync()` before the first frame, so there's no hitch at first use.

## 3. Repo layout

```
index.html                 loading screen (inline CSS), GitHub corner, version badge placeholder
public/_headers            long-lived cache for /assets/*, short cache for index.html
public/manifest.webmanifest  (display: fullscreen, for add-to-home-screen)
wrangler.jsonc
vite.config.js             __APP_VERSION__ define, worker format 'es', wasm plugin for Rapier
src/
  main.js                  boot order: probe → renderer → scene → UI → mark TTI → deferred loads
  core/                    pure chess, no DOM: board.js (0x88), movegen.js, zobrist.js, fen.js, san.js, game.js (history, result, draw rules)
  ai/                      ai.worker.js, search.js, eval.js (PeSTO tapered PST), book.js (small), skill.js (player rating), director.js (adaptive control)
  render/                  renderer.js, quality.js (probe/benchmark/governor), camera.js (fit + orbit), board.js, materials.js
    pieces/                lathe profiles + knight builder → manifold BufferGeometry, outline hulls
    environment/           sky, island, clouds, grass, banners, particles; all read the shared wind uniform
    fx/                    deterministic particles, shockwave, hit flash, wind streaks, time-warp uniform
  anim/                    timeline.js, clip.js (pure apply(t)), clips/{idle,move,knightJump,castle,promote,attack/*,destroy}.js, timewarp.js
  destruction/             fracture.worker.js, physics.worker.js, bake.js (keyframe format), shards.js (pooled playback), fallbackBaker.js
  save/                    slots.js (3 checkpoints + autosave), rewind.js (path + meta-timeline)
  ui/                      hud.js, menus.js (title/pause/game over), settings.js, promotion.js, toast.js, version.js, githubCorner.js
  audio/                   synth.js (procedural WebAudio, optional)
  debug/testHooks.js       window.__test (read-only probes); only included in dev builds and when ?test=1
tests/                     Vitest unit tests
playtest/                  Playwright scripts, personas, balance sim, report generator
```

## 4. Chess core (`src/core`)

- **Board and moves**: 0x88 board in an `Int8Array`, with incremental make/unmake, Zobrist hashing (two 32-bit halves, no BigInt) and pseudo-legal generation plus a legality check.
- **Full rules**: castling (not through or out of check), en passant (including pinned cases), promotion to any piece, check, checkmate and stalemate.
- **Draws**: threefold repetition and the 50-move rule draw automatically, as casual apps usually do. Insufficient material is also detected.
- **Notation**: FEN in and out, SAN in and out (with disambiguation), and UCI move strings for storage. PGN export is a cheap extra.
- **`Game`**: the start FEN, a list of moves (`{uci, san, captured, flags, seed}`), and per-ply state for undo. It's the single source of truth: the scene is a projection of `Game`.
- **Tests**:
  - Perft against the chessprogramming.org suite: start position to depth 5 (4,865,609), Kiwipete to depth 4 (4,085,603), and positions 3–6.
  - Edge cases for each rule.
  - FEN and SAN round-trips.

## 5. AI: engine plus adaptive difficulty (`src/ai`)

### 5.1 Engine (worker)
- **Search**: iterative deepening with PVS and aspiration windows, a transposition table (typed arrays), null-move pruning, LMR, check extension, and quiescence with MVV-LVA and delta pruning. Move ordering uses killer and history heuristics.
- **Evaluation**: PeSTO tapered piece-square tables, plus light pawn-structure and king-safety terms.
- **Opening book**: a small embedded book (a few hundred lines) for variety.
- **Expected strength**: roughly 1800–2200 Elo at 1–2 s per move in JS. That's well above most casual players, so the top of the difficulty range has room.
- **Cancel**: a synchronous search can't receive messages, so loading a checkpoint while the AI is thinking **terminates and respawns** the worker. That takes milliseconds.
- **Analysis mode**: a fixed-budget search, independent of playing strength, used to grade the human's moves (§5.2). It runs right after each human move and takes about 50–100 ms.

### 5.2 Player skill model (`skill.js`, persisted)
- **Per-move grading**: win% = `50 + 50·(2/(1+e^(−0.00368208·cp)) − 1)`, and per-move accuracy uses the Lichess formula on the win% drop.
  - Moves are ignored when the position is already decided (|eval| > 600 cp) and during the book phase.
- **Rating**: a Glicko-style estimate (rating plus deviation), updated by per-game accuracy mapped to Elo and by game results.
  - A high deviation at the start lets it converge within 2–3 games.
- **Storage**: kept in `localStorage`. It is **not** rolled back when a checkpoint is loaded, because it describes the player, not the game.

### 5.3 Difficulty director (`director.js`)
- **Strength knobs** come from one continuous strength value (target Elo from about 400 to the engine's maximum):
  - node and depth budget;
  - root move choice: softmax over the root moves within Δ(strength) cp of the best, at temperature T(strength);
  - quiescence depth (weaker levels miss tactics, as humans do);
  - per-game evaluation noise ("personality");
  - artificial think time (0.4–1.5 s, longer in sharp positions).
- **Plausible mistakes only**: candidate moves that hang a major piece to a one-move capture, or allow mate in one, are removed except at the lowest levels, and even there they're rate-limited. The AI loses by playing like a weaker player, not by visibly throwing the game.
- **Between games**: target AI Elo = player estimate − 35, which aims for an expected player score of about 55%.
  - Streak breaker: after 2 losses in a row, step the AI down. After 3 wins in a row, step it up.
- **Within a game (subtle rubber-banding)**: when the AI leads by more than 250 cp, its strength eases down gradually (T up, budget down) to open a comeback window.
  - When the human leads, the AI returns to its base strength, plus at most a small fight-back bonus. It never goes above its cap, so wins aren't too easy.
  - All changes are smoothed, so there are no visible jumps.
- **Resigning**: the AI can resign when it's hopelessly lost, so the human gets a clean win.
- **Settings**: Difficulty "Adaptive (default)" or fixed levels 1–10. The pause menu shows a small "AI ≈ 1200" note.

## 6. Visuals (`src/render`)

### 6.1 Pieces (procedural, manifold by construction)
- **Pawn, rook, bishop, queen, king**: `LatheGeometry` profiles that start and end **on the axis**, so they're closed. Vertices are merged with `mergeVertices`.
  - Rook crenellations, the bishop's mitre slit and the king's cross are built as separate closed parts, which also look good when they fracture separately.
- **Knight**: a closed beveled `ExtrudeGeometry` of a horse-head silhouette on a lathe base. Head and base are separate closed parts.
- **Unit test**: every edge is shared by exactly two triangles, which guarantees the input three-pinata needs.
- **Style**: chunky stylized Staunton set. White is warm ivory or marble, black is dark lacquered wood. Toon gradient ramp plus outline hull. No faces by default (open question 5).

### 6.2 Board and environment: "Sky Arena"
- **Board**: carved into the plateau of a stone island **floating above a sea of clouds** at golden hour.
  - One mesh for the board. Square highlights (last move, legal moves, check) come from a small data texture or uniform array, so they cost one draw call.
- **Scenery**: broken pillars, team banners, instanced grass tufts, a few low-poly trees, distant floating islands, a gradient sky dome and billboard clouds.
- **Shared wind**: one wind uniform (prevailing breeze plus the gust envelope from §8) drives grass, banners, leaves and cloud drift. A gust is visible across the whole scene.
  - The shards blow off the edge of the island and fall into the clouds, which explains where they go.
- **Per-tier detail**: see §10.

### 6.3 Camera
- **Fit**: a perspective camera with the distance fitted analytically so the board plus margin fits **both** horizontal and vertical FOV for any aspect ratio.
  - Pitch is steeper in portrait (about 65°) and lower in landscape (about 50°). On resize or rotation it eases smoothly to the new fit.
- **Player controls**: limited orbit (±35° azimuth, pitch 30–75°), pinch or wheel zoom within bounds, and a "reset view" button.

## 7. Animation system: reversible by design (`src/anim`)

**Rule:** every effect tied to a move is a **pure function `apply(t)`** of `(pre-state, move, seed, t)`. It has no hidden state and no per-frame integration.
- Particles are analytic, for example `p = p0 + v0·t + ½g·t²`, with parameters from the seed.
- Time scaling (hit-stop, slow motion) is part of each clip's own time mapping.
- Physics is the only non-analytic part, and it's pre-baked to keyframes (§8).

This gives reverse playback (`apply(d − t)`) automatically. It also makes the animations frame-rate independent, makes "skip to end" exact, and makes playtests deterministic.

| Clip | Content (durations scale with distance; speed setting 1×/2×/instant) |
|---|---|
| Idle (continuous, not in history) | Breathing scale ±2%, gentle bob, the knight occasionally looks around, a random phase per piece. Side to move is slightly more "alert". The king trembles with a red pulse when in check. The selected piece lifts and hovers with a glow ring. Idle freezes during a rewind, as a "time stop" |
| Move | Anticipation squash, then a slide with a lean and small hop, then overshoot and settle (about 0.45–0.7 s) |
| Knight move | A parabolic **jump** over pieces that turns toward its heading, with squash on take-off and landing and a dust puff (about 0.7 s) |
| Castle | King slides two squares, rook hops over it |
| Promotion | Pawn glows, spins and morphs into the chosen piece, with sparkles |
| Attack (per attacker) | Pawn: hop and headbutt. Knight: leap and stomp. Bishop: tilt and diagonal slash with a streak trail. Rook: rumble and ground-pound with a shockwave. Queen: spin dash with a ribbon trail. King: heavy stomp. The victim flinches just before impact |
| Destroyed | Hit-stop (about 100 ms), white flash, shockwave ring, camera punch and shake (off with reduced motion), a short 0.3× slow-mo at the shatter, glowing cracks, fracture, then the wind gust (§8) |
| Game end | On checkmate the king topples and shatters as the finale |

Input unlocks as soon as the board state is final. Shards can keep drifting away while the next move starts.

## 8. Destruction: fracture, physics, wind (`src/destruction`)

1. **When a capture is committed** (before the attacker starts moving, so there's about 0.6–1.0 s of lead time), the main thread sends the fracture worker:
   - the victim type,
   - the impact point and direction (from the attacker's approach),
   - the seed,
   - the fragment count for the current tier.
2. **Fracture worker**: three-pinata Voronoi fracture with `impactPoint` and `seed`. It returns the fragment geometries (transferable buffers) and convex-hull point sets.
   - **Fallback**: each piece type is pre-fractured into 2–3 variants at idle time, and a variant is used if the on-demand fracture isn't ready by impact.
3. **Physics worker** (Rapier): a static board, static cylinder colliders for the other pieces, and island bounds.
   - Fragments get convex-hull colliders with CCD.
   - Impulse: a radial burst plus the attack direction.
   - Wind force per fragment is `F = ½ρ·Cd·A·|v_rel|·v_rel`, plus lift and curl-noise turbulence, using gust envelope `g(t)` (attack 0.3 s, sustain 1 s, decay 1 s). The gust direction is the prevailing wind, biased toward the nearest island edge.
   - It simulates about 4 s at 60 Hz (a few ms on desktop), records position and quaternion keyframes at 30 Hz in one `Float32Array`, and returns it.
4. **Playback**: pooled meshes interpolate the keyframes (slerp). The inner-face material has emissive cracks that fade over about 1 s.
   - Fragments fade or dissolve once they fall below the cloud layer.
   - Environment shaders read the same `g(t)`, so the grass and banners whip in sync, and wind-streak particles show the gust.
5. **Fallback baker**: a simple analytic ballistic integrator against the board plane. It's used if Rapier hasn't loaded (slow network, Save-Data) or fails.
6. **Cache**: bakes are kept per `(gameId, ply)` in an LRU (about 40 captures, ~80 KB each) for exact reverse playback within a session.
   - After a page reload they're regenerated from the stored seed and impact data. Results may differ slightly, which is fine visually.

## 9. Checkpoints and time reversal (`src/save`)

- **Slots**: 3 checkpoint slots, plus 1 hidden **autosave** so a refresh resumes the game. The autosave is recommended and cheap, and it also covers the rewind-after-reload case.
- **Slot content**:
  - schema version and timestamp;
  - human color;
  - move list (UCI plus the per-move seed);
  - in-game director state;
  - label (for example, "Move 23 · White to move · +1.2");
  - a 160×120 JPEG thumbnail (about 6 KB), rendered to a small render target.
- **Validation**: loaded data is replayed through the rules engine, and corrupt or illegal data is rejected with a toast.
- **UI**: Save opens the slot picker (with an overwrite confirmation). Load opens the picker with thumbnails. Empty slots are disabled. Both are available from the pause menu, and Save also from the HUD.
- **Rewind algorithm**:
  1. Lock input, finish or snap any running clip, and cancel the AI (respawn the worker).
  2. Path: k = the length of the common prefix of the current moves and the checkpoint moves.
     - **Reverse** plies N…k+1, then **fast-forward** plies k+1…M if the checkpoint is on another branch or ahead.
     - The usual case (an earlier save in the same game) is a pure rewind.
  3. Make sure every capture on the path has fragments and a bake. Use the cache, otherwise regenerate in the workers, streaming in path order.
     - A brief "time gathering" effect (a ripple building up) hides any preparation time.
  4. Meta-timeline: reverse clips use `apply(d − t)`. Shards rise out of the clouds against the wind, fly back, and **fuse** (the cracks glow, then seal). Attacks play backwards and pieces walk back.
     - A time-warp curve keeps the total at or under about 6 s: the first and last plies play near normal speed, and the middle is compressed.
  5. VFX: a global `timeWarp` uniform injected into the materials gives desaturation, a sepia tint and a ripple, with **no extra render pass** (cheap on Low). High adds chromatic aberration and bloom on the cracks. A reversed whoosh plays if audio is on.
  6. Tap or Esc skips to the end state.
  7. At the end, set the authoritative `Game` from the checkpoint, **snap every piece to its square** (this guards against drift), restore the director state, and let the AI move if it's the AI's turn.

## 10. Device probe and quality tiers (`render/quality.js`)

**Static probe** (before the renderer is created):
- WebGL2 support; if missing, show a friendly "unsupported browser" screen.
- `WEBGL_debug_renderer_info` GPU string, matched against a heuristic list:
  - Mali-G5x, Adreno ≤ 6xx low end, PowerVR, Intel HD/UHD → Low or Medium;
  - Apple GPU, Iris Xe, Radeon 680M+ → Medium or High;
  - discrete GPU → High.
- `hardwareConcurrency`, `deviceMemory`, `pointer: coarse`, screen size × DPR, `prefers-reduced-motion`, `connection.saveData`.

**Fixed for the session**: the static probe also decides the context `antialias` flag, which can't change without recreating the context.

**Runtime benchmark**: frame times are measured during the intro camera fly-in (about 2 s). The result can move the tier one step down, or one step up.

**Governor**:
- An EMA of frame time drives dynamic resolution, with the pixel ratio stepped in 10% increments and hysteresis.
- If frames stay slow at minimum resolution for more than 2 s, it drops one tier and shows a toast ("Graphics lowered to keep it smooth – change in Settings").
- It never raises the tier automatically in the middle of a game.
- Rendering pauses when the tab is hidden or the pause menu is open.

| Setting | Low | Medium | High |
|---|---|---|---|
| Pixel ratio (dynamic range) | 0.6–1.0 | 0.75–1.5 | 1.0–2.0 |
| MSAA | off | desktop only | on |
| Shadows | blob decals | 1024 map, frustum fitted to the board, re-rendered only when something moves | 2048 soft |
| Outlines | piece hulls | piece hulls | piece hulls + environment |
| Post FX | none (time warp via uniform) | none | bloom + vignette + grading |
| Fragments per capture | 6–8 | 12–16 | 24–32 |
| Debris lifetime | 2.5 s | 4 s | 6 s |
| Particles | ~100 | ~400 | ~1500 |
| Environment | island, sky, silhouettes | + grass, banners, clouds | + trees, torches, more clouds |
| FPS cap when idle | 30 | 60 | 60 |

**Settings**: Graphics Auto (default) / Low / Medium / High, plus individual toggles (shadows, post FX, resolution scale, particle density). Stored in `localStorage`.

## 11. Layout, input, mobile

- **Full screen**: `position: fixed; inset: 0` with `100dvh` and safe-area insets (`viewport-fit=cover`).
  - A `ResizeObserver` on the app root, plus `visualViewport` resize and orientation events, are debounced to rAF.
  - Size is re-measured over the next 2 frames (iOS can report a stale size for a frame).
  - Each resize updates `setSize`, the pixel ratio, the camera aspect, the camera refit and the HUD layout. No size is cached anywhere.
- **HUD**: portrait uses top and bottom bars (player cards, captured trays). Landscape uses side panels.
- **Corners** (default allocation):
  - top-left: menu or pause;
  - top-right: the GitHub corner on overlays;
  - bottom-right: reset view;
  - **bottom-left: version badge** (`pointer-events: none`, low opacity).
- **Zoom prevention**:
  - Viewport meta `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`.
  - `touch-action: none` on the canvas and `manipulation` on buttons.
  - `overscroll-behavior: none`, with no text selection or touch callouts.
  - On iOS, which ignores `user-scalable`: non-passive `preventDefault` on `gesturestart/gesturechange` and on multi-touch `touchmove`, plus double-tap suppression.
  - Pinch on the canvas becomes **in-game camera zoom** (bounded, with reset), so the player can always zoom back.
- **Input** (Pointer Events for mouse, touch and pen):
  - Tap a piece to show legal moves (dots for quiet moves, red rings for captures), then tap the target. Drag and drop also works.
  - An illegal drop makes the piece shake.
  - A drag that starts on empty space orbits the camera.
  - Keyboard users can type a SAN move into a small command box (`/` to focus). This is also handy for accessibility.
- **Promotion**: a picker appears near the target square.

## 12. UI screens

- **Loading screen** (inline in `index.html`, so it paints before any JS runs): title, progress bar and **GitHub corner** (inline SVG octocat, MIT, from tholman/github-corners) linking to `https://github.com/doublependu/chess` (from the git remote), opened in a new tab with `rel=noopener`.
- **Title**: Play as White, Black or Random; Continue (autosave); Load; Settings.
- **HUD**: player cards with the turn indicator and AI "thinking…", captured pieces, an optional collapsible move list, buttons (Save, Pause) and the check banner.
- **Pause screen**: Resume, Save, Load, New game, Resign, Settings, the AI level note, and the **GitHub corner**. The scene renders one static blurred frame and stops rendering.
- **Game over**: result and reason, rating change, New game, Load checkpoint.
- **Settings**: graphics, difficulty, animation speed (1×/2×/instant), sound, reduced motion (defaults to the OS setting), and "show legal moves".
- **Version badge**: `v.` followed by the first 4 characters of the commit, injected at build time into both the HTML (so it appears immediately) and the JS (§13).

## 13. Build and deploy

- `vite.config.js`:
  - `define.__APP_VERSION__ = 'v.' + sha.slice(0, 4)`, where `sha` comes from `WORKERS_CI_COMMIT_SHA` (Cloudflare Workers Builds) or else `git rev-parse HEAD`.
  - A small HTML transform plugin writes the badge into `index.html`.
  - No dirty-tree suffix, to keep the template exact. The deploy script **warns** if the tree is dirty, because the badge would then show HEAD rather than what was actually built.
  - Workers use `format: 'es'`, and `vite-plugin-wasm` handles the Rapier bundler build. This avoids the `-compat` package, whose base64-inlined wasm is even larger.
- `wrangler.jsonc`:
  ```jsonc
  {
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "chess",
    "compatibility_date": "2026-10-01",
    "assets": { "directory": "./dist" },
    "preview_urls": false
  }
  ```
- `public/_headers`: `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`, and `/index.html` gets `no-cache`.
- npm scripts:
  - `dev`, `build`, `preview`;
  - `deploy` (= `vite build && wrangler deploy`, matching the README) and `cf:dev` (`wrangler dev`);
  - `test`, `test:e2e`, `perf:size`, `perf:load`, `perf:fps`;
  - `playtest`, `playtest:balance`.
- `.gitignore` additions: `.wrangler/`, `playtest-output/`, `test-results/`, `playwright-report/`. `dist` is already ignored.
- **Licenses**: the repo is GPL-3.0, and every runtime dependency is MIT, Apache-2.0 or Zlib, which are compatible. `stockfish` (GPL-3.0) would be a devDependency for playtests only (optional).
- README: update the setup, deploy and testing sections. No commits, per CLAUDE.md.

## 14. Testing and automated playtesting

### 14.1 Unit tests (Vitest)
- Perft and rule edge cases; FEN and SAN round-trips; draw detection.
- AI:
  - always plays legal moves;
  - finds mate in 1 and mate in 2 at high strength;
  - respects its budgets;
  - the strength mapping is monotonic (an opt-in mini-match test).
- Skill model and director math.
- **Clip reversibility**: for every clip, `apply(0)` and `apply(d)` give the expected start and end, and forward then reverse returns to the start within ε.
- Save:
  - serialization round-trip;
  - corrupt data is rejected;
  - common-prefix and rewind path computation.
- Camera fit: the board corners project inside the viewport for aspect ratios from 9:21 to 21:9.
- Piece geometry is manifold.

### 14.2 Performance scripts
- `perf:size`: fails if the initial chunk is over 250 KB gzip. It also lists the lazy chunks.
- `perf:load`: Playwright with a cold cache, CDP network throttling (10 Mbps, 80 ms RTT) and 4× CPU slowdown.
  - It reads the `tti` mark, warns above 2 s and fails above 3 s, and saves a trace.
- `perf:fps`: a scripted game with captures on each tier, reporting p50 and p95 frame time.
  - **Caveat**: headless Chromium uses SwiftShader, so these numbers only mean something when run headed on a real GPU. CI-style runs are a smoke test.

### 14.3 Playtest scripts (the prompt's "play as a human")
- **Personas** (`playtest/personas.js`):
  - Beginner: prefers captures, blunders often;
  - Casual (~800);
  - Club (~1400);
  - Strong (~2000: our engine at full strength, or Stockfish if it's added).
  - Each persona has a think-time distribution and occasional **mis-taps** or abandoned drags, to exercise the UI.
- **`playtest` (UI-driven)**: Playwright drives the real built app with **pointer input on the canvas**, using desktop, Pixel and iPhone emulation.
  - `window.__test` is read-only: it maps a square to screen coordinates, returns the FEN, waits for idle, and reports the tier. Moves always go through the UI.
  - Scenarios:
    - full games per persona;
    - save at move 10, play on, load, and check that scene state equals checkpoint state (piece transforms, visibility);
    - load from another branch;
    - **rotation in the middle of a game**, then check that taps still land on the right squares and that there's no stretching (canvas size equals the viewport × DPR);
    - pause and resume, promotion, changing tier mid-game;
    - simulated WebGL context loss and restore;
    - a long game watching for heap growth and console errors.
- **`playtest:balance` (headless, Node)**: hundreds of persona-vs-AI games using the same `ai/` and `skill`/`director` modules, starting from fresh skill state.
  - Reports score per persona over game index, the rating trajectory, game length, comebacks, AI "gift" blunders, and how early games are decided.
  - **Acceptance**: after game 5, the rolling score of every persona is between 35% and 60%. No persona is under 25% or over 75% across games 6–30. The Beginner wins at least one of its first 5 games.
- **Recordings** go to `playtest-output/<timestamp>/` (gitignored, **never committed**): Playwright videos (webm), traces, `games.pgn`, `metrics.json`, and a `report.html` summary.
- **Feedback loop**: findings go into tuning (director constants, animation timing, UI) and bug fixes. A summary of each run, not the recordings, goes into `ai/next_0.md`.

## 15. Milestones (in order; each one leaves a working build)

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold and spikes: Vite vanilla, deps, `wrangler.jsonc`, version define, `.gitignore`, Vitest and Playwright, perf scripts. **Spikes**: (a) three-pinata fracturing a lathe pawn inside a worker, timed with 4× CPU throttle; (b) Rapier bundler build in a Vite module worker, with its actual transfer size; (c) a zoom-prevention test page on iOS and Android emulation | `dev`, `build` and `wrangler deploy --dry-run` work; the badge shows `v.xxxx`; the physics library choice is confirmed or switched to cannon-es |
| M1 | Chess core | All perft and rule tests pass |
| M2 | Playable 3D: procedural pieces and board, input, responsive camera, basic HUD, loading screen with GitHub corner, local two-player mode for debugging | A full legal game is playable by tap or click on desktop and mobile emulation; TTI is measured within budget |
| M3 | AI worker, skill model, director, headless balance harness | The balance sim meets the §14.3 acceptance targets (first pass) |
| M4 | Animation system with idle, move, knight jump, castle, promotion and attack clips | The reversibility tests pass, and the clips look right at 1×, 2× and instant |
| M5 | Destruction: fracture worker, physics bake, shard playback, wind gust plus environment coupling, fallback baker | Captures are dramatic on every tier with no main-thread frame drops |
| M6 | Sky Arena environment, per tier | Visual pass; the Low tier holds 30+ fps under a 4× CPU throttle |
| M7 | Quality system: probe, benchmark, governor, settings UI | The tier is chosen automatically and can be overridden; the governor recovers from forced load |
| M8 | Checkpoints, rewind and fast-forward, autosave | The UI playtest's save → play → load → state-equality check passes, including the other-branch and after-reload cases |
| M9 | UI polish: pause, game over, settings, toasts, reduced motion, audio (stretch) | Every screen works in portrait and landscape |
| M10 | Playtest runs, tuning and bug fixing; perf verification; README update; write `ai/next_0.md` | All test and perf scripts are green, and the balance acceptance targets are met |

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| three-pinata needs manifold input; procedural geometry could break that | Build closed parts (lathe profiles end on the axis, knight head and base are separate closed meshes) and add a manifold unit test. Fracture each part separately |
| Fracture or bake too slow on low-end phones | Run in workers, start at move commit (0.6–1 s lead), use pre-fractured variants as fallback, and cap fragments per tier |
| Rapier is 1.17 MB gzip | Deferred, prefetched at idle, with the fallback baker meanwhile. Switch to cannon-es if the M0 spike or field data says so |
| Adaptive AI feels fake or patronizing | Mistakes come only from a plausible candidate set, changes are smoothed, there are gift-blunder guards, and the balance sim plus video review tune it |
| iOS can't fully disable accessibility zoom | Use every available block, route pinch to the in-game camera, and don't depend on page zoom staying at 1 |
| Long histories make the rewind tedious | The time-warp curve caps the length at about 6 s, and tap skips it |
| GPU memory leaks from shards and fragment geometry | Pooled meshes, explicit `dispose`, an LRU on the bake cache, and the long-game heap check in the playtest |
| Shader-compile hitches on mobile | Few material variants and `compileAsync` before first use; the time warp is a uniform, not a new material |
| The three.js bundle grows through `examples/jsm` imports | The `perf:size` gate |
| Headless WebGL perf numbers are misleading | Real-GPU headed runs for perf; headless only for function and load-time checks |

## 17. Assumptions and open questions (the defaults are what the plan uses)

1. **Language**: plain JS, following the README's `vanilla` template. TypeScript is an easy switch if you prefer it.
2. **Human color**: White by default, with White, Black or Random offered in New Game. No chess clock.
3. **Draws**: threefold repetition and the 50-move rule are automatic, not claimed.
4. **Setting**: the "Sky Arena" floating-island concept. Any other setting works with the same wind coupling.
5. **Pieces**: classic faceless stylized Staunton. Cartoon faces or eyes could be added for more "animation" character.
6. **Physics**: Rapier, deferred (with cannon-es as fallback), pending the M0 spike.
7. **Not requested but planned**: an autosave/resume slot and procedural audio (the audio is a stretch goal and can be dropped).
8. **AI difficulty**: Adaptive is the default, with manual levels 1–10 in Settings. The player rating is not rolled back on checkpoint load.
9. **Hosting**: the deploy targets `workers.dev` (`preview_urls: false`). A custom domain (for example under maize.live) would be a later `routes` entry.
10. **Fork link**: `https://github.com/doublependu/chess`.
