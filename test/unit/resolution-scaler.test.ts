import { describe, expect, it } from 'vitest';
import { ResolutionScaler } from '../../src/overdraw/ResolutionScaler.js';

function fakeRenderer(ratio = 2) {
  const calls: number[] = [];
  return {
    calls,
    getPixelRatio: () => ratio,
    setPixelRatio: (v: number) => {
      ratio = v;
      calls.push(v);
    },
  };
}

describe('ResolutionScaler', () => {
  it('steps down when the median exceeds the target, up with headroom, clamped', () => {
    const r = fakeRenderer(2);
    const env: number[] = [];
    const scaler = new ResolutionScaler(r, {
      target: 16.6,
      window: 20,
      step: 0.05,
      min: 0.5,
      max: 1,
      ledger: { setEnvironment: (e) => env.push(e.dpr) },
    });
    expect(scaler.base).toBe(2);
    expect(scaler.scale).toBe(1);
    for (let i = 0; i < 19; i++) expect(scaler.update(25)).toBe(1);
    expect(scaler.update(25)).toBeCloseTo(0.95);
    expect(r.calls).toEqual([1.9]);
    expect(env).toEqual([1.9]);
    for (let i = 0; i < 20; i++) scaler.update(25);
    expect(scaler.scale).toBeCloseTo(0.9);
    for (let k = 0; k < 20; k++) for (let i = 0; i < 20; i++) scaler.update(40);
    expect(scaler.scale).toBe(0.5);
    for (let i = 0; i < 20; i++) scaler.update(5);
    expect(scaler.scale).toBeCloseTo(0.55);
    for (let k = 0; k < 20; k++) for (let i = 0; i < 20; i++) scaler.update(5);
    expect(scaler.scale).toBe(1);
    // In the dead band nothing moves.
    for (let i = 0; i < 20; i++) scaler.update(15);
    expect(scaler.scale).toBe(1);
  });

  it('takes the target from the tier budget, sets a scale directly and restores on dispose', () => {
    const r = fakeRenderer(1);
    const scaler = new ResolutionScaler(r, { tier: 'phone-low' });
    expect(scaler.target).toBe(33);
    scaler.set(0.5);
    expect(r.calls).toEqual([0.5]);
    expect(scaler.scale).toBe(0.5);
    scaler.set(3);
    expect(scaler.scale).toBe(1);
    scaler.dispose();
    expect(r.calls.at(-1)).toBe(1);
    expect(new ResolutionScaler(fakeRenderer(1)).target).toBe(16.6);
  });
});
