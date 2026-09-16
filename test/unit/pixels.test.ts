import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { comparePixels, pixelDiffPct } from '../../src/cli/analyze.js';
import { differingPixels, pixelDiff } from '../e2e/pixels.js';

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

  it('reads images of different sizes as entirely different, whichever is smaller: a render-size change is not parity', () => {
    // Before, a 2x1 image against a 1x1 one compared the second pixel against data past the end (NaN > threshold is
    // false) and read 0; the other way round it compared the overlap only.
    const a = png(2, 1, [
      [0, 0, 0],
      [255, 255, 255],
    ]);
    const b = png(1, 1, [[0, 0, 0]]);
    expect(pixelDiff(a, b)).toBe(1);
    expect(pixelDiff(b, a)).toBe(1);
    expect(pixelDiff(png(2, 1, [[0, 0, 0], [0, 0, 0]]), png(1, 2, [[0, 0, 0], [0, 0, 0]])), 'same pixel count, other shape').toBe(1);
  });
});

/**
 * `pixelDiffPct` (`src/cli/analyze.ts`) is the tolerance the shipped CLI judges renders with: `analyze`'s compile
 * parity and `optimize --parity` both count a pixel as changed when any of R, G, B differs by **more than 24**, and
 * report the count as a percent of the pixels compared. So `--parity 0` means "no pixel moved by more than 24 on any
 * channel in any view", not "the two PNGs are byte-identical": a run reported as 0 can still differ by 24 everywhere.
 * These cases pin that boundary, the percent scale and the mismatched-size behaviour, none of which had a unit test —
 * every number in `verify.parity` and the docs' measurement of `safe` at zero changed pixels rest on them.
 */
describe('differingPixels', () => {
  it('counts the pixels pixelDiff would, as an integer, and every pixel of the larger image when the sizes differ', () => {
    const a = png(3, 1, [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const b = png(3, 1, [
      [25, 0, 0],
      [4, 0, 0],
      [5, 0, 0],
    ]);
    expect(differingPixels(a, b)).toBe(1);
    expect(differingPixels(a, b, { threshold: 4 })).toBe(2);
    expect(differingPixels(a, a)).toBe(0);
    expect(differingPixels(a, png(1, 1, [[0, 0, 0]]))).toBe(3);
  });
});

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

  /**
   * Both call sites round the percent to three decimals — `Number(comparePixels(a, b).diffPct.toFixed(3))` in
   * `src/cli/analyze.ts` and `src/cli/optimize.ts` — so a view reported as 0 is not proof that no pixel moved. At
   * the CLI harness's 1280x720 canvas (921,600 pixels) the rounding absorbs anything below 0.0005 %, which is
   * 4.608 pixels, so an asserted `diffPct === 0` only means "at most 4 pixels moved by more than 24 on a channel".
   * That is why each view also carries `changedPixels` (Ruling R104): the exact count, which this pins alongside
   * the rounding it exists to defeat. `--parity 0` plus `changedPixels === 0` is the pair that proves parity.
   */
  it('rounds to three decimals at the call sites, so 4 changed pixels of 921,600 still report 0', () => {
    // The CLI's own canvas size: cli-app/main.ts renders at 800x600 with pixelRatio 1, Playwright shoots 1280x720.
    const canvas = (changed: number): Buffer => {
      const p = new PNG({ width: 1280, height: 720 });
      for (let i = 0; i < 1280 * 720; i++) p.data[i * 4 + 3] = 255;
      for (let i = 0; i < changed; i++) p.data[i * 4] = 25; // one channel past the threshold of 24
      return PNG.sync.write(p);
    };
    const blank = canvas(0);
    const reported = (changed: number): number => Number(pixelDiffPct(blank, canvas(changed)).toFixed(3)); // exactly what the call sites do
    expect(pixelDiffPct(blank, canvas(4))).toBeGreaterThan(0); // 4 pixels really did change
    expect(reported(4)).toBe(0); // ...and the reported figure is still 0
    expect(reported(5)).toBe(0.001);
    expect(4 / (1280 * 720)).toBeLessThan(0.000005); // 0.0005 % as a ratio: the rounding boundary
    // What the reported figure cannot say, the count says exactly: this is the assertion the safe e2e now makes.
    expect(comparePixels(blank, canvas(4)).changedPixels).toBe(4);
    expect(comparePixels(blank, canvas(0)).changedPixels).toBe(0);
  });

  it('reports the exact changed-pixel count, the pixels compared, and an unrounded percent', () => {
    const a = png(4, 1, [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const b = png(4, 1, [
      [25, 0, 0], // counts
      [24, 0, 0], // exactly at the threshold: does not
      [0, 25, 0], // any channel counts
      [0, 0, 0],
    ]);
    expect(comparePixels(a, b)).toEqual({ changedPixels: 2, comparedPixels: 4, diffPct: 50 });
  });

  it('reports images of different sizes as every pixel of the larger changed, so no parity threshold passes them', () => {
    // Before, the CLI's copy compared min(n) pixels by flat index: a resized canvas read as parity over the overlap,
    // with rows misaligned when the widths differ, and `--parity 0` reported it pixel-identical.
    const a = png(2, 1, [
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const b = png(1, 1, [[0, 0, 0]]);
    expect(comparePixels(a, b)).toEqual({ changedPixels: 2, comparedPixels: 2, diffPct: 100 });
    expect(comparePixels(b, a)).toEqual({ changedPixels: 2, comparedPixels: 2, diffPct: 100 });
    expect(comparePixels(a, png(1, 2, [[0, 0, 0], [0, 0, 0]])), 'same pixel count, other shape').toEqual({ changedPixels: 2, comparedPixels: 2, diffPct: 100 });
    expect(pixelDiffPct(a, b)).toBe(100);
  });
});
