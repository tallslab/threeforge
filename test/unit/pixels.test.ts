import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { pixelDiff } from '../e2e/pixels.js';

/** Encodes a flat RGBA pixel grid (row-major, 4 bytes per pixel) as a PNG buffer. */
function png(width: number, height: number, pixels: number[][]): Buffer {
  const p = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a = 255] = pixels[i]!;
    const o = i * 4;
    p.data[o] = r!;
    p.data[o + 1] = g!;
    p.data[o + 2] = b!;
    p.data[o + 3] = a;
  }
  return PNG.sync.write(p);
}

describe('pixelDiff', () => {
  it('returns 0 for identical images', () => {
    const a = png(2, 2, [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ]);
    const b = png(2, 2, [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ]);
    expect(pixelDiff(a, b)).toBe(0);
  });

  it('counts a pixel whose channel differs by more than the default threshold of 24', () => {
    const a = png(2, 1, [
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const b = png(2, 1, [
      [25, 0, 0], // one channel off by 25: counts
      [0, 0, 0],
    ]);
    expect(pixelDiff(a, b)).toBe(0.5); // 1 of 2 pixels differs
  });

  it('does not count a pixel whose channel differs by exactly the threshold', () => {
    const a = png(2, 1, [
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const b = png(2, 1, [
      [24, 0, 0], // exactly at the threshold: not > 24, so not counted
      [0, 0, 0],
    ]);
    expect(pixelDiff(a, b)).toBe(0);
  });

  it('respects a custom threshold option', () => {
    const a = png(1, 1, [[0, 0, 0]]);
    const b = png(1, 1, [[15, 0, 0]]);
    expect(pixelDiff(a, b)).toBe(0); // under the default threshold of 24
    expect(pixelDiff(a, b, { threshold: 10 })).toBe(1); // 15 > 10
    expect(pixelDiff(a, b, { threshold: 15 })).toBe(0); // 15 is not > 15
  });

  it('by default does not special-case mismatched dimensions (matches every copy but assets.spec.ts)', () => {
    // a is 2x1 (n=2); b is 1x1, so the second pixel compares against undefined data and never counts as a hit.
    const a = png(2, 1, [
      [0, 0, 0],
      [255, 255, 255],
    ]);
    const b = png(1, 1, [[0, 0, 0]]);
    expect(pixelDiff(a, b)).toBe(0);
  });

  it('with requireSameSize, returns 1 immediately for mismatched dimensions (matches assets.spec.ts)', () => {
    const a = png(2, 2, [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const b = png(1, 1, [[0, 0, 0]]);
    expect(pixelDiff(a, b, { requireSameSize: true })).toBe(1);
  });
});
