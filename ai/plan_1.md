# Plan 1: steady outlines on phones, chess with a friend over p3p2, and two links

Answers `ai/prompt_1.md`. The constraints from `CLAUDE.md` still apply:
- first interaction in 2–3 s (4 s at most);
- smooth on 5-year-old iGPU PCs and entry-level phones;
- the device probe picks the defaults, and the player can change them.

---

## 1. Key decisions

| Area | Decision | Why |
|---|---|---|
| Jittery outlines | Keep both the outline and the idle animation. Make the outline **never thinner than about 1.5 device pixels**, and make idle motion **calm by default on phones**, with a setting | The cause is an outline narrower than a pixel and drawn without antialiasing, which the idle motion moves by fractions of a pixel (§2.1). Removing either one treats a symptom and costs readability or life |
| Multiplayer | Port the p3p2 integration from `~/Repos/mine/public/p3p2_test_repos/chess`, using **`@p3p2/client` 0.1.1 from npm** instead of its vendored tarball | That fork branches from this repo's own `911a8dc itr 0`, so its diff applies to the same files. The npm 0.1.1 build matches the vendored one, with only doc-comment and bundling changes |
| Shared state | The room's **op log** is the game. Every page replays the same ops, in the same order, through `src/core`. There is no host | Chess is turn-based and small. The log also allows correspondence play (move, close the tab, answer tomorrow) |
| Load budget | Only the p3p2 entry (under 2 KB gzip) is on the critical path. The room client, panel and QR code (about 16 KB gzip) load when 👥 is pressed or an invite is opened | Keeps TTI where it is. An ordinary visit contacts no server |
| Room mode | In a room, the AI, rating, checkpoints, rewind and autosave are off. There's no clock. Colours swap every game | The reference's defaults. A shared history can't be rewound by one player. All of this is easy to change (§8) |
| p3p2.me link | "Need a room? Make one free at p3p2.me", next to every 👥 entry point. It points at `https://p3p2.me/#start` | That section ("Try it now: a temporary server") is the how-to-make-a-room guide. The p3p2 panel itself only says "Paste a room URL from your p3p2 server's portal" |
| Maize.Live link | "More games on Maize.Live" in the fine print of the loading screen, the pause menu and the in-room menu | The in-room menu takes the pause menu's place in a room |

## 2. Issue 1: piece outlines jitter on mobile

### 2.1 What causes it (read from the code; M1 measures it first)

- **The outline is an inverted hull with a fixed thickness of 0.016 world units.** It's set in `createOutlineMaterial(0.016)` (`src/render/pieces/pieceView.js:20`), and the shader is in `src/render/materials.js`. A square is 1 unit wide.
- **On a portrait phone, the fitted camera puts about 40 CSS px across a square.** On a 393 px-wide screen, the board and rim (about 9.4 units) fill the width.
  - So the outline is about **0.6–0.7 px** wide, and narrower on the back ranks.
  - On a 1080p desktop it's about 1.4 px, with MSAA on.
- **Phones get the worst rendering for a thin line:**
  - The Low tier renders at pixel ratio ≤ 1.0, and the governor can drop to 0.6 of that (`TIERS.low` in `src/render/quality.js`).
  - MSAA is off on touch devices below High (`src/render/stage.js`: `antialias: msaa && !(coarse && tier !== 'high')`).
  - A line narrower than a pixel, without antialiasing, is drawn as broken dashes.
- **The idle animation moves the hull by fractions of a pixel every frame** (`Stage.updateIdle`, `src/render/stage.js:339`):
  - a bob of 0.025 × 1.25 units, about 1.3 px;
  - breathing of ±2 % of the piece's height, about 1 px;
  - a yaw sway, ±0.28 rad on the knight.
  - Each frame the dashes land on different pixels, so the outline crawls. Low also caps idle frames at 30 fps (`fpsIdle: 30`), which makes each step visible.
- **Without the idle motion**, the outline would be still but broken. **Without the outline**, the motion would be smooth.
  - So the prompt's two options would each hide the problem.
  - But dropping the outline loses the dark-piece-on-dark-square separation. Dropping the idle animation leaves a dashed outline on the back ranks.

### 2.2 The fix

1. **An outline that's never thinner than a pixel** (`src/render/materials.js`, `src/render/stage.js`):
   - Push the hull out by `max(uThick, uMinPx · uWorldPerPx · depth)`. Here `depth` is the vertex's view-space distance, computed in the vertex shader before `project_vertex`.
   - `uWorldPerPx = 2·tan(fov/2) / drawingBufferHeight` is a shared uniform. It's updated in `Stage.applyPixelRatio()`, next to the particles' `pixelScale`, so it follows resizes, rotation and the governor's resolution changes.
   - `uMinPx` is about 1.5 device px; the final value is set by the M1 screenshots.
   - Using `max` with today's world thickness keeps the desktop look as it is. Only screens where the outline would be thinner than a pixel get a thicker one.
   - The cost is a few ALU ops per hull vertex, with no extra draw calls.
2. **Calm idle motion by default on phones** (`Stage.updateIdle`, `src/save/slots.js`, `src/ui/ui.js`):
   - New setting **Idle animation: Auto / Full / Calm / Off**, with `idleMotion: 'auto'` in `DEFAULT_SETTINGS`.
   - Auto means Calm on a coarse pointer or the Low tier, and Full otherwise. Reduce motion = On also means Calm unless the player chose otherwise. This replaces today's 0.35 scale.
   - **Calm:** no breathing and no yaw sway. Only the side to move bobs, slowly and at half height, so whose turn it is still shows. The knight's head turn shrinks to about ±0.08 rad.
   - **Off:** pieces at rest stand still.
   - **In every mode, the selection lift and the king-in-check shake stay**, because they're gameplay feedback, not idle motion.
   - The settings row shows what Auto picked, the way the Graphics row already does.
3. **Fallback, only if the real phone still looks bad after 1 and 2:** an "Outlines: On/Off" row under Graphics, defaulting to Off on Low.
   - That is the prompt's option B, made a choice instead of a rule.

### 2.3 How it's checked

- **New playtest scenario `outline`** (`playtest/play-ui.mjs`):
  - Pixel 5 emulation, `?quality=low&test=1`, start position.
  - Uses a new test hook, `__test.renderAt(t)`, which sets the stage clock and renders one frame.
  - It renders frames at t and t + 1/30 s and crops around each piece. It reports:
    - **coverage**: the share of each piece's silhouette edge that has the outline colour;
    - **flicker**: outline pixels that toggle between the two frames, divided by the outline pixel count.
  - Run before and after the fix and record both in `next_1.md`.
  - The aim is coverage ≥ 0.9 on every piece and flicker down by at least 3×. Desktop 1080p should come out within 5 % of today's coverage, meaning the look hasn't changed.
  - Headless SwiftShader is fine for this, because it measures geometry, not speed.
- **Unit test** that `idleMotion: 'auto'` resolves to Calm for coarse/Low and to Full otherwise.
- `npm run perf:fps -- --headed` on Low and Medium: frame time unchanged.
- **For you on the real phone:** whether the pieces now read at a glance, and whether Calm still feels alive enough.

## 3. Feature 1: multiplayer with `@p3p2/client`

### 3.1 What it means (as in the reference)

- Two people play one game, and anyone else in the room watches.
- The room keeps the game, so it can be played by correspondence.
- A page plays a move **when its op comes back from the room**, not before. That takes about 0.1 s over the internet, after which every page has the same state.

| Op | Valid when | Does |
|---|---|---|
| `sit {c, name}` | Seat `c` (0 white, 1 black) is free, and the sender isn't in the other one | Seats the sender |
| `stand` | The sender is seated | Frees the seat. If the game has moves, that side loses it |
| `move {n, ply, uci}` | Game `n` is current and not over, `ply` is the next ply, the sender is on move, and the move is legal | Plays it |
| `resign {n}` | Game `n` is current and not over, and the sender is seated | Ends it |
| `offer {n, ply}` | The same, at the current ply | Offers a draw until the next move |
| `accept {n, ply}` | The other side offered at that ply | Ends the game as a draw |
| `new {n}` | Game `n` is over or has no moves, and the sender is seated | Starts the next game, with colours swapped |

- An op that isn't valid is ignored by every page alike.
- A snapshot holds the table as JSON: the moves of the current game, plus one line per finished game (at most 50).
- `seedOf(n)` is shared, so pieces shatter the same way for everybody.
- Per page, not shared: the shattering simulation and wind, the camera (from your own side; watchers see White's view), and settings, graphics and sound.

### 3.2 Files

| File | What | Source |
|---|---|---|
| `package.json`, `package-lock.json` | `npm install @p3p2/client` (^0.1.1) | New (the reference used `file:vendor/…`) |
| `vite.config.js` | `optimizeDeps: { exclude: ['@dimforge/rapier3d', '@p3p2/client'] }`. Without this, the dev server bundles the whole library into the entry, as the p3p2 README warns | New |
| `src/net/table.js` | The table: pure, no DOM and no network. It validates and applies ops, saves and loads snapshots, and computes `fingerprint()` | Reference, unchanged |
| `src/net/company.js` | `new P3P2({ game: { id: 'sky-arena-chess', version: TABLE_VERSION }, ui: { corner: 'bottom-right', button: false } })`. Also: room adoption, seat claiming, presence, toasts, and `__test.room` hooks | Reference, from its newest commit (the client queues ops while reconnecting) |
| `src/core/game.js` | `RESULT.AGREED`, `Game.agree()`, and `undo()` clearing `agreed` | Reference |
| `src/game/controller.js` | Room mode: `enterRoom`, `leaveRoom`, `adoptTable`, `follow` (animates one move at a time, or jumps when out of step), `sendMove` with an 8 s timeout, `roomHud`, `showRoomGameOver`, `roomMenu`, `offered`. Plus guards in `newGame`, `restore`, `openSave`, `openLoad`, `resign` and `pause`, and `mySeat` replacing `humanColor` in input | Reference |
| `src/ui/ui.js` | 👥 entries on the title and pause menus, `showRoomMenu`, `showRoomGameOver`, `setNames`, `setRoomMode` (hides 💾/⏪), plus the links in §4 | Reference, plus the §4 links |
| `index.html` | A 👥 `#btn-people` next to ⌖ in `#hud-actions`, plus the Maize.Live line on the loading screen | Reference, plus §4 |
| `src/main.js` | `openCompany(ctrl, ui)` after boot. `ui.on('people')` opens the panel. In a room, switching tabs doesn't pause | Reference |
| `tests/table.test.js` | 7 table tests, plus one for `Game.agree()` | Reference, plus one |

**Why `game.version` is `TABLE_VERSION` and not the app version:** a deploy that only changes graphics doesn't split players into different rooms. Only a change to the op or snapshot format does, by bumping `TABLE_VERSION`.

### 3.3 What changes against the reference

- The npm package replaces `vendor/p3p2-client.tar.gz`, and the `optimizeDeps` exclude is added. No API this game uses has changed.
- The p3p2.me link goes next to every way into a room (§4.1).
- The Maize.Live line also goes in the in-room menu.
- The outline and idle-motion work (§2) is shared by both modes; nothing room-specific.
- I'll re-read the reference controller diff against today's `controller.js` while porting, and fix any spot where the base has moved. This repo has only `prompt 1` on top of `911a8dc`, so none is expected.

### 3.4 Load budget

- Critical path: the reference build's entry chunk is 188.6 KB gzip, against today's 183 KB. That's under the 250 KB budget.
- The lazy p3p2 chunks are core 7.9 KB, panel 4.9 KB, QR 2.0 KB and local 1.5 KB, all gzip.
- `npm run perf:size` and `npm run perf:load` must still pass at today's three profiles.
- `perf:load` also asserts that **a plain visit opens no WebSocket and makes no request to any other origin**.

### 3.5 How it's tested

- **Unit tests:**
  - `tests/table.test.js` covers invalid ops ignored, seat races, a stand mid-game losing the game, offer/accept only at the offered ply, `new` swapping colours, snapshot round-trips, and malformed snapshots producing an empty table.
  - `npm test` should go from 67 to about 75.
- **New browser playtest `playtest/play-room.mjs`** (`npm run playtest:room`). It's opt-in because it needs a p3p2 server:
  - **Server:** either `P3P2_OWNER_PASSWORD=… npm run dev` in `~/Repos/mine/public/p3p2`, or the `p3p2/p3p2` Docker image. The script takes `--server http://localhost:8080` and reads the password from the environment.
  - **Room:** it logs in to the portal and creates a room for the `vite preview` URL, the way p3p2's `e2e/tests/helpers.ts` `createRoom` does.
  - **Players:** a desktop host (context A), a phone guest in Pixel 5 emulation (context B, joined through the invite), and a watcher (context C). Each context is a separate player; two tabs of one browser would be the same player.
  - **Checks:**
    - the first two seats are taken, White first;
    - about 20 persona plies are played through real taps and clicks, with **`fingerprint()` equal on all three pages after every move**;
    - a capture shatters on both players' pages;
    - a tap out of turn, or by the watcher, does nothing;
    - after B reloads, it's back in the same seat and position;
    - a draw offer is shown and accepted on the other side;
    - resign works;
    - "Next game" swaps colours;
    - the watcher takes a seat that was given up;
    - Leave brings back the title screen and the AI, and the autosave from before the room is still there.
  - **Optional lag:** with `--lag`, the same run goes through p3p2's `npm run lag -- --latency 150 --jitter 50` proxy with one forced connection drop. Both players must end on the same game.
  - Videos and reports go to `playtest-output/room-*` (git-ignored, not committed).
- **For you, by eye:**
  - whether a move appearing 0.1–0.3 s after the second tap feels slow;
  - whether the name plates make it clear who is who;
  - whether a watcher understands what they're seeing.

## 4. Feature 2: links

### 4.1 p3p2.me (how to make a room)

- **Where:** in the title menu and the pause menu, as one fine-print line directly under "👥 Play with a friend", and in the in-room menu's fine print.
  - The text is `Need a room? Make one free at p3p2.me ↗`, linking to `https://p3p2.me/#start`.
- **Why not inside the p3p2 panel:** the panel is the library's own shadow-DOM UI and has no slot for a game's help link.
  - So the line sits next to the game's own entry points. The panel opens over the menu, and the link is right next to it.
- If p3p2 later adds a help-link option to `UiOptions`, the link moves there.

### 4.2 Maize.Live (more games)

- **Where:**
  - in `index.html`'s loading screen fine print: `Fork me on GitHub · GPL-3.0 · More games on Maize.Live`;
  - in the pause menu's fine print, next to the GitHub link;
  - in the in-room menu, which is the pause screen in a room.
- It links to `https://maize.live`, with `target="_blank" rel="noopener"`.
- Same style as the GitHub link, so no new CSS. Inline, so the critical path grows by a few bytes.
- The loading screen is up for 0.5–2 s, so its link is there for slow loads. The pause menu is where most players will see it.
- `play-ui.mjs`'s `pause` scenario gets a check that both links are present with the right `href`.

## 5. Milestones (in order; each one leaves a working build)

1. **M1, outline measurement:** add the `renderAt` hook and the `outline` scenario, and record the baseline (coverage, flicker, screenshots).
2. **M2, outline that's never thinner than a pixel:** the shader and the shared uniform. Re-measure, tune `uMinPx`, and confirm desktop is unchanged.
3. **M3, idle motion setting:** Auto/Full/Calm/Off with the device default, plus its unit test.
4. **M4, links:** Maize.Live on loading, pause and in-room menus. p3p2.me goes in with M5.
5. **M5, p3p2 port:** npm install, Vite exclude, `table.js`, `company.js`, the game, controller, UI and main changes, the p3p2.me lines, and `tests/table.test.js`.
6. **M6, room playtest:** `play-room.mjs` against a local server, the `perf:size` and `perf:load` asserts, and a lag run.
7. **M7, docs:** README (multiplayer, how to run a local server, `playtest:room`) and `ai/next_1.md` with the measured numbers.

Then the full `npm test`, `npm run playtest`, `perf:size` and `perf:load`, as after plan 0.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A 1.5 px outline looks heavy on a phone with DPR 3 rendering at pixel ratio 1.0, where 1 device px is 3 physical px | Tune `uMinPx` from the M2 screenshots (1.0–1.5). If Low's 1.0 cap is the real problem, raise Low's `pixelRatioMax` to about 1.25 on phones, only if `perf:fps` shows room |
| The hull thickens on pieces up close when pinch-zoomed | `max(world, px)` only ever thickens distant or low-resolution outlines. Up close, the world thickness wins, as today |
| The scale in the promotion morph and the breathing stretches the hull a little | It's already the case today. The depth term uses the model-view position, so it follows the same transform |
| A quick opponent moves while the previous capture is still animating | `follow()` plays one move at a time and calls itself again when each animation ends. It jumps to the table if the board is out of step (reference behaviour) |
| The p3p2.me temporary servers are alpha (they may be down or full) | The link explains self-hosting too. The game works without a room, and a failed `start()` leaves the AI as it was |
| The reference's own e2e (`e2e/tests/games/chess.spec.ts`) is no longer in the p3p2 repo | `play-room.mjs` lives here, next to the game it tests |
| Players open two tabs in one browser and expect two players | Mentioned in the README's "testing with a friend" note (two browsers, or a private window) |

## 7. Not in this plan

- A chess clock, or rated games between people.
- Chat beyond what the p3p2 panel already has.
- Spectator camera controls beyond White's view.
- Real-device tuning of the quality-tier regexes (still next_0's item 1).

## 8. Assumptions and open questions (the defaults are what the plan uses)

1. **Idle on phones:** Calm by default, not Off. Say if you'd rather it be Off.
2. **Outlines stay on, on phones**, with the "never thinner than a pixel" fix. The On/Off row is added only if the real phone still looks bad.
3. **Room mode**, as in the reference: no AI or rating, no checkpoints, rewind or autosave, no clock, colours swap each game.
4. **Maize.Live** goes on loading, pause and in-room menus only, not on the title or game-over screens, which have the GitHub corner. It's one line each if you want it there too.
5. **p3p2.me** links to `/#start` ("Get started / Try it now"), not the home page.
6. **`game.id` is `sky-arena-chess`**, as in the reference. Rooms are tied to the game they were first played with, so changing it later would turn away existing rooms.
