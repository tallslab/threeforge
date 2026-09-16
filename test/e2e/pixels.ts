/**
 * Shared pixel-comparison helpers for e2e specs. `pixelDiff` counts a pixel as differing when any RGB channel
 * differs by more than `threshold` (default 24, matching every prior copy) and returns the ratio of differing
 * pixels to total pixels. `settle` advances the harness a few animation frames so reflectors, async pipeline
 * compiles and similar one-frame-late effects have time to settle before a screenshot is taken.
 *
 * Only a type-level import is taken from `@playwright/test` (erased by `verbatimModuleSyntax`) so this module has
 * no runtime dependency on Playwright and can be imported from `test/unit` under Vitest.
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';

export interface PixelDiffOptions {
  /** Per-channel (R/G/B) difference above which a pixel counts as differing. Default 24. */
  threshold?: number;
  /** When given, writes a diff PNG (dimmed original, differing pixels in red) to this path. */
  diffPath?: string;
}

/**
 * Counts differing pixels between two PNG buffers and returns differing / total as a ratio in [0, 1]. Images of
 * different sizes differ entirely (1): a render that changed size is not parity, and comparing by index would read
 * past the end of the smaller image (every such pixel reading as unchanged) or misalign rows.
 */
export function pixelDiff(a: Buffer, b: Buffer, options: PixelDiffOptions = {}): number {
  const { differing, total } = countDiffering(a, b, options);
  return differing / total;
}

/**
 * The number of differing pixels between two PNG buffers (same rule and options as `pixelDiff`): for a bound measured in
 * pixels, such as a decompile that restores the picture exactly. Images of different sizes count every pixel of the
 * larger one.
 */
export function differingPixels(a: Buffer, b: Buffer, options: PixelDiffOptions = {}): number {
  return countDiffering(a, b, options).differing;
}

function countDiffering(a: Buffer, b: Buffer, options: PixelDiffOptions): { differing: number; total: number } {
  const { threshold = 24, diffPath } = options;
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) {
    const larger = Math.max(pa.width * pa.height, pb.width * pb.height);
    return { differing: larger, total: larger };
  }
  const out = diffPath ? new PNG({ width: pa.width, height: pa.height }) : undefined;
  let differing = 0;
  const n = pa.width * pa.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(pa.data[o]! - pb.data[o]!), Math.abs(pa.data[o + 1]! - pb.data[o + 1]!), Math.abs(pa.data[o + 2]! - pb.data[o + 2]!));
    const hit = d > threshold;
    if (hit) differing++;
    if (out) {
      // Diff image: dimmed original with differing pixels in red.
      out.data[o] = hit ? 255 : pa.data[o]! >> 2;
      out.data[o + 1] = hit ? 0 : pa.data[o + 1]! >> 2;
      out.data[o + 2] = hit ? 0 : pa.data[o + 2]! >> 2;
      out.data[o + 3] = 255;
    }
  }
  if (diffPath && out) writeFileSync(diffPath, PNG.sync.write(out));
  return { differing, total: n };
}

/** Advances the harness `frames` animation frames (default 3) so late-settling effects finish before a screenshot. */
export function settle(page: Page, frames = 3): Promise<void> {
  return page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await window.__forge.frameAsync();
  }, frames);
}
