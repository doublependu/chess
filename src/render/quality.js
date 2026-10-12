// Device probe, quality tiers, startup benchmark and the runtime governor
// (dynamic resolution first, tier drop as a last resort).

export const TIER_NAMES = ['low', 'medium', 'high'];

export const TIERS = {
  low: {
    name: 'low', pixelRatioMax: 1.0, pixelRatioMin: 0.6, msaa: false, shadows: 'blob', shadowMapSize: 0,
    post: false, fragments: 8, debrisLife: 2.6, particles: 0.3, segments: 16, fpsIdle: 30,
    grass: 0, clouds: 5, trees: 2, islands: 2, petals: 0, boardTex: 512,
  },
  medium: {
    name: 'medium', pixelRatioMax: 1.5, pixelRatioMin: 0.75, msaa: true, shadows: 'map', shadowMapSize: 1024,
    post: false, fragments: 14, debrisLife: 4, particles: 0.65, segments: 24, fpsIdle: 60,
    grass: 1400, clouds: 12, trees: 5, islands: 4, petals: 60, boardTex: 1024,
  },
  high: {
    name: 'high', pixelRatioMax: 2.0, pixelRatioMin: 1.0, msaa: true, shadows: 'soft', shadowMapSize: 2048,
    post: true, fragments: 20, debrisLife: 5, particles: 1, segments: 32, fpsIdle: 60,
    grass: 3600, clouds: 20, trees: 8, islands: 6, petals: 160, boardTex: 1024,
  },
};

const LOW_GPU = /(swiftshader|llvmpipe|softpipe|software|basic render|mali-(4|t|g31|g51|g52|g57)|adreno.{0,8}([2-5]\d\d|6[01]\d)\b|powervr|sgx|gma|intel.*hd graphics [2-5]\d\d\b|videocore)/i;
const HIGH_GPU = /(nvidia|geforce|quadro|rtx|gtx|radeon (rx|pro|vii)|arc\(tm\) a|arc a\d|apple m\d|apple gpu.*(max|pro)|iris xe|radeon 7\d0m|radeon 6[89]0m)/i;
const MID_GPU = /(adreno.{0,8}(6[2-9]\d|[7-9]\d\d)|mali-g(6[1-9]|7\d|[6-9]\d\d|\d{3})|immortalis|xclipse|apple|intel|radeon|iris)/i;

export function probeDevice() {
  const info = {
    webgl2: false, gpu: 'unknown', gpuClass: 'unknown', cores: navigator.hardwareConcurrency || 4,
    memory: navigator.deviceMemory || 0, coarse: matchMedia('(pointer: coarse)').matches,
    dpr: window.devicePixelRatio || 1, saveData: !!navigator.connection?.saveData,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    maxTexture: 0,
  };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      info.webgl2 = true;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      info.gpu = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      info.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL2 */ }
  info.gpuClass = LOW_GPU.test(info.gpu) ? 'low' : HIGH_GPU.test(info.gpu) ? 'high' : MID_GPU.test(info.gpu) ? 'medium' : 'unknown';
  return info;
}

export function chooseTier(info) {
  let tier = info.gpuClass === 'low' ? 'low' : info.gpuClass === 'high' ? 'high' : 'medium';
  // Phones and tablets: cap by memory/cores and never start at high (thermal + battery).
  if (info.coarse) {
    if (tier === 'high') tier = 'medium';
    if ((info.memory && info.memory <= 3) || info.cores <= 4) tier = 'low';
  } else if (info.memory && info.memory <= 2) tier = 'low';
  if (info.gpuClass === 'unknown' && info.coarse) tier = 'low';
  if (info.saveData) tier = 'low';
  return tier;
}

export function stepTier(name, delta) {
  const i = TIER_NAMES.indexOf(name);
  return TIER_NAMES[Math.max(0, Math.min(TIER_NAMES.length - 1, i + delta))];
}

/**
 * Watches frame times. During the first seconds it acts as a benchmark (may drop one tier);
 * afterwards it scales resolution and only drops a tier if minimum resolution is still too slow.
 */
export class Governor {
  constructor({ onScale, onTierDrop }) {
    this.onScale = onScale;
    this.onTierDrop = onTierDrop;
    this.scale = 1;
    this.ema = 16.7;
    this.slowFor = 0;
    this.fastFor = 0;
    this.samples = [];
    this.benchmarking = true;
    this.benchStart = 0;
    this.minScale = 0.6;
    this.enabled = true;
    this.refresh = 16.7;
  }

  setLimits(minScale) { this.minScale = minScale; }

  reset() {
    this.scale = 1; this.slowFor = 0; this.fastFor = 0; this.samples = []; this.benchmarking = true; this.benchStart = 0;
  }

  frame(now, dt, targetMs) {
    if (!this.enabled || dt <= 0 || dt > 250) return; // tab switches etc.
    this.ema += (dt - this.ema) * 0.08;
    if (this.benchmarking) {
      if (!this.benchStart) this.benchStart = now;
      this.samples.push(dt);
      if (now - this.benchStart > 2200 && this.samples.length > 30) {
        this.benchmarking = false;
        const s = this.samples.slice(10).sort((a, b) => a - b);
        this.refresh = Math.max(6.9, s[Math.floor(s.length * 0.1)]);
        const median = s[Math.floor(s.length / 2)];
        const p90 = s[Math.floor(s.length * 0.9)];
        this.benchResult = { median, p90, refresh: this.refresh };
        if (median > Math.max(targetMs, this.refresh) * 1.45 || p90 > 50) this.onTierDrop?.('benchmark');
      }
      return;
    }
    const target = Math.max(targetMs, this.refresh);
    if (this.ema > target * 1.25) {
      this.slowFor += dt; this.fastFor = 0;
      if (this.slowFor > 1000) {
        this.slowFor = 0;
        if (this.scale > this.minScale + 1e-3) {
          this.scale = Math.max(this.minScale, this.scale * 0.88);
          this.onScale?.(this.scale);
        } else {
          this.onTierDrop?.('governor');
        }
      }
    } else if (this.ema < target * 1.06) {
      this.fastFor += dt; this.slowFor = Math.max(0, this.slowFor - dt);
      if (this.fastFor > 4000 && this.scale < 1) {
        this.fastFor = 0;
        this.scale = Math.min(1, this.scale / 0.9);
        this.onScale?.(this.scale);
      }
    } else {
      this.slowFor = Math.max(0, this.slowFor - dt * 0.5);
      this.fastFor = 0;
    }
  }
}
