import { PerspectiveCamera, Vector3, MathUtils } from 'three';

const DEG = Math.PI / 180;
const FIT_POINTS = [];
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  FIT_POINTS.push(new Vector3(sx * 4.7, 0, sz * 4.7));
  FIT_POINTS.push(new Vector3(sx * 3.9, 1.25, sz * 3.9));
}

/**
 * Perspective camera that always fits the board inside the free screen area (between HUD
 * elements) for any aspect ratio, plus limited player orbit/zoom and shake.
 */
export class CameraRig {
  constructor() {
    this.camera = new PerspectiveCamera(38, 1, 0.1, 900);
    this.target = new Vector3(0, 0.25, 0);
    this.sideYaw = 0; // 0 = White's view (camera on +z), PI = Black's view
    this.userYaw = 0; // player orbit offset
    this.userPitch = 0;
    this.zoom = 1;
    this.basePitch = 55 * DEG;
    this.fitDistance = 16;
    // Smoothed state
    this.yaw = 0; this.pitch = this.basePitch; this.distance = 16;
    this.shake = 0;
    this.width = 1; this.height = 1;
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.intro = 0; // 1 → 0: cinematic fly-in progress
    this.reducedMotion = false;
  }

  get portrait() { return this.height > this.width * 1.05; }

  setSize(w, h, insets = this.insets) {
    this.width = Math.max(1, w); this.height = Math.max(1, h);
    this.insets = insets;
    this.camera.aspect = this.width / this.height;
    this.basePitch = (this.portrait ? 63 : 52) * DEG;
    this.refit();
  }

  setSide(color, instant = false) {
    this.sideYaw = color === 1 ? Math.PI : 0;
    if (instant) this.yaw = this.sideYaw + this.userYaw;
  }

  orbitBy(dx, dy) {
    this.userYaw = MathUtils.clamp(this.userYaw - dx * 0.006, -40 * DEG, 40 * DEG);
    this.userPitch = MathUtils.clamp(this.userPitch + dy * 0.005, 28 * DEG - this.basePitch, 82 * DEG - this.basePitch);
  }

  zoomBy(f) { this.zoom = MathUtils.clamp(this.zoom * f, 0.62, 1.5); }

  resetView() { this.userYaw = 0; this.userPitch = 0; this.zoom = 1; }

  // Binary search the distance at which all fit points project inside the free area.
  refit() {
    const { width: W, height: H, insets } = this;
    const hx = Math.max(0.2, (W - insets.left - insets.right) / W) * 0.96;
    const hy = Math.max(0.2, (H - insets.top - insets.bottom) / H) * 0.96;
    const yaw = this.sideYaw + this.userYaw;
    const pitch = this.basePitch + this.userPitch;
    const cam = this.camera;
    cam.clearViewOffset();
    let lo = 4, hi = 120;
    const p = new Vector3();
    for (let i = 0; i < 22; i++) {
      const d = (lo + hi) / 2;
      this.place(cam, yaw, pitch, d);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      let fits = true;
      for (const v of FIT_POINTS) {
        p.copy(v).project(cam);
        if (Math.abs(p.x) > hx || Math.abs(p.y) > hy || p.z > 1) { fits = false; break; }
      }
      if (fits) hi = d; else lo = d;
    }
    this.fitDistance = hi;
    // Shift the image so the board is centred in the free area, not the whole screen.
    const dx = (insets.left - insets.right) / 2;
    const dy = (insets.top - insets.bottom) / 2;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) cam.setViewOffset(W, H, -dx, -dy, W, H);
    cam.updateProjectionMatrix();
  }

  place(cam, yaw, pitch, dist) {
    const t = this.target;
    cam.position.set(
      t.x + Math.sin(yaw) * Math.cos(pitch) * dist,
      t.y + Math.sin(pitch) * dist,
      t.z + Math.cos(yaw) * Math.cos(pitch) * dist,
    );
    cam.lookAt(t);
  }

  update(dt, time) {
    const k = 1 - Math.exp(-dt * 6);
    const goalYaw = this.sideYaw + this.userYaw;
    // shortest angle
    let dyaw = goalYaw - this.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yaw += dyaw * k;
    this.pitch += (this.basePitch + this.userPitch - this.pitch) * k;
    this.distance += (this.fitDistance * this.zoom - this.distance) * k;
    let yaw = this.yaw, pitch = this.pitch, dist = this.distance;
    if (!this.reducedMotion) dist *= 1 - Math.min(1, this.shake) * 0.045; // punch-in on impacts
    if (this.intro > 0) {
      const e = this.intro * this.intro * (3 - 2 * this.intro);
      yaw += e * 1.1; pitch += e * 0.18; dist *= 1 + e * 1.4;
    }
    this.place(this.camera, yaw, pitch, dist);
    if (this.shake > 0.001 && !this.reducedMotion) {
      const s = this.shake * 0.09;
      this.camera.position.x += Math.sin(time * 71.3) * s;
      this.camera.position.y += Math.sin(time * 53.1 + 1.3) * s;
      this.camera.position.z += Math.sin(time * 61.7 + 2.1) * s * 0.6;
    }
    this.camera.updateMatrixWorld();
  }
}
