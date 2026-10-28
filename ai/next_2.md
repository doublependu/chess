# Next 2: implementation summary and what to work on next

Answers `prompt_2.md` and follows `plan_2.md`. Nothing is committed.

## What was built

| Area | Where | Notes |
|---|---|---|
| p3p2's own button | `src/net/company.js`, `index.html`, `src/ui/ui.js` | <ul><li>`ui: { corner: 'bottom-right' }`: the room's head count, unread chat and the live mark are on it now.</li><li>Our 👥 HUD button is gone, and ⌖ sits above the p3p2 button.</li><li>A CSS rule keeps the button clear of notches and the home bar.</li><li>"Play with a friend" stays in the title and pause menus, now shows the p3p2 mark (MIT notice beside it), and opens the same panel.</li></ul> |
| Taking turns | `src/net/table.js` (`TABLE_VERSION` 2) | <ul><li>New ops `line`, `unline` and `skip`. A free seat goes to the first in line straight away.</li><li>In `new`, the loser goes to the back of the line and the first in line sits down. After a draw, whoever has sat longer goes (`since`); if they sat down together, the one who had white.</li><li>With nobody waiting, behaviour is exactly v1's. v1 snapshots and logs load and replay as before.</li></ul> |
| Room UI | `src/net/company.js`, `src/game/controller.js`, `src/ui/ui.js`, `index.html` | <ul><li>"Both seats are taken: Do you want to play or just keep watching?" Just watch is remembered for the tab, so a reload doesn't ask again.</li><li>☰ gets "Get in line", "Leave the line", the line itself, and "Skip / Replace X" after 60 s (before the first move) or 120 s (in a game begun) of not being here.</li><li>Game over: "Next game: Ada vs Lin. Grace goes to the back of the line." with a 15 s countdown, "Start now" (players and the first in line) and "Just watch instead" (the one leaving; it's a `stand`).</li><li>A note bottom left ("Watching · #2 in line", "Next: Lin").</li><li>`line`, `unline` and `skip` are resent until they're seen.</li></ul> |
| Human driver | `playtest/human.mjs` | <ul><li>Minimum-jerk pointer paths with an arc and an overshoot.</li><li>A look at another piece first, and now and then one picked up and put back.</li><li>Log-normal thinking time.</li><li>Real touch taps and drags over CDP.</li><li>Targets scrolled into view.</li><li>`fast` style for `play-ui.mjs`'s persona games, `cinematic` for the films.</li></ul> |
| Film | `playtest/film.mjs`, `playtest/film/{clock,kit,reels,encode}.mjs`, `playtest/film/overlay.js`, `src/debug/film.js` (lazy, `?test=1` only), `src/audio/synth.js` | See below. `npm run film` |
| Room helpers | `playtest/rooms.mjs` | p3p2 server start-up, the lag proxy and room creation, moved out of `play-room.mjs` and shared with the film |

### How the film works

- **Virtual time:**
  - Playwright's `page.clock` fakes timers, rAF and `performance.now`.
  - Each frame the script moves it one animation frame on (16 ms: Playwright fires rAF on a 16 ms grid) and sets every Web Animation (CSS transitions and animations, including p3p2's shadow root) to the same time.
  - It then captures over CDP with `clip.scale` = the device scale (without it CDP gives CSS pixels), into ffmpeg's stdin.
  - So **the film runs 4 % slower than the game**, evenly, and every frame is drawn on any machine.
- **Workers:** while the board holds a strike for the destruction worker (`__filmApp.waiting()`), real time passes but the film's doesn't.
- **Sound:**
  - Every sound the game asks for is logged with its film time.
  - The recorder notes which spans of film time made it into the video (reels have jump cuts).
  - `renderAudio` plays them through the same `Synth` into an `OfflineAudioContext`.
  - Loudness is set in two passes, to −16 LUFS (YouTube) or −15 (Short, X), with a limiter at −2 dBFS.
- **GPU:** headless Chromium on the real GPU: `--use-gl=angle --use-angle=gl-egl` (RTX 3060 here).
- **Live reel:** the room reel runs in real time, because p3p2's heartbeats and its server's timeouts are real time. It's captured with CDP's screencast (60 fps). The screencast only gives CSS pixels, so live pages are laid out at their recorded size: a 1280×1080 desktop, and a 480×810 phone scaled 1.33×.
- **Reels:**
  - cold open: knight takes queen, close up;
  - intro: a sweep from the island;
  - the Opera Game, all 17 moves: the AI is given Black's moves, and the caption says so;
  - close-up: the pieces idling;
  - rewind;
  - promotion;
  - an unscripted game against the adaptive AI, plus its level;
  - friends: Ada's desktop beside Lin's phone, live;
  - devices: Low / Medium / High phones side by side;
  - settings: Low ↔ High live;
  - the end card.

## Measured

| | Result |
|---|---|
| Unit tests | **88 pass** (78 before; 10 new table tests: the line, rotation, the draw rule, skip, v1 snapshots, duplicates, snapshot cuts) |
| `npm run playtest` | **All scenarios pass**, including the new `corners` one: the p3p2 button is on screen and clear of ⌖, the plates and the other controls on Pixel 5 portrait and landscape, iPhone 12 and desktop, and both ways in open the panel. Persona games now play through `Human` (fast style): 0 issues |
| `npm run playtest:room` | **30/30 checks with four people.** Plain and `--lag`: no issues, notes or page errors |
| Critical path | **194.2 KB gzip** (190.8 in next_1; budget 250). The film code is a lazy 1.2 KB chunk that only `?test=1` loads |
| TTI (`perf:load`) | 1.07 / 2.11 / 2.70 s (next_1: 1.10 / 2.05 / 2.70). The mid-mobile profile is over its 2.0 s warning line, as it was in next_1. A plain visit still talks to no other server |

### The videos (not committed; in `playtest-output/film-2026-10-27T22-45-50-800Z/upload/`)

All three are in one folder, with the YouTube subtitles and thumbnails and `posts.md`: titles, descriptions, chapters,
links and the X post, ready to paste. The end cards carry the game's address, ch0.maize.live (now `--url-label`'s
default).

| Cut | File | Size, length | Checks | Made in |
|---|---|---|---|---|
| YouTube | `youtube.mp4` | 1920×1080 60 fps, **4:28**, 309 MB | all ✓: H.264 High + AAC 48 kHz, −16.1 LUFS, peak −0.6 dBFS, no black stretch | 28 min |
| Short | `short.mp4` | 1080×1920 60 fps, **54.4 s**, 42 MB | all ✓, −15.1 LUFS | 6 min |
| X | `x.mp4` | 1080×1080 60 fps, **57.1 s**, 31 MB | all ✓, −15.1 LUFS | 4 min |

- **Frozen stretches:** the only "frozen over 3 s" in each cut is the end card, which is meant to hold still.
- **Next to the YouTube cut:** `youtube.srt` and two 1280×720 thumbnails (in `upload/` as `youtube-thumb-shatter.jpg` and `youtube-thumb-rewind.jpg`); contact sheets stay in `youtube/`.
- **What I checked by eye**, from contact sheets and single frames of every reel:
  - each capture shatters (not the gate-timeout fallback);
  - the cursor and finger match the moves;
  - captions stay inside the safe areas (a Short's clear of the bottom 24 % and right 15 %);
  - the rewind reads clearly;
  - the friends panes show the question, the line, "Start now" and the rotation.
- **Not checked:** I haven't listened to the sound, beyond its loudness numbers.

## Found and fixed on the way

- **Video was 1280×720 instead of 1920×1080.** CDP's `captureScreenshot` gives CSS pixels; it needs `clip.scale`.
- **Captions never went away.** A paused Web Animation never resolves `finished`, so the overlay finishes any animation that runs past its end.
- **The cold open's title came before the impact.** The fracture is ready before the strike lands, so the cold open waits for the `shatter` sound instead.
- **Odd frame height:** a 360×608 page at 16/9 is 640×1081, so the encoder crops to even sizes. An ffmpeg that dies now fails the reel instead of hanging it.
- **Seat race in the friends reel:** two pages joining together could both reach for white, so each now waits for its seat first.
- **The settings panel's Done was below the fold**, so the click hit the covered pause menu. `Human.click` now scrolls into view, and the reel closes settings by clicking beside the panel.
- **Subtitle and chapter details:**
  - subtitle cues overlapped at crossfades;
  - a caption's subtitle line ran into its main line;
  - a chapter shorter than 10 s hid the next one.
- **Game-over box:** a game resigned before its first move, with somebody waiting, would have shown a countdown to nothing.

## Deviations from plan_2

- **YouTube is 4:28, not ~5:00.** The full Opera Game, a close-up reel and a settings reel were added to reach that.
- **X has no adaptive-AI reel**, to stay under a minute. The end card says it instead.
- **No phone-rotation shot.** The devices reel is three portrait phones.
- **The loading screen isn't filmed**, because it loads before the film's clock can start. The intro's caption gives the load time.
- **"Just watch instead"** for the leaving player is a `stand`, not a new op: same effect, nothing to add to the table.
- **Absence counts any state but `here`** (so also `away`), after 60 s before the first move and 120 s during a game.

## Next

1. **Watch the three videos, and send notes.** Captions, order and pacing live in `playtest/film/reels.mjs` and `CUTS` in `playtest/film.mjs`; the post text in `playtest/film.mjs`. A licensed track if you want music (`--music`). A Short's description links can't be clicked, so its end card shows the address instead of "Link in the description".
2. **Real devices** (still open from next_0 and next_1): iPhone Safari and an entry Android, now including the p3p2 button's safe-area offset and the room note.
3. **For p3p2, upstream:**
   - safe-area insets on the corner button (then drop our CSS rule);
   - ack and resend for ops in flight;
   - a way for a game to tag members in the panel's list ("playing", "next").
4. **Turn rules:** if a strong player never leaves the table, consider a cap on wins in a row (one more field beside `since`).
5. **Smaller items:** the GitHub corner over ⏪ on phone overlays (next_1); a loading-screen shot through the live recorder; a rotation shot.
