# Plan 2: p3p2's own button, spectators taking turns, and showcase videos

Answers `ai/prompt_2.md`. The constraints from `CLAUDE.md` still apply:
- first interaction in 2–3 s (4 s at most);
- smooth on 5-year-old iGPU PCs and entry-level phones;
- the device probe picks the defaults, and the player can change them.

---

## 1. Short answers

1. **Why the p3p2 logo button isn't used.** The box (the panel) already is p3p2's own, unchanged: 👥 and "Play with a friend" both call `p3p2.open()`. Only the button was turned off (`ui: { corner: 'bottom-right', button: false }` in `src/net/company.js`).
   - **Why it was turned off:** the setting came over with the port of the reference fork in plan 1. Its comment says "No corner is free": ☰ top left, 💾 ⏪ top right, the version bottom left, and 👥 ⌖ bottom right.
   - **That isn't a good enough reason.** The p3p2 button shows things our 👥 doesn't:
     - how many people are in the room;
     - an unread-chat badge (today, chat that arrives while the panel is closed gives no sign at all);
     - the teal "live" pulse while the server is heard from.
   - So yes: use it as it comes, in the bottom-right corner, and move ⌖ out of its way (§3). "Play with a friend" stays in the title and pause menus and opens the same panel.
2. **Spectators taking turns: yes, without any change to p3p2.**
   - The room's op log is the game's own JSON. The server never reads it.
   - The waiting line and the rotation are new ops and rules in `src/net/table.js`. Every page derives the same table from the same log, as it does for moves now.
   - Who is here right now comes from `room.members`, `member.state` and the member events, which p3p2 0.2.0 already has. The game uses them only to decide which buttons to show, never to change the table.
   - "Do you want to play or just keep watching?" is the game's own dialog.
   - §4.6 lists three things p3p2 could add later; none of them is needed.
3. **Recordings:** a new film pipeline (`npm run film`) built on the playtest driver, with a refined "human" player. It makes three cuts:
   - a ~5 min YouTube video (16:9);
   - a YouTube Short (9:16, under 60 s);
   - an X video (1:1, about 45 s, captioned so it works muted).

   They're rendered frame by frame on a virtual clock, so they're smooth whatever the machine. Recordings go to `playtest-output/` and aren't committed.

## 2. Key decisions

| Area | Decision | Why |
|---|---|---|
| Multiplayer button | p3p2's own button, bottom right (`button` left at its default). Our 👥 HUD button goes. ⌖ moves to sit just above the p3p2 button | It's the button p3p2 is designed around, and it brings the count, the unread badge and the live state. Its height is fixed (one line), so stacking ⌖ above it can't collide. Its width changes with the count, so placing ⌖ beside it could |
| Safe areas | One CSS rule moves `p3p2-panel` in by `env(safe-area-inset-*)` | p3p2 places it 12 px from the corner and ignores notches and the home indicator. That's worth fixing in p3p2 itself, after which the rule goes |
| Menu button | Keep "Play with a friend" in the title and pause menus, with the p3p2 mark in place of the 👥 emoji | The menu and the corner then show the same symbol for the same panel. The mark is about 400 bytes of inline SVG, under MIT, and the mark's licence notice is kept with the SVG |
| Turn rule | **Winner stays, loser goes to the back of the line.** After a draw, the player who has sat longer goes. With nobody in line, nothing changes from today | That's what the prompt suggests, and it's the familiar "winner stays on". The draw rule keeps the line moving |
| Asking | A newcomer who finds both seats taken is asked "Do you want to play or just keep watching?" The loser is put back in line automatically, and the game-over box offers "Just watch instead" | The loser was playing a moment ago, so staying in line is the likely choice. Everyone else is asked once and can change their mind from the menu |
| Absent players | Only while someone is waiting in line: a player who isn't there can be skipped (before the first move) or replaced (during a game, counting as their loss). The button appears on the other pages after a timeout | The table can't see presence, so the timeout is enforced by the UI and the op is enforced by the table. With nobody waiting, correspondence play works as it does today |
| Format | `TABLE_VERSION` goes from '1' to '2' | A v1 page would ignore the line and fall out of step at the first rotation. A v2 table reads v1 snapshots and logs and gets the same result as v1, because rotation only happens when someone is in line |
| Film timing | Virtual time: Playwright `page.clock` drives timers, rAF and `performance.now`. CSS animations are paused and stepped through the Web Animations API. Each frame is captured over CDP and piped straight into ffmpeg | The result is smooth 60 fps with no hitches from the machine, and no 40 GB of PNGs. A real-time capture of a WebGL game stutters and is low quality |
| Film audio | The game's own sounds, logged with their virtual times and rendered afterwards in an `OfflineAudioContext` by the same `Synth` code. Optional music track via `--music` | The sound lines up with the picture to the sample, and there's no music licensing problem unless you bring a track |
| Captions | Injected into the page by the film script, styled like the game, so they're in the frames. An `.srt` file is also written | One pipeline for all three cuts, and nothing added to the app bundle |
| App bundle | Film-only code lives in `playtest/film/` or a lazy `src/debug/film.js` loaded only with `?test=1` | The critical path is unchanged |

## 3. Item 1: the p3p2 button and panel as they come

### 3.1 Changes

| File | Change |
|---|---|
| `src/net/company.js` | `ui: { corner: 'bottom-right' }`, and drop the "No corner is free" comment |
| `index.html` | Remove `#btn-people`. `#hud-actions` (now only ⌖) moves to `bottom: calc(58px + var(--safe-b))`: the p3p2 button is about 34 px tall at 12 px from the bottom, plus a 12 px gap. Add `p3p2-panel { right: calc(12px + var(--safe-r)) !important; bottom: calc(12px + var(--safe-b)) !important; }` |
| `src/ui/ui.js` | Drop `btn-people` from the HUD wiring. `friendButton()` shows the p3p2 mark plus "Play with a friend". The in-room fine print changes from "The 👥 button, bottom right…" to "The p3p2 button, bottom right, is the room: who's here, the invite, chat, and leaving." |
| `src/main.js` | `ui.on('people')` stays. It closes the pause menu and calls `company.open()`, which is the same panel the corner button opens |
| `README.md` | "👥 opens the room window" becomes the p3p2 button |
| `playtest/play-room.mjs` | Open the panel with `p3p2-panel button[aria-label^="Multiplayer"]`, which matches both the stand-in and the full button, instead of `#btn-people`. Also check once that the menu's "Play with a friend" opens the same panel |

### 3.2 What to check

- **The p3p2 button doesn't overlap** ⌖, the name plates, toasts or the version. Check on Pixel 5 portrait, Pixel 5 landscape, iPhone 12 and desktop 1366×768, out of a room and in one with a count. Use bounding-box asserts in the `pause` scenario of `play-ui.mjs`, plus screenshots.
- **`computeInsets` still fits the board.** ⌖'s new place raises the portrait bottom inset by about 46 px. Phones are limited by width in portrait, so the board shouldn't shrink. The screenshots will confirm it.
- **The button is on the title screen too** (it's created after boot, so it isn't on the loading screen). That's good: the way into a room is always visible.
- **`perf:load`:** an ordinary visit still opens no socket and makes no request to another origin. The stand-in button loads nothing.
- **`perf:size`:** about +0.4 KB.

## 4. Item 2: spectators take turns

### 4.1 The table (`src/net/table.js`, `TABLE_VERSION = '2'`)

**New state, which is also in the snapshot:**
- `line: [{ pid, name }]`: who wants to play next, in order, at most 32;
- `stay: [g0, g1]`: how many games in a row each seat's player has played.

A v1 snapshot loads with `line = []` and `stay = [1, 1]`.

| Op | Valid when | Does |
|---|---|---|
| `line {name}` *(new)* | The sender isn't seated and isn't in line | Adds them to the end of the line |
| `unline` *(new)* | The sender is in line | Takes them out of the line |
| `skip {n, c}` *(new)* | Seat `c` is taken, the line isn't empty, and the sender is the other seated player or in line | Like `stand` for seat `c`: if the game has moves, `c` loses it. The skipped player is **not** put back in line. The seat is filled from the front of the line |
| `sit {c, name}` | As today, and if the line isn't empty, only the player at the front may sit | |
| `stand` | As today | Then the free seat is filled from the front of the line straight away (`stay = 0` for that seat) |
| `new {n}` | As today, and the player at the front of the line may also send it | **If someone is in line and the game had a result:**<ul><li>the loser leaves the seat and goes to the back of the line;</li><li>after a draw, the player with the higher `stay` leaves (if equal, the one who had White);</li><li>if the loser already stood up, nobody else leaves.</li></ul>The player who stays swaps colours, as today. The newcomer takes the other seat. `stay` updates. With nobody in line, it's exactly today's `new` |

- **It's all deterministic.** Each op depends only on the table and the sender's pid. Duplicates are no-ops, because of the `n` check and the "already in line" check, so pages can safely send the same op twice (resends, countdowns).
- **`fingerprint()`** also includes the line, so the tests catch any page that falls out of step.

### 4.2 Company (`src/net/company.js`)

- **On entering a room:** `sitIfFree()` as today. If both seats are taken and this player isn't seated or in line, ask (§4.3). A reload doesn't ask again, because the line is part of the table.
- **Resends:** `line`, `unline` and `skip` are resent until they're seen, the same way moves are. This works around p3p2's known loss of an op that's in flight when the connection drops (next_1). It's safe because they're idempotent.
- **Absence timers, local to each page:** a seated player who is not `here` counts as absent:
  - for 60 s before the first move;
  - for 120 s during a game, and only once they're `lost` or have left the room. `away` (a backgrounded tab, such as a phone switched to another app to send the invite) doesn't count until 120 s.

  Only after that, and only while the line isn't empty, do the other seated player and the player at the front of the line get a "Skip Carol" or "Replace Carol" button. The timers can be shortened through `__test.room.timers({...})` for the playtest.
- **Toasts:**
  - "Carol wants to play next"
  - "Carol takes Bob's seat"
  - "You're next" (to the player at the front of the line)
  - "You were skipped. Get back in line from ☰"

### 4.3 What players see (`src/ui/ui.js`, `src/game/controller.js`)

- **The question**, in the game's own style:
  - **Title:** "Both seats are taken"
  - **Text:** "Do you want to play or just keep watching?"
  - **Buttons:** **🙋 Play: get in line** (shows "you'd be #3") and **👁 Just watch**.
  - Closing it counts as Just watch.
- **The room menu (☰):**
  - "🙋 Get in line" or "Leave the line";
  - the line itself ("Next: Carol, then you");
  - "Skip / Replace X" when the timeout allows;
  - everything it shows today.
- **Name plates:** a watcher's own plate says "Watching · #2 in line". The plate of a player who is about to be replaced says so after the game ends.
- **Game over in a room, when someone is waiting:**
  - "Next game: Ada vs Carol. Bob goes to the back of the line."
  - It counts down from 15 s ("Starts in 12 s"), with "Start now" for the player who stays and the newcomer.
  - At 0, every page that is seated or at the front of the line sends `new {n}`. The first one counts, and the rest are ignored.
  - The player who is leaving also gets "Just watch instead", which sends `unline`.
- **Nobody waiting:** exactly today's Rematch box.

### 4.4 Tests

- **Unit tests (`tests/table.test.js`, about +12):**
  - joining the line, the order, and duplicates ignored;
  - only the player at the front of the line may sit;
  - `stand` fills from the line;
  - `new`: the winner stays and the loser goes to the back;
  - the draw rule and its White tie-break;
  - a loser who already stood isn't sent out again;
  - `skip` before and after the first move;
  - the colour swap when someone comes in;
  - an empty line gives v1 behaviour, on a replayed v1 log;
  - a v1 snapshot loads;
  - the snapshot round-trip;
  - two tables fed the same shuffled-duplicate log end up with the same fingerprint.
- **`playtest/play-room.mjs`** gets a fourth person:
  - Ada (desktop, White) and Ben (phone, Black) take the seats.
  - Cy and Di arrive and are both asked. Cy chooses Play and Di chooses Just watch.
  - Ben resigns. The countdown runs, then Ada plays Cy with colours swapped, and Ben is in line.
  - The next game ends in an agreed draw. Ada has sat longer, so she goes and Ben comes in.
  - Cy closes the page. With the timers shortened, Ben gets "Replace Cy", the game counts as Cy's loss, and Ada comes in.
  - Di gets in line from ☰.
  - A reload keeps the place in line.
  - Every op is checked with `fingerprint()`, which must be equal on all four pages. It also runs with `--lag`.

### 4.5 Load budget

The table, menu and dialog add about 2 KB gzip to the critical path. `perf:size` and `perf:load` must still pass.

### 4.6 Not needed from p3p2, but worth having later

1. Safe-area insets for the corner button (§3).
2. Ack and resend for ops in flight (already in next_1). The game works around it.
3. A way for a game to put a tag on members in the panel's list ("playing", "next"). Today the line is shown only in the game's own menu.

## 5. Item 3: the recordings

### 5.1 The pipeline (`npm run film`)

```
node playtest/film.mjs --cut youtube|short|x|all [--headed] [--music track.mp3] [--url-label chess.example] [--keep-frames]
```

| File | What |
|---|---|
| `playtest/human.mjs` | **The refined human driver**, shared with `play-ui.mjs` (§5.2) |
| `playtest/film.mjs` | Build, serve, run the cut's reels, encode, check. Reuses `lib.mjs` (`startServer`, `launch`, `openGame`) and play-room's p3p2 server start-up |
| `playtest/film/clock.mjs` | **Virtual time:** <ul><li>`page.clock.install()` before load;</li><li>`pauseAt` when a reel starts;</li><li>per frame: `runFor(1000/60)`, then pause and seek every `document.getAnimations()` and open shadow root's animations, then CDP `Page.captureScreenshot` into ffmpeg's stdin (`image2pipe`);</li><li>while `__test.film.waiting()` (an animation gate waiting for shards, the AI worker still thinking), real time passes but virtual time doesn't, so there are no hitches</li></ul> |
| `playtest/film/overlay.js` | Injected with `addInitScript`: <ul><li>a cursor sprite and click ripple (desktop), or a finger dot (touch), that follow the real pointer events;</li><li>caption lower-thirds, title cards, the end card, a "4×" time-lapse badge, fades;</li><li>uses the game's colours and fonts</li></ul> |
| `playtest/film/reels/*.mjs` | One function per reel (§5.3). Each returns its chapter marks and caption cues |
| `playtest/film/cuts.mjs` | The three edits: viewport, tier, reels and their order, target lengths, caption text |
| `playtest/film/encode.mjs` | ffmpeg: <ul><li>reel → intermediate (x264 CRF 12);</li><li>concat with `xfade`;</li><li>audio mix (SFX, optional music ducked under it with `sidechaincompress`), then `loudnorm` to −14 LUFS;</li><li>platform encode, thumbnails, `.srt`, contact sheets, checks</li></ul> |
| `src/audio/synth.js` | `new Synth({ ctx })` and a `startAt` time instead of `ctx.currentTime` everywhere. Behaviour in the game is unchanged |
| `src/debug/film.js` (lazy, `?test=1` only) | <ul><li>`scriptAi(ucis)`: the AI plays these replies, then thinks for itself again;</li><li>`waiting()`;</li><li>the sound event log (with virtual times), and `renderAudio()` → WAV;</li><li>`orbit({yaw, pitch, zoom}, ms)` camera tweens for establishing shots;</li><li>turning the resolution governor off, since virtual frames always look like 60 fps</li></ul> |
| `src/debug/testHooks.js` | `__test.film()` loads the above |

**Output:** `playtest-output/film-<stamp>/` (git-ignored). It contains:
- `youtube.mp4`, `short.mp4`, `x.mp4`;
- `thumb-*.png` (1280×720);
- `captions-*.srt`;
- `description.md`: title ideas, chapters taken from the reel marks, links and hashtags;
- `sheet-*.jpg`: one frame every 2 s;
- `report.json`.

### 5.2 Playing like a person (refined)

Today's personas choose moves well, but the cursor jumps and the timing is mechanical. `human.mjs` adds:
- **Cursor paths:** minimum-jerk curves with a slight arc, a small overshoot and correction, and pointer speed by distance (Fitts).
- **Hesitation:** sometimes hovering over one or two other pieces first, and now and then picking a piece up, putting it back, and playing another (the selection is visible on the board).
- **Thinking time:** log-normal, longer with more legal moves, a capture available, or check. In films, long thinks are cut or time-lapsed, not shown in full.
- **Input:** tap-tap or drag (both already supported). On touch, real touch drags through CDP `Input.dispatchTouchEvent`, and an occasional pinch or orbit gesture on empty board space.
- **Two speed settings:** `play-ui.mjs` uses a fast setting (the playtests don't slow down much), and the films use the cinematic one.

### 5.3 Reels (each is a scripted, repeatable segment)

| Reel | What it shows | How |
|---|---|---|
| `intro` | The real load to the title screen, then a slow orbit of the island: wind, clouds, banners | Load in real time, then `orbit()` on virtual time. Caption: "Ready in about a second" (measured: 1.1 s on broadband, next_1) |
| `opera` | Morphy's **Opera Game (1858)**: knight leaps, bishop pins, attack styles, **queenside castling with the rook's hop**, the queen sacrifice, the checkmate finale | The human driver plays White through the UI. `scriptAi` gives Black's historical replies. **Captioned "Replaying Morphy's Opera Game, 1858"**, so the AI isn't credited with those moves. Quiet moves are time-lapsed at 4× |
| `vs-ai` | A short real game against the adaptive AI, nothing scripted, and the pause screen's "AI level ≈ · your level ≈" | Persona `club`, difficulty Auto |
| `rewind` | 💾 save to a slot (with its thumbnail), a blunder where the queen shatters, ⏪ load: sepia, the shards fly back and fuse, the attack plays backwards, then the fast-forward along the branch | Through the UI, like the `checkpoint` playtest |
| `promotion` | A pawn promotes with the morph (and an underpromotion to a knight) | Starts from a FEN autosave, like the `promotion` playtest |
| `devices` | Rotating a phone mid-game, and Low / Medium / High side by side | Three captures of the same moves, put side by side by ffmpeg `hstack`. Each one is labelled with its tier |
| `friends` | The p3p2 button and panel, the invite and QR code, a move showing up on the other screen, "Do you want to play or just keep watching?", and winner stays on | **Recorded in real time** (§7). The desktop and phone pages are captured with CDP screencast on the real GPU and put side by side. Uses play-room's local p3p2 server |
| `outro` | The end card: the game's URL, "Fork me on GitHub", "More games on Maize.Live", "Multiplayer: p3p2.me" | The overlay. The URL comes from `--url-label` |

### 5.4 The three cuts

| Cut | Page | Output | Length | Plan |
|---|---|---|---|---|
| **YouTube** | 1280×720 CSS at 1.5×, High | 1920×1080, 60 fps, H.264 High CRF 16, AAC 320k 48 kHz, faststart | ~5:00 | <ul><li>0:00 cold open: a queen capture shattering in slow motion</li><li>0:08 title and load</li><li>0:20 the arena</li><li>0:40 the Opera Game</li><li>2:20 checkpoints and rewinding time</li><li>3:05 promotion</li><li>3:20 adaptive AI</li><li>3:45 playing with friends and taking turns</li><li>4:30 phones and graphics tiers</li><li>4:50 end card</li></ul>Chapters go in `description.md`, plus 2 thumbnails |
| **Short** | 432×768 CSS at 2.5× (phone portrait UI), touch | 1080×1920, 60 fps | 45–58 s | <ul><li>0–2 s hook: "Chess, but the pieces shatter", with a capture</li><li>a knight leap, a strike, the castling hop</li><li>"Made a mistake? Rewind time." with save, blunder and rewind</li><li>the checkmate finale</li><li>"Free in your browser"</li></ul>It ends on the frame it starts with, so it loops. Captions stay out of the bottom ~20 % and the right ~12 %, where the Shorts UI sits |
| **X** | 720×720 CSS at 1.5× | 1080×1080, 60 fps, under 512 MB | 40–50 s | <ul><li>the hook (a shatter) in the first 2 s</li><li>rewind</li><li>friends and taking turns</li><li>adaptive AI</li><li>end card</li></ul>Large burned-in captions throughout, because it autoplays muted |

Each cut is recorded at its own viewport rather than cropped from another, so every video shows the layout the game really uses at that shape. That responsive layout is itself something worth showing. The platform limits (Shorts length, X length and file size) are checked again on the day of encoding.

### 5.5 How the videos are checked

I can't watch a video the way you will, so before handing them over:
- **ffprobe:** resolution, fps, duration, codecs and audio rate match the preset.
- **`ebur128`:** loudness is −14 LUFS ±1, with true peak at most −1 dB.
- **`blackdetect` and `freezedetect`:** no black or frozen stretch outside the deliberate fades and title cards. This catches a stalled reel.
- **Contact sheets** (one frame per 2 s), which I look at:
  - the captions are inside the safe areas;
  - the cursor and finger match the moves;
  - the shards are present at each capture (not the "gate timed out" fallback);
  - the rewind reads clearly.
- **Determinism:** the same reel rendered twice gives the same frame hashes (seeded `Math.random` in film mode). That makes later re-cuts reproducible.
- **You watch the three files** and give notes. Captions, cut order and pacing are all in `cuts.mjs`, so a note is usually a one-line change and a re-render.

**Render time estimate:**
- headed on this machine's GPU: about 18k frames at 60–120 ms each, so 20–40 min for the YouTube cut;
- headless SwiftShader: several times slower, but it works.

## 6. Milestones (in order; each one leaves a working build)

1. **M1, p3p2 button:** §3, plus the screenshot and bounding-box checks. `npm test`, `npm run playtest` and `playtest:room` pass.
2. **M2, the table:** line, rotation, skip, `TABLE_VERSION` 2, and the unit tests.
3. **M3, the room UI:** the question, the line in the menu and on the plates, rotation and countdown at game over, skip/replace, the toasts, and `play-room.mjs` with four people (plus `--lag`).
4. **M4, film spike** (decides §7's first risk): a 10 s reel through virtual time, CDP and ffmpeg. Check that rAF frames, CSS transitions, the shatter gate and the screenshots all line up.
5. **M5, the human driver:** `human.mjs`, with `play-ui.mjs` moved onto it (all scenarios still pass), plus the cursor and finger overlay.
6. **M6, sound:** the injectable `Synth`, the event log, offline render, and the mix with loudness normalised.
7. **M7, reels:** intro, opera, vs-ai, rewind, promotion, devices, friends, outro, with their captions.
8. **M8, cuts:** YouTube, Short and X, plus thumbnails, `description.md`, `.srt`, and the §5.5 checks.
9. **M9, docs:** README (the p3p2 button, taking turns, `npm run film`) and `ai/next_2.md` with the numbers and links to the outputs.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Playwright's clock and WebGL frames don't line up for screenshots, or Playwright's own screenshot waits on a faked rAF | Capture with raw CDP `Page.captureScreenshot`, not `page.screenshot`. **Fallback:** chrome-headless-shell with `--deterministic-mode` and `HeadlessExperimental.beginFrame`, which steps the whole compositor. It's slower (SwiftShader) but exact. M4 decides |
| CSS transitions (toasts, banners, menus) run on real time, not the faked clock | Pause and seek every `Animation` each frame, including inside open shadow roots (the p3p2 button's pulse) |
| An animation gate times out in virtual time while the fracture worker runs in real time, so a capture plays without shards | Virtual time stops while `waiting()` is true. The contact-sheet check looks for the fallback |
| A multiplayer reel can't run on a virtual clock: p3p2 heartbeats and the server's 3 s "lost" timer are real time | Record `friends` in real time, headed on the GPU. A slight judder in that segment is acceptable |
| The video credits the adaptive AI with Morphy's moves | The caption says it's a replay. The adaptive AI gets its own unscripted reel |
| A skip button removes someone who was only slow | It needs a timeout and somebody waiting. During a game it also needs `lost` or gone. The skipped player gets a toast and can get back in line with one tap |
| A stale v1 tab in a v2 room | `game.version` changes, so p3p2 keeps it out by the room's rule until it reloads |
| A loser who storms off holds up the line | The countdown starts the next game anyway. If they're at the front again later and absent, the skip path covers it |
| The p3p2 button covers something on an odd screen | Bounding-box asserts on four devices, in and out of a room |

## 8. Not in this plan

- Uploading the videos, or a voice-over.
- Changes to p3p2 (§4.6 lists the suggestions).
- A per-room setting for the turn rule. It's one rule for now (§9.3).
- The GitHub corner over ⏪ on phone overlays (next_1, item 3). It's unrelated to the bottom-right corner moved here, but it's a five-minute fix if you want it included.

## 9. Assumptions and open questions (the defaults are what the plan uses)

1. **⌖ goes above the p3p2 button** (right-hand column, under the thumb). The alternative is bottom left, above the version.
2. **The menu's "Play with a friend" uses the p3p2 mark** instead of 👥.
3. **Turn rule:** winner stays, loser to the back of the line, and the longer-seated player goes after a draw. **No cap** on how long a winner stays. A cap (say, 3 wins and then the winner goes too) is one more field in `stay`, if a strong friend never leaves the table.
4. **The loser goes back in line automatically**, with "Just watch instead". The alternative is asking them like a newcomer.
5. **The next game starts on its own 15 s after the end** when someone is waiting. With nobody waiting, it waits for "Rematch" as today.
6. **Absence timeouts:** 60 s before the first move, 120 s during a game.
7. **Videos:**
   - no voice-over, with captions burned in plus an `.srt`;
   - game sounds only, unless you pass a licensed `--music` track;
   - High graphics, except in the `devices` reel, which shows each tier labelled. The Short uses the phone layout at High; a real entry-level phone would pick Low.
8. **The game's public URL for the end card:** I don't know it (`wrangler.jsonc` names the worker `chess`). Until you say, it's a `--url-label` argument.
9. **Showcase game:** the Opera Game. It's in the public domain, short, and has castling, sacrifices and a clean mate. Any other PGN can go in `cuts.mjs`.
