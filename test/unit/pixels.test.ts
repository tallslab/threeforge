import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { pixelDiffPct } from '../../src/cli/analyze.js';
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

/**
 * `pixelDiffPct` (`src/cli/analyze.ts`) is the tolerance the shipped CLI judges renders with: `analyze`'s compile
 * parity and `optimize --parity` both count a pixel as changed when any of R, G, B differs by **more than 24**, and
 * report the count as a percent of the pixels compared. So `--parity 0` means "no pixel moved by more than 24 on any
 * channel in any view", not "the two PNGs are byte-identical": a run reported as 0 can still differ by 24 everywhere.
 * These cases pin that boundary, the percent scale and the mismatched-size behaviour, none of which had a unit test —
 * every number in `verify.parity` and in the docs' pixel-identical claim rests on them.
 */
describe('pixelDiffPct (the CLI parity tolerance)', () => {
  it('returns 0 for identical images', () => {
    const pixels = [
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ];
    expect(pixelDiffPct(png(2, 2, pixels), png(2, 2, pixels))).toBe(0);
  });

  it('counts a pixel only when a channel differs by MORE than 24, and reports a percent of the pixels compared', () => {
    const a = png(4, 1, [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const b = png(4, 1, [
      [25, 0, 0], // 25 > 24: counts
      [24, 0, 0], // exactly 24: not > 24, so it does not
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(pixelDiffPct(a, b)).toBe(25); // 1 of 4 pixels
  });

  it('counts a difference on any single channel and ignores alpha', () => {
    const black = (alpha: number): Buffer => png(1, 1, [[0, 0, 0, alpha]]);
    expect(pixelDiffPct(black(255), black(0))).toBe(0); // alpha is never read
    for (const channel of [0, 1, 2]) {
      const off = [0, 0, 0];
      off[channel] = 25;
      expect(pixelDiffPct(png(1, 1, [[0, 0, 0]]), png(1, 1, [off])), `channel ${channel}`).toBe(100);
    }
  });

  it('is the e2e helper at the same default threshold, scaled to a percent', () => {
    const a = png(2, 2, [
      [0, 0, 0],
      [0, 0, 0],
      [200, 200, 200],
      [0, 0, 0],
    ]);
    const b = png(2, 2, [
      [25, 0, 0],
      [24, 0, 0],
      [200, 200, 160],
      [0, 0, 0],
    ]);
    expect(pixelDiffPct(a, b)).toBeCloseTo(100 * pixelDiff(a, b), 10);
  });

  it('compares the pixels both images have instead of short-circuiting on mismatched dimensions', () => {
    // Unlike the e2e helper's `requireSameSize`, the CLI's copy compares min(n) pixels: a resized canvas is
    // reported from the overlap, not as a 100 % difference.
    const a = png(2, 1, [
      [0, 0, 0],
      [255, 255, 255],
    ]);
    const b = png(1, 1, [[0, 0, 0]]);
    expect(pixelDiffPct(a, b)).toBe(0);
    expect(pixelDiffPct(png(1, 1, [[255, 0, 0]]), a)).toBe(100);
  });
});
