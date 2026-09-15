import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial } from 'three';
import { exposeToAgents, type AgentHook } from '../../src/agent/expose.js';
import type { BrowserHandle, PlaywrightPage } from '../../src/cli/browser.js';
import { PageError } from '../../src/cli/errors.js';
import { printDocument, summarize } from '../../src/cli/format.js';
import { inspectApp } from '../../src/cli/inspect.js';
import { measureViaHook } from '../../src/cli/measure.js';
import type { InspectInput } from '../../src/cli/types.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

/**
 * `inspect` and the frame snapshot `schemaVersion`. A fake Playwright page evaluates the CLI's own expressions (the
 * wait predicate, the version read, the in-page measurement script) against a fake `window` holding a real
 * `exposeToAgents` hook, so they run as written. `app({ schemaVersion: 2 })` stands for a threeforge 0.8.0 app.
 */
interface FakeWindow {
  __threeforge?: AgentHook;
}

function pageOn(window: FakeWindow, evaluated: string[] = []): PlaywrightPage {
  const run = (expression: string): unknown => new Function('window', `return (${expression});`)(window);
  const page = {
    goto: async () => null,
    waitForFunction: async (predicate: string, _arg: unknown, options: { timeout?: number } = {}) => {
      const end = Date.now() + (options.timeout ?? 30_000);
      for (;;) {
        const value = run(predicate);
        if (value) return value;
        if (Date.now() >= end) throw new Error(`page.waitForFunction: Timeout ${options.timeout}ms exceeded.`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    evaluate: async (expression: string) => {
      evaluated.push(expression);
      return run(expression);
    },
    screenshot: async () => Buffer.alloc(0),
    on: () => page,
    close: async () => {},
  };
  return page as unknown as PlaywrightPage;
}

/**
 * An app with 4 meshes, a ledger on an injected clock and the agent hook. Every render() call costs 3 ms; each frame's
 * filing reads the scheduler once, which costs the next of `filingCosts` (so it lands in that frame's `js.ledgerMs`).
 */
function app(options: { schemaVersion?: number; filingCosts?: number[] } = {}): { window: FakeWindow } {
  let t = 0;
  const ledger = new DrawCallLedger({ now: () => t });
  const renderer = new FakeRenderer();
  const render = renderer.render.bind(renderer);
  (renderer as { render: typeof render }).render = (scene, camera) => {
    t += 3;
    return render(scene, camera);
  };
  ledger.attach(renderer as never);
  const costs = [...(options.filingCosts ?? [])];
  ledger.attachScheduler({
    skippedRecently: () => {
      t += costs.shift() ?? 0;
      return 0;
    },
  });
  const { scene, camera } = sceneWithCamera();
  for (let i = 0; i < 4; i++) scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const window: FakeWindow = {};
  exposeToAgents({ ledger, renderer: renderer as never, scene, camera, target: window, requestFrame: (callback) => callback() });
  delete window.__threeforge!.measureOverdraw; // the fake renderer cannot run the overdraw count renders
  if (options.schemaVersion !== undefined) (window.__threeforge as unknown as { schemaVersion: number }).schemaVersion = options.schemaVersion;
  return { window };
}

const input = (overrides: Partial<InspectInput> = {}): InspectInput => ({ url: 'http://127.0.0.1:9/', backend: 'webgl2', tier: 'auto', budget: null, frames: 3, compile: true, timeout: 2000, headed: false, ...overrides });
const launchOn = (page: PlaywrightPage) => async (): Promise<BrowserHandle> => ({ newPage: async () => page, close: async () => {} });

describe('inspect and the frame snapshot schemaVersion', () => {
  it('measures an app whose hook exposes schemaVersion 3; js.renderMs and js.ledgerMs are medians over the measured frames', async () => {
    const { window } = app({ filingCosts: [9, 1, 1, 50] });
    expect(window.__threeforge!.schemaVersion).toBe(3);
    const doc = await inspectApp(input(), undefined, { launch: launchOn(pageOn(window)) });
    expect(doc.before.schemaVersion).toBe(3);
    expect(doc.before.totals.sceneSubmissions).toBe(4);
    expect(doc.before.js.renderMs).toBe(3);
    // The 3 measured frames filed in 9, 1 and 1 ms (median 1); the snapshot's own frame took 50.
    expect(doc.before.js.ledgerMs).toBe(1);
  });

  it('a schemaVersion 2 app (threeforge 0.8.0) fails at once naming its version: nothing is measured, compiled or formatted', async () => {
    const { window } = app({ schemaVersion: 2 });
    const evaluated: string[] = [];
    const printed: string[] = [];
    const streams = { stdout: { write: (chunk: string) => printed.push(chunk) }, stderr: { write: (chunk: string) => printed.push(chunk) } };
    const started = Date.now();
    // What `threeforge inspect` does (src/cli/index.ts): print the document inspectApp resolves with.
    const error = await inspectApp(input({ timeout: 5000 }), undefined, { launch: launchOn(pageOn(window, evaluated)) }).then(
      (doc) => printDocument(doc, summarize, true, streams),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PageError);
    expect((error as Error).message).toMatch(/unsupported schemaVersion 2/);
    // Names both versions and tells the reader what to do about it (Task 29).
    expect((error as Error).message).toContain('reads schemaVersion 3');
    expect((error as Error).message).toContain('upgrade threeforge in the app (exposeToAgents)');
    expect(Date.now() - started, 'fails without waiting for the timeout').toBeLessThan(1000);
    expect(evaluated.filter((e) => e.includes('frameAsync') || e.includes('compile'))).toEqual([]);
    expect(printed).toEqual([]);
  });

  it('a page without the hook still times out naming exposeToAgents', async () => {
    const error = await inspectApp(input({ timeout: 100 }), undefined, { launch: launchOn(pageOn({})) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PageError);
    expect((error as Error).message).toMatch(/no window.__threeforge hook appeared/);
  });

  it('measureViaHook (analyze and inspect) refuses a hook exposing another schemaVersion', async () => {
    const { window } = app({ schemaVersion: 2 });
    await expect(measureViaHook(pageOn(window), 2, 2000)).rejects.toThrow(/unsupported schemaVersion 2/);
    // The in-page check (measureViaHook's own script) and the Node-side check (assertHookVersion, above) share the
    // same wording: both build it from measure.ts's UNSUPPORTED_PREFIX/UNSUPPORTED_SUFFIX, not a re-typed copy.
    await expect(measureViaHook(pageOn(window), 2, 2000)).rejects.toThrow(/upgrade threeforge in the app \(exposeToAgents\)/);
  });
});
