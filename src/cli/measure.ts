import type { FrameSnapshot } from '../ledger/snapshot.js';
import type { CliCompileReport } from './types.js';
import type { PlaywrightPage } from './browser.js';
import { PageError } from './errors.js';
import { withTimeout } from './lifecycle.js';
import { cleanText, sanitizeDeep } from './untrusted.js';

export { PageError };

/**
 * `page.evaluate` of an expression, bounded by `timeout` ms: a page that never answers becomes a PageError naming
 * `what`. A *resolved* value goes through `sanitizeDeep` before it reaches the caller: `inspect`'s target is any
 * page, not necessarily one that used threeforge's own name/message caps (`src/ledger/text.ts`), so this is the
 * one place every value a page hands back to the CLI is bounded and cleaned before it can reach a document or the
 * terminal. A *rejected* `page.evaluate` (a `window.__threeforge` hook that throws inside `compile()` or
 * `frameAsync()`) carries the same untrusted page text through its error message instead of a return value —
 * that message is cleaned the same way and re-thrown as a `PageError`, so this function has exactly one way to
 * fail and it is always safe to print or return.
 */
export function evaluateWithin<R>(page: PlaywrightPage, what: string, timeout: number, expression: string): Promise<R> {
  return withTimeout(what, timeout, async () => {
    let result: R;
    try {
      result = await page.evaluate<R>(expression);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PageError(`${what}: ${cleanText(message)}`);
    }
    return sanitizeDeep(result) as R;
  });
}

/**
 * `window.__threeforge.compile()`, with the true lengths of `skipped` and `groups` counted in the page, before
 * `evaluateWithin` caps every array at 256 entries (final review F3: a 300-object report reached the document as 256
 * and the summary printed "256 skipped"). The lists stay capped, bounding what a page can put in a document; the
 * counts say how many there really were.
 */
export function compileViaHook(page: PlaywrightPage, timeout: number): Promise<CliCompileReport> {
  return evaluateWithin<CliCompileReport>(
    page,
    'compiling',
    timeout,
    `(async () => {
      const report = await window.__threeforge.compile();
      if (report === null || typeof report !== 'object') return report;
      const lengthOf = (list) => (Array.isArray(list) ? list.length : 0);
      return { ...report, skippedCount: lengthOf(report.skipped), groupCount: lengthOf(report.groups) };
    })()`,
  );
}

export interface Measurement {
  snapshot: FrameSnapshot;
  renderMs: number;
  ledgerMs: number;
  frameMs: number;
}

/** The frame snapshot `schemaVersion` this CLI reads from `window.__threeforge` (what `exposeToAgents` publishes). */
export const HOOK_SCHEMA_VERSION = 3;

// Split so the in-page check below (measureViaHook) can build the identical message from `hook.schemaVersion`, known
// only inside the page, without re-typing the wording or reaching for a placeholder-and-replace trick.
const UNSUPPORTED_PREFIX = 'window.__threeforge has unsupported schemaVersion ';
const UNSUPPORTED_SUFFIX = `: this threeforge CLI reads schemaVersion ${HOOK_SCHEMA_VERSION}; upgrade threeforge in the app (exposeToAgents)`;
const unsupported = (version: string): string => `${UNSUPPORTED_PREFIX}${version}${UNSUPPORTED_SUFFIX}`;

/**
 * The same message for a *frame* whose own `schemaVersion` is not the one this CLI reads. The hook's advertised
 * version is checked separately (`assertHookVersion`, and the in-page guard in `measureViaHook`), but a target that
 * advertises 3 and hands back a differently-shaped frame would otherwise produce a document that violates the CLI's
 * own published `SNAPSHOT_SCHEMA` (`schema.ts`, `{ const: 3 }`) with nothing to notice (independent review L3).
 */
const unsupportedFrame = (version: string): string => `window.__threeforge returned a frame with unsupported schemaVersion ${version}${UNSUPPORTED_SUFFIX}`;

/**
 * `page.screenshot`, bounded by `timeout` ms twice over: the bound is handed to Playwright so the operation itself is
 * cancelled rather than merely abandoned, and `withTimeout` covers a call that never settles at all. Without it the
 * shot fell back to Playwright's 30 s page default, which `--timeout` could not shorten — about 130 un-governed waits
 * at `--views 64` (independent review M2). A Playwright rejection carries driver text, so it is cleaned and re-thrown
 * as a `PageError` exactly as `evaluateWithin` does.
 */
export function screenshotWithin(page: PlaywrightPage, what: string, timeout: number): Promise<Buffer> {
  return withTimeout(what, timeout, async () => {
    try {
      return await page.screenshot({ type: 'png', timeout });
    } catch (error) {
      throw new PageError(`${what}: ${cleanText(error instanceof Error ? error.message : String(error))}`);
    }
  });
}

/** Fails with a PageError unless the page's hook publishes the snapshot version this CLI reads. */
export async function assertHookVersion(page: PlaywrightPage, timeout: number): Promise<void> {
  const version = await evaluateWithin<unknown>(page, 'reading window.__threeforge.schemaVersion', timeout, `window.__threeforge.schemaVersion`);
  if (version !== HOOK_SCHEMA_VERSION) throw new PageError(unsupported(JSON.stringify(version) ?? 'undefined'));
}

/**
 * Drives `window.__threeforge`: N frames through `frameAsync` (one per animation frame, so shadow maps update),
 * then an overdraw and a memory measurement, then the snapshot. Its `js.renderMs`, `js.ledgerMs` and `js.frameMs` are
 * medians over the N frames. A hook with another `schemaVersion` is a PageError. The whole
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
      if (!hook) return { error: 'window.__threeforge is missing: call exposeToAgents({ ledger, world, renderer, scene, camera }) in the app' };
      if (hook.schemaVersion !== ${HOOK_SCHEMA_VERSION}) return { error: ${JSON.stringify(UNSUPPORTED_PREFIX)} + JSON.stringify(hook.schemaVersion) + ${JSON.stringify(UNSUPPORTED_SUFFIX)} };
      const render = []; const ledger = []; const intervals = []; let last = performance.now();
      for (let i = 0; i < ${count}; i++) {
        const f = await hook.frameAsync();
        const now = performance.now(); render.push(f.js.renderMs); ledger.push(f.js.ledgerMs); intervals.push(now - last); last = now;
      }
      if (hook.measureOverdraw) await hook.measureOverdraw();
      hook.measureMemory();
      const snapshot = await hook.frameAsync();
      const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
      return { snapshot, renderMs: median(render), ledgerMs: median(ledger), frameMs: median(intervals) };
    })()`,
  );
  if ('error' in result) throw new PageError(result.error);
  // The hook said 3; this is the frame it actually returned (L3).
  const frameVersion = (result.snapshot as { schemaVersion?: unknown } | null | undefined)?.schemaVersion;
  if (frameVersion !== HOOK_SCHEMA_VERSION) throw new PageError(unsupportedFrame(JSON.stringify(frameVersion) ?? 'undefined'));
  result.snapshot.js.renderMs = result.renderMs;
  result.snapshot.js.ledgerMs = result.ledgerMs;
  result.snapshot.js.frameMs = result.frameMs;
  return result;
}

/**
 * Wait for an expression (a string Playwright evaluates in the page until truthy); a timeout becomes a PageError
 * with `what`. The predicate can also throw mid-evaluation — e.g. a page that defines a getter on the property
 * being checked — so the detail is cleaned the same way as a rejected `page.evaluate` (`evaluateWithin`) before
 * it is embedded in the `PageError`.
 */
export async function waitFor(page: PlaywrightPage, predicate: string, timeout: number, what: string): Promise<void> {
  try {
    await page.waitForFunction(predicate, undefined, { timeout });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0]! : String(error);
    throw new PageError(`${what} (${cleanText(detail)})`);
  }
}
