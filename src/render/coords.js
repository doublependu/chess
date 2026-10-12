import { Vector3 } from 'three';

// Board layout: square size 1, a1 at (-3.5, 0, 3.5), h8 at (3.5, 0, -3.5). White sits at +z.
export const BOARD_HALF = 4;
export const RIM = 0.62;

export function squareToXZ(name) {
  const f = name.charCodeAt(0) - 97;
  const r = name.charCodeAt(1) - 49;
  return { x: f - 3.5, z: 3.5 - r };
}

export function squareToVec(name, y = 0, out = new Vector3()) {
  const { x, z } = squareToXZ(name);
  return out.set(x, y, z);
}

export function xzToSquare(x, z) {
  const f = Math.floor(x + 4);
  const r = Math.floor(4 - z);
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return String.fromCharCode(97 + f) + (r + 1);
}

export const isLightSquare = (name) => ((name.charCodeAt(0) - 97) + (name.charCodeAt(1) - 49)) % 2 === 1;
