// Pointer input on the canvas: tap-tap or drag-and-drop to move, drag on empty space to orbit,
// pinch / wheel to zoom the in-game camera (never the page).
const TAP_SLOP = 9;

export function attachInput(canvas, stage, ctrl, ui) {
  const pointers = new Map();
  let gesture = null; // {kind: 'pending'|'drag'|'orbit'|'pinch', ...}

  const setInteracting = (v) => { stage.interacting = v; };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus({ preventScroll: true });
    ctrl.audio.ensure?.();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      cancelDrag();
      gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) };
      setInteracting(true);
      return;
    }
    if (pointers.size > 2) return;
    const square = stage.pickSquare(e.clientX, e.clientY);
    const piece = square ? ctrl.game.pieceAt(square) : null;
    const own = piece && piece.color === ctrl.humanColor && ctrl.canInteract;
    gesture = {
      kind: 'pending', id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      t0: performance.now(), square, own, button: e.button, floor: stage.pickSquareOnBoard(e.clientX, e.clientY),
    };
    if (e.button === 2 || e.button === 1) gesture.kind = 'orbit';
    setInteracting(true);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (!gesture) return;
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.dist > 0) stage.rig.zoomBy(gesture.dist / d);
      gesture.dist = d;
      return;
    }
    if (e.pointerId !== gesture.id) return;
    gesture.x = e.clientX; gesture.y = e.clientY;
    const moved = Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0);
    if (gesture.kind === 'pending' && moved > TAP_SLOP) {
      if (gesture.own) {
        gesture.kind = 'drag';
        ctrl.select(gesture.square);
        gesture.view = stage.views.at(gesture.square);
      } else {
        gesture.kind = 'orbit';
      }
    }
    if (gesture.kind === 'orbit') {
      stage.rig.orbitBy(dx, dy);
      stage.rig.refit();
    } else if (gesture.kind === 'drag' && gesture.view) {
      const pt = stage.boardPoint(e.clientX, e.clientY, 0.35);
      if (pt) {
        const v = gesture.view;
        v.root.position.set(Math.max(-4.4, Math.min(4.4, pt.x)), 0, Math.max(-4.4, Math.min(4.4, pt.z)));
        v.body.position.y = 0.25;
      }
    }
  });

  function cancelDrag() {
    if (gesture?.kind === 'drag' && gesture.view) {
      gesture.view.placeAt(gesture.view.square);
    }
  }

  const end = (e) => {
    const had = pointers.delete(e.pointerId);
    if (!had) return;
    if (!gesture) { if (!pointers.size) setInteracting(false); return; }
    if (gesture.kind === 'pinch') {
      if (pointers.size === 0) { gesture = null; setInteracting(false); }
      return;
    }
    if (e.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    setInteracting(pointers.size > 0);
    if (e.type === 'pointercancel') { cancelDrag.call(null); return; }
    if (g.kind === 'pending') {
      ctrl.onSquareTap(g.square, g.floor);
    } else if (g.kind === 'drag') {
      const target = stage.pickSquareOnBoard(e.clientX, e.clientY);
      if (g.view) g.view.placeAt(g.view.square);
      if (target && target !== g.square && ctrl.legalFrom.has(target)) ctrl.tryMove(g.square, target);
      else if (target !== g.square) ctrl.rejectMove();
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    stage.rig.zoomBy(Math.exp(e.deltaY * 0.0012));
    stage.requestRender();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      if (ui.top === 'pause') ctrl.resume();
      else if (ui.open && ui.top !== 'title' && ui.top !== 'over') ui.close(ui.top);
      else if (!ui.open) ctrl.pause();
    } else if (e.key === '/' && ctrl.settings.showSanInput) {
      e.preventDefault();
      ui.focusSan();
    }
  });
}
