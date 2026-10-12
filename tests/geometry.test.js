import { describe, it, expect } from 'vitest';
import { buildPieceParts, isManifold, signedVolume } from '../src/render/pieces/geometry.js';

describe('piece geometry', () => {
  for (let type = 1; type <= 6; type++) {
    it(`type ${type}: every solid part is a closed, outward-facing manifold`, () => {
      for (const segments of [12, 24, 32]) {
        const { solid } = buildPieceParts(type, { segments });
        expect(solid.length).toBeGreaterThan(0);
        for (const g of solid) {
          expect(isManifold(g)).toBe(true);
          expect(signedVolume(g)).toBeGreaterThan(0);
        }
      }
    });
  }
});
