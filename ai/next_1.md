# Next 1: implementation summary and what to work on next

Answers `prompt_1.md` and follows `plan_1.md`. Nothing is committed.

## What was built

| Area | Where | Notes |
|---|---|---|
| Outline width | `src/render/materials.js`, `Stage.applyPixelRatio` | The hull is never thinner than 1.5 render px without MSAA (1 px with MSAA): `max(world 0.016, px × depth)` |
| Idle animation setting | `idleMotion()` in `src/render/quality.js`, `Stage.updateIdle`, Settings | Auto / Full / Calm / Off. Auto picks Calm on phones, on Low, or with reduced motion |
| Outline probe | `src/debug/outlineProbe.js` (lazy), `__test.outlineStats`, `__test.holdClock` | `outline` scenario in `play-ui.mjs` |
| Multiplayer | `src/net/{table,company}.js`, controller, ui, main | Ported from the p3p2 test fork, using `@p3p2/client` ^0.1.1 from npm. Vite `optimizeDeps.exclude` added |
| Links | `index.html`, `src/ui/ui.js` | Maize.Live on the loading, pause and in-room menus. "Need a room? … p3p2.me" under each 👥 button |
| Room playtest | `playtest/play-room.mjs` (`npm run playtest:room`) | Starts a server from `../p3p2` in memory. `--lag` goes through p3p2's lag proxy |

## Measured

- **Outline on a Pixel 5, Low:**
  - worst-piece coverage went from 0.55 to 0.99 (0.19 to 0.98 at 0.6 resolution);
  - width went from 0.61 px to 1.63 px;
  - flicker went from 0.027 to 0.001 per frame.
  - Desktop 1366×768 is unchanged, because its outline was already over 1 px.
- **Unit tests:** 78 pass (67 before).
- **Critical path:** 190.8 KB gzip (183 before). The p3p2 core, panel and QR code (about 16 KB gzip) load lazily.
- **TTI:** 1.10 / 2.05 / 2.70 s. Untouched HEAD on this machine measured 1.05 / 2.07 / 2.71 s, so the rise from next_0's numbers comes from the environment (new headless Chromium), not this change. `perf:load` now also checks that a plain visit contacts no other server; it passes.
- **Playtests:** `npm run playtest` passes every scenario. `playtest:room` passes, and three more runs with `--lag` all pass.

## Found and fixed

- **The outline was thinner than a pixel on phones**, so it drew as broken dashes that crawled with the idle motion.
- **An op in flight when the connection drops is lost.** p3p2's `submit()` sends it once, with no acknowledgement.
  - Moves are now resent at 4, 8 and 12 s. The table takes each ply once, so a late duplicate changes nothing. After 16 s the player gets the move back, with a toast.
  - A lost draw acceptance can now be given again from ☰ ("Accept the draw"), and the plate shows "Offers a draw".
  - **Worth fixing in p3p2 itself** (ack and resend in `client/src/room.ts`).
- **Tried and reverted:** a polygon offset on the hull. It hid the outline along the pieces' bases.

- **`playtest/lib.mjs` `startServer()` left `vite preview` running after a run.** It stopped only `npx`, not vite. Later runs then reused the leftover server; it served the current `dist/`, so their results still hold. It now runs in its own process group and is stopped as a whole.

## Checked by eye (screenshots, Pixel 5 and desktop)

- The title and pause menus show "Need a room? Make one free at p3p2.me ↗" under 👥.
- The pause fine print shows "Fork me on GitHub · More games on Maize.Live".
- Settings shows "Idle animation (auto picked: calm)" on the phone.
- On the phone's pause screen, the GitHub corner covers part of the ⏪ button in the HUD. That was already the case before this work.

## Not done

- No look on a real phone yet.

## Next

1. Look at the outline and Calm idle on a real phone. Tune `uMinPx` (1.0–1.5) if the outline looks heavy.
2. Fix the in-flight op loss in the p3p2 client.
3. Move the GitHub corner on phone overlays so it doesn't cover the HUD's ⏪ button.
4. The knight's inner dotted contour (where the head meets the base) predates this work.
