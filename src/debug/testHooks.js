// Read-only probes for automated playtests (Playwright). Moves must still go through the UI;
// these only report state and screen coordinates. Enabled in dev builds or with ?test=1.
export function installTestHooks({ stage, ctrl, ui, info, settings }) {
  const enabled = import.meta.env.DEV || new URLSearchParams(location.search).has('test');
  if (!enabled) return;
  window.__test = {
    version: __APP_VERSION__,
    tti: () => window.__tti,
    info: () => ({ ...info, tier: stage.tierName, pixelRatio: stage.pixelRatio, bench: stage.governor.benchResult || null, emaMs: stage.governor.ema }),
    state: () => ctrl.state(),
    legal: () => ctrl.game.legalUcis(),
    squareToScreen: (sq, y = null) => stage.squareToScreen(sq, y),
    canvasSize: () => ({ css: [stage.canvas.clientWidth, stage.canvas.clientHeight], px: [stage.canvas.width, stage.canvas.height], dpr: window.devicePixelRatio, pixelRatio: stage.pixelRatio }),
    checkScene: () => ctrl.checkScene(),
    events: () => ctrl.events.slice(),
    overlay: () => ui.top || null,
    settings: () => ({ ...settings }),
    frameStats: () => ({ ema: stage.governor.ema, scale: stage.governor.scale, cpuUpdate: stage.cpuUpdate, cpuRender: stage.cpuRender }),
    lastDestruction: () => stage.lastDestruction || null,
    renderInfo: () => ({ ...stage.renderer.info.render, ...stage.renderer.info.memory, programs: stage.renderer.info.programs?.length }),
    setTier: (t) => stage.setTier(t),
    slowFrames: () => (stage.slowLog ||= []),
    // GPU time (ms) of one full render, via EXT_disjoint_timer_query_webgl2 when available.
    gpuTime: async (samples = 20) => {
      const gl = stage.renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return null;
      const res = [];
      for (let i = 0; i < samples; i++) {
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        stage.renderer.render(stage.scene, stage.rig.camera);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        await new Promise((r) => setTimeout(r, 40));
        for (let k = 0; k < 20 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((r) => setTimeout(r, 10));
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) res.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
      res.sort((a, b) => a - b);
      return res.length ? res[Math.floor(res.length / 2)] : null;
    },
    toggle: (name, v) => {
      const env = stage.env;
      const map = { grass: env.group.children.find((o) => o.isInstancedMesh), sea: env.group.children[1], shadows: null };
      if (name === 'shadows') { stage.renderer.shadowMap.enabled = v; stage.scene.traverse((o) => { if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); } }); return; }
      if (map[name]) map[name].visible = v;
    },
    // Waits until no blocking animation is running and it's a stable phase.
    idle: () => new Promise((resolve) => {
      const check = () => {
        const s = ctrl.state();
        const rig = stage.rig;
        const settled = rig.intro === 0 && Math.abs(rig.distance - rig.fitDistance * rig.zoom) < 0.05;
        if (settled && !s.busy && s.phase !== 'animating' && s.phase !== 'rewinding' && s.phase !== 'ai') resolve(s);
        else setTimeout(check, 50);
      };
      check();
    }),
    loseContext: () => {
      const ext = stage.renderer.getContext().getExtension('WEBGL_lose_context');
      ext?.loseContext();
      setTimeout(() => ext?.restoreContext(), 500);
    },
  };
}
