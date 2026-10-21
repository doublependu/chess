import { describe, it, expect } from 'vitest';
import { idleMotion } from '../src/render/quality.js';

describe('idle motion', () => {
  it('auto is calm on phones, on Low and with reduced motion, and full otherwise', () => {
    expect(idleMotion('auto', { coarse: true, tier: 'medium' })).toBe('calm');
    expect(idleMotion('auto', { coarse: false, tier: 'low' })).toBe('calm');
    expect(idleMotion('auto', { coarse: false, tier: 'high', reducedMotion: true })).toBe('calm');
    expect(idleMotion('auto', { coarse: false, tier: 'medium' })).toBe('full');
    expect(idleMotion('auto', { coarse: false, tier: 'high' })).toBe('full');
  });

  it("the player's own choice wins over the device", () => {
    expect(idleMotion('full', { coarse: true, tier: 'low', reducedMotion: true })).toBe('full');
    expect(idleMotion('off', { coarse: false, tier: 'high' })).toBe('off');
    expect(idleMotion('calm', { coarse: false, tier: 'high' })).toBe('calm');
  });

  it('an unknown or missing value counts as auto', () => {
    expect(idleMotion(undefined, { coarse: true })).toBe('calm');
    expect(idleMotion('bogus', { tier: 'medium' })).toBe('full');
  });
});
