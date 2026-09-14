import type { FrameSnapshot } from '../ledger/snapshot.js';
import type { PlaywrightPage } from './browser.js';
import { PageError } from './errors.js';
import { withTimeout } from './lifecycle.js';

export { PageError };

/** `page.evaluate` of an expression, bounded by `timeout` ms: a page that never answers becomes a PageError naming `what`. */
export function evaluateWithin<R>(page: PlaywrightPage, what: string, timeout: number, expression: string): Promise<R> {
  return withTimeout(what, timeout, () => page.evaluate<R>(expression));
}

export interface Measurement {
  snapshot: FrameSnapshot;
  renderMs: number;
  frameMs: number;
}

/**
 * Drives `window.__threeforge`: N frames through `frameAsync` (one per animation frame, so shadow maps update),
 * then an overdraw and a memory measurement, then the snapshot. Timings are medians over the frames. The whole
 * measurement is bounded by `timeout` ms (a hook whose frameAsync never settles becomes a PageError).
 */
export async function measureViaHook(page: PlaywrightPage, frames: number, timeout = 60_000): Promise<Measurement> {
  const count = Math.max(1, Math.round(frames));
  const result = await evaluateWithin<Measurement | { error: string }>(
    page,
    `measuring ${count} frames`,
    timeout,
    `(async () => {
      const hook = window.__threeforge;
      if (!hook || hook.schemaVersion !== 2) return { error: 'window.__threeforge is missing: call exposeToAgents({ ledger, world, renderer, scene, camera }) in the app' };
      const render = []; const intervals = []; let last = performance.now();
      for (let i = 0; i < ${count}; i++) {
        const f = await hook.frameAsync();
        const now = performance.now(); render.push(f.js.renderMs); intervals.push(now - last); last = now;
      }
      if (hook.measureOverdraw) await hook.measureOverdraw();
      hook.measureMemory();
      const snapshot = await hook.frameAsync();
      const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
      return { snapshot, renderMs: median(render), frameMs: median(intervals) };
    })()`,
  );
  if ('error' in result) throw new PageError(result.error);
  result.snapshot.js.renderMs = result.renderMs;
  result.snapshot.js.frameMs = result.frameMs;
  return result;
}

/** Wait for an expression (a string Playwright evaluates in the page until truthy); a timeout becomes a PageError with `what`. */
export async function waitFor(page: PlaywrightPage, predicate: string, timeout: number, what: string): Promise<void> {
  try {
    await page.waitForFunction(predicate, undefined, { timeout });
  } catch (error) {
    throw new PageError(`${what} (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
  }
}
