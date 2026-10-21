// Boot order: probe device → renderer + scene → UI → first frame (time to interactive) → deferred work.
import { probeDevice, chooseTier, stepTier, idleMotion, TIERS } from './render/quality.js';
import { Stage } from './render/stage.js';
import { DestructionManager } from './destruction/manager.js';
import { AIClient } from './ai/client.js';
import { Synth } from './audio/synth.js';
import { UI } from './ui/ui.js';
import { Controller } from './game/controller.js';
import { attachInput } from './game/input.js';
import { loadSettings, saveSettings, loadAutosave, loadSlots } from './save/slots.js';
import { installTestHooks } from './debug/testHooks.js';
import { openCompany } from './net/company.js';

const audio = new Synth();
const ui = new UI({ audio });

async function boot() {
  ui.progress(12, 'Checking your device…');
  const info = probeDevice();
  if (!info.webgl2) {
    ui.fatal('<h2>WebGL 2 is not available</h2><p>This game needs a browser with WebGL 2 (any up-to-date Chrome, Edge, Firefox or Safari). Hardware acceleration may be turned off.</p>');
    return;
  }
  const settings = loadSettings();
  const autoTier = chooseTier(info);
  const params = new URLSearchParams(location.search);
  const forced = params.get('quality');
  let tierName = forced && TIERS[forced] ? forced : settings.graphics === 'auto' ? autoTier : settings.graphics;
  audio.setVolume(settings.volume);
  audio.setMuted(!settings.sound);

  ui.progress(35, 'Raising the sky arena…');
  await nextFrame();
  const canvas = document.getElementById('gl');
  const stage = new Stage(canvas, { tierName, info, settings });
  stage.destruction = new DestructionManager();
  const ai = new AIClient();

  const ctrl = new Controller({ stage, ui, ai, audio, settings });
  stage.computeInsets = () => computeInsets(stage);
  stage.onRebuilt = () => ctrl.updateHighlights();

  ui.progress(70, 'Carving the pieces…');
  await nextFrame();
  try { await stage.renderer.compileAsync(stage.scene, stage.rig.camera); } catch { /* older three/drivers */ }
  ui.progress(92, 'Almost there…');

  stage.rig.intro = 1;
  stage.start();
  stage.listeners.add((dt) => { if (stage.rig.intro > 0) stage.rig.intro = Math.max(0, stage.rig.intro - dt / 2.4); });
  await nextFrame();
  await nextFrame();
  performance.mark('tti');
  window.__tti = performance.now() - (window.__t0 || 0);
  ui.progress(100, '');
  ui.hideLoading();
  attachInput(canvas, stage, ctrl, ui);
  showTitle(ctrl);

  // ---- UI actions ----
  ui.on('newGame', (c) => { audio.ensure(); ctrl.newGame(c); });
  ui.on('continue', () => { audio.ensure(); const s = loadAutosave(); if (s) ctrl.restore(s); });
  ui.on('pause', () => ctrl.pause());
  ui.on('resume', () => ctrl.resume());
  ui.on('save', () => ctrl.openSave());
  ui.on('load', () => ctrl.openLoad());
  ui.on('resetView', () => { stage.rig.resetView(); stage.rig.refit(); });
  ui.on('newGameMenu', () => ui.showNewGame());
  ui.on('resign', async () => { if (await ui.confirm('Resign this game?', 'Resign')) ctrl.resign(); });
  ui.on('rematch', () => ctrl.newGame(ctrl.humanColor));
  ui.on('switchSides', () => ctrl.newGame(ctrl.humanColor ^ 1));
  ui.on('san', (t) => ctrl.onSan(t));
  ui.on('settings', () => openSettings());
  ui.on('people', () => { ui.close('pause'); ctrl.resume(); company.open(); });
  ui.setSanInput(settings.showSanInput);

  function openSettings() {
    ui.showSettings(settings, {
      autoTier, tier: stage.tierName, gpu: info.gpu.slice(0, 60), fps: Math.round(1000 / stage.governor.ema),
      pixelRatio: (stage.pixelRatio || 1).toFixed(2),
      idleAuto: idleMotion('auto', { coarse: info.coarse, tier: stage.tierName, reducedMotion: settings.reducedMotion }),
    }, (key, value) => {
      settings[key] = value;
      saveSettings(settings);
      if (key === 'graphics') {
        stage.setTier(value === 'auto' ? autoTier : value);
        ui.toast(`Graphics: ${stage.tierName}`);
      } else if (key === 'sound') { audio.setMuted(!value); if (value) audio.ensure(); }
      else if (key === 'reducedMotion') stage.rig.reducedMotion = value;
      else if (key === 'showMoves') ctrl.updateHighlights();
      else if (key === 'showSanInput') ui.setSanInput(value);
    });
  }

  // ---- quality governor ----
  stage.onTierDrop = (why) => {
    if (settings.graphics !== 'auto' || stage.tierName === 'low') return;
    const next = stepTier(stage.tierName, -1);
    stage.setTier(next);
    ui.toast(`Graphics lowered to ${next} to keep things smooth — change it in Settings.`, 4000);
    ctrl.log('tierDrop', { why, to: next });
  };
  stage.onContextLost = () => ui.toast('Graphics were reset by the browser — restoring…');

  document.addEventListener('visibilitychange', () => {
    // In a room there is no AI to hold back, and the menu would only be in the way on coming back.
    if (document.hidden && !ctrl.room && ctrl.phase !== 'title' && !ctrl.paused && ctrl.phase !== 'over') ctrl.pause();
  });
  window.addEventListener('resize', () => stage.refreshInsets());

  // ---- deferred work (after the game is already interactive) ----
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(() => stage.destruction.start({ physics: !info.saveData }), { timeout: 1500 });
  idle(() => stage.warmup(), { timeout: 2500 });

  installTestHooks({ stage, ctrl, ui, info, settings });

  // ---- friends: a room on a p3p2 server (see net/company.js) ----
  const company = openCompany(ctrl, ui);
  ctrl.onLeftRoom = () => showTitle(ctrl);
}

function showTitle(ctrl) {
  ctrl.ui.showHud(false);
  ctrl.ui.showTitle({
    hasAutosave: !!loadAutosave(),
    hasSlots: loadSlots().some(Boolean),
    rating: ctrl.player.games ? ctrl.player.rating : null,
  });
}

/** Screen areas covered by HUD elements, so the camera can fit the board in the free space. */
function computeInsets(stage) {
  const W = stage.width, H = stage.height;
  const ins = { top: 8, right: 8, bottom: 8, left: 8 };
  const hud = document.getElementById('hud');
  if (hud.hidden) return ins;
  const portrait = H > W * 1.05;
  for (const id of ['p-ai', 'p-you', 'btn-menu', 'hud-actions-top', 'hud-actions']) {
    const el = document.getElementById(id);
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (portrait) {
      if (r.bottom < H * 0.4) ins.top = Math.max(ins.top, r.bottom + 4);
      else if (r.top > H * 0.6) ins.bottom = Math.max(ins.bottom, H - r.top + 4);
    } else if (r.right < W * 0.35 && r.height < H * 0.7) {
      ins.left = Math.max(ins.left, Math.min(r.right + 6, W * 0.3));
    }
  }
  if (!portrait) { ins.left = Math.min(ins.left, W * 0.28); ins.right = Math.max(ins.right, 60); ins.top = 10; ins.bottom = 10; }
  return ins;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

boot().catch((e) => {
  console.error(e);
  ui.fatal(`<h2>Something went wrong</h2><p>${String(e?.message || e)}</p><p><a href="">Reload</a></p>`);
});
