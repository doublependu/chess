// Deterministic GPU particles: positions are an analytic function of (seed, time), so effects
// can be scrubbed forwards and backwards like every other clip.
import {
  BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial, AdditiveBlending, NormalBlending, Color,
  Mesh, RingGeometry, MeshBasicMaterial, InstancedBufferGeometry, InstancedBufferAttribute, PlaneGeometry, DoubleSide,
} from 'three';
import { WARP_GLSL, globalUniforms } from '../materials.js';

function mulberry32(a) {
  a >>>= 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export let pixelScale = { value: 600 };

/**
 * A burst of particles from `origin`.
 * opts: count, seed, speed, up, spread (0..1 horizontal), dir [x,y,z] (bias), gravity, life, size, color, additive, delay
 */
export class Burst {
  constructor(opts) {
    const o = { count: 24, seed: 1, speed: 2, up: 1.5, spread: 1, dir: [0, 0, 0], gravity: -6, life: 0.8, size: 0.12, color: '#ffffff', additive: false, delay: 0, drag: 1.5, ...opts };
    const rnd = mulberry32(o.seed);
    const n = Math.max(1, Math.round(o.count));
    const vel = new Float32Array(n * 3), life = new Float32Array(n), size = new Float32Array(n), delay = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * o.spread;
      const sp = o.speed * (0.4 + rnd() * 0.8);
      vel[i * 3] = Math.cos(a) * r * sp + o.dir[0] * sp;
      vel[i * 3 + 1] = o.up * (0.4 + rnd() * 0.9) + o.dir[1] * sp;
      vel[i * 3 + 2] = Math.sin(a) * r * sp + o.dir[2] * sp;
      life[i] = o.life * (0.6 + rnd() * 0.6);
      size[i] = o.size * (0.6 + rnd() * 0.8);
      delay[i] = o.delay * rnd();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aVel', new Float32BufferAttribute(vel, 3));
    geo.setAttribute('aLife', new Float32BufferAttribute(life, 1));
    geo.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    geo.setAttribute('aDelay', new Float32BufferAttribute(delay, 1));
    this.material = new ShaderMaterial({
      transparent: true, depthWrite: false, blending: o.additive ? AdditiveBlending : NormalBlending,
      uniforms: {
        uT: { value: -1 }, uOrigin: { value: o.origin.clone() }, uG: { value: o.gravity }, uDrag: { value: o.drag },
        uColor: { value: new Color(o.color) }, uScale: pixelScale, uTimeWarp: globalUniforms.uTimeWarp,
      },
      vertexShader: /* glsl */`
        uniform float uT, uG, uScale, uDrag; uniform vec3 uOrigin;
        attribute vec3 aVel; attribute float aLife, aSize, aDelay;
        varying float vA;
        void main() {
          float age = uT - aDelay;
          if (age < 0.0 || age > aLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
          // velocity with exponential drag, integrated analytically
          float k = (1.0 - exp(-uDrag * age)) / uDrag;
          vec3 p = uOrigin + aVel * k + vec3(0.0, 0.5 * uG * age * age, 0.0);
          p.y = max(p.y, 0.02);
          float x = age / aLife;
          vA = (1.0 - x) * (1.0 - x);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * aSize * (0.6 + x * 0.8) / -mv.z;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying float vA; ${WARP_GLSL.decl}
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(uColor, vA * smoothstep(0.5, 0.15, d));
          #include <colorspace_fragment>
        ${WARP_GLSL.apply}
        }`,
    });
    this.object = new Points(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
    this.duration = o.life * 1.2 + o.delay;
  }

  setTime(t) { this.material.uniforms.uT.value = t; this.object.visible = t >= 0 && t <= this.duration; }

  dispose() { this.object.geometry.dispose(); this.material.dispose(); this.object.removeFromParent(); }
}

/** Expanding ring on the board at an impact. */
export class Shockwave {
  constructor(origin, color = '#fff1c9', maxRadius = 2.2, life = 0.5) {
    this.material = new MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: DoubleSide });
    this.object = new Mesh(new RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), this.material);
    this.object.position.copy(origin).setY(0.03);
    this.object.renderOrder = 4;
    this.max = maxRadius; this.life = life;
  }
  setTime(t) {
    const x = t / this.life;
    this.object.visible = x >= 0 && x <= 1;
    if (!this.object.visible) return;
    this.object.scale.setScalar(0.2 + this.max * (1 - (1 - x) * (1 - x)));
    this.material.opacity = (1 - x) * 0.85;
  }
  dispose() { this.object.geometry.dispose(); this.material.dispose(); this.object.removeFromParent(); }
}

/** Wind streaks racing across the arena during a gust (instanced quads, analytic motion). */
export class Streaks {
  constructor({ count = 40, seed = 1, dir = [1, 0, 0], start = 0.5, span = 2.4, speed = 22 }) {
    const rnd = mulberry32(seed);
    const n = Math.max(1, Math.round(count));
    const base = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    const off = new Float32Array(n * 3), del = new Float32Array(n), len = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // start upwind of the board
      const side = (rnd() * 2 - 1) * 9, back = 12 + rnd() * 6;
      off[i * 3] = -dir[0] * back + -dir[2] * side;
      off[i * 3 + 1] = 0.2 + rnd() * 2.6;
      off[i * 3 + 2] = -dir[2] * back + dir[0] * side;
      del[i] = start + rnd() * span;
      len[i] = 0.8 + rnd() * 1.6;
    }
    geo.setAttribute('aOff', new InstancedBufferAttribute(off, 3));
    geo.setAttribute('aDelay', new InstancedBufferAttribute(del, 1));
    geo.setAttribute('aLen', new InstancedBufferAttribute(len, 1));
    geo.instanceCount = n;
    this.material = new ShaderMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
      uniforms: { uT: { value: -1 }, uDir: { value: dir }, uSpeed: { value: speed }, uTimeWarp: globalUniforms.uTimeWarp },
      vertexShader: /* glsl */`
        uniform float uT, uSpeed; uniform float uDir[3];
        attribute vec3 aOff; attribute float aDelay, aLen;
        varying float vA; varying vec2 vUv;
        void main() {
          vec3 d = normalize(vec3(uDir[0], 0.0, uDir[2]));
          float age = uT - aDelay;
          vUv = uv;
          if (age < 0.0 || age > 1.6) { gl_Position = vec4(2.0); vA = 0.0; return; }
          vec3 c = aOff + d * age * uSpeed + vec3(0.0, sin(age * 6.0 + aDelay * 9.0) * 0.15, 0.0);
          vec3 side = normalize(cross(d, cameraPosition - c));
          vec3 p = c + d * position.x * aLen + side * position.y * 0.035;
          vA = sin(age / 1.6 * 3.14159) * 0.55;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying float vA; varying vec2 vUv; ${WARP_GLSL.decl}
        void main() {
          float a = vA * smoothstep(0.0, 0.5, vUv.x) * smoothstep(1.0, 0.6, vUv.x);
          gl_FragColor = vec4(1.0, 0.97, 0.9, a);
          #include <colorspace_fragment>
        ${WARP_GLSL.apply}
        }`,
    });
    this.object = new Mesh(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 6;
    this.end = start + span + 1.7;
  }
  setTime(t) { this.material.uniforms.uT.value = t; this.object.visible = t >= 0 && t <= this.end; }
  dispose() { this.object.geometry.dispose(); this.material.dispose(); this.object.removeFromParent(); }
}
