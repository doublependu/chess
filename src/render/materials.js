import {
  MeshToonMaterial, MeshBasicMaterial, DataTexture, RedFormat, NearestFilter, Color, BackSide,
} from 'three';

// Uniforms shared by every patched material (one object, so updating it updates all shaders).
export const globalUniforms = {
  uTime: { value: 0 },
  uWind: { value: 0 }, // current gust strength 0..1
  uWindDir: { value: [1, 0, -0.3] },
  uTimeWarp: { value: 0 }, // 0..1 rewind look (desaturate + sepia)
};

const WARP_CHUNK = /* glsl */`
  {
    vec3 c = gl_FragColor.rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 sepia = vec3(l * 1.07 + 0.03, l * 0.93 + 0.01, l * 0.72);
    gl_FragColor.rgb = mix(c, sepia, uTimeWarp * 0.85);
  }
`;

/** Adds the global time-warp grade to a built-in material (no extra render pass needed). */
export function patchWarp(material, extraKey = '') {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uTimeWarp = globalUniforms.uTimeWarp;
    shader.fragmentShader = 'uniform float uTimeWarp;\n' + shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      '#include <dithering_fragment>\n' + WARP_CHUNK,
    );
  };
  material.customProgramCacheKey = () => 'warp' + extraKey;
  return material;
}

export const WARP_GLSL = { decl: 'uniform float uTimeWarp;', apply: WARP_CHUNK };

let toonRamp = null;
export function getToonRamp() {
  if (toonRamp) return toonRamp;
  const data = new Uint8Array([70, 135, 195, 255]);
  toonRamp = new DataTexture(data, data.length, 1, RedFormat);
  toonRamp.minFilter = toonRamp.magFilter = NearestFilter;
  toonRamp.generateMipmaps = false;
  toonRamp.needsUpdate = true;
  return toonRamp;
}

export const TEAM_COLORS = [new Color('#f4e8d2'), new Color('#3a3046')];
export const TEAM_INNER = [new Color('#e2c79c'), new Color('#7a5a8c')];
export const TEAM_GLOW = [new Color('#ffb347'), new Color('#b77dff')];
export const OUTLINE_COLOR = new Color('#1a1222');

/** Rim light (fresnel) added on top of toon shading so dark pieces read against the board. */
function patchRim(material, strength, color) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: strength };
    shader.uniforms.uRimColor = { value: color };
    shader.fragmentShader = 'uniform float uRim;\nuniform vec3 uRimColor;\n' + shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float rim = pow(1.0 - clamp(dot(normalize(vViewPosition), -normal) * -1.0 + 0.0, 0.0, 1.0), 3.0);
       outgoingLight += uRimColor * rim * uRim;
       #include <opaque_fragment>`,
    );
  };
}

/** Per-piece toon material (cloned per piece so hits can flash it via `emissive`). */
export function createPieceMaterial(color) {
  const m = new MeshToonMaterial({ color: TEAM_COLORS[color], gradientMap: getToonRamp() });
  patchRim(m, color === 1 ? 0.55 : 0.25, color === 1 ? new Color('#c9a6ff') : new Color('#fff1d6'));
  patchWarp(m, 'piece');
  return m;
}

export function createInnerMaterial(color) {
  const m = new MeshToonMaterial({ color: TEAM_INNER[color], gradientMap: getToonRamp(), emissive: TEAM_GLOW[color], emissiveIntensity: 1.2 });
  patchWarp(m, 'inner');
  return m;
}

export function createDecorMaterial() {
  return patchWarp(new MeshBasicMaterial({ color: '#120c18' }), 'decor');
}

/** Inverted-hull outline: back faces pushed out along the normal. */
export function createOutlineMaterial(thickness = 0.014) {
  const m = new MeshBasicMaterial({ color: OUTLINE_COLOR, side: BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uThick = { value: thickness };
    shader.vertexShader = 'uniform float uThick;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\ntransformed += normalize(normal) * uThick;',
    );
    shader.uniforms.uTimeWarp = globalUniforms.uTimeWarp;
  };
  m.customProgramCacheKey = () => 'outline';
  return m;
}
