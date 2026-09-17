import { BoxGeometry, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { type AgentHook, exposeToAgents } from '../../src/agent/expose.js';
import type { BrowserHandle, PlaywrightPage } from '../../src/cli/browser.js';
import { PageError } from '../../src/cli/errors.js';
import { printDocument, summarize } from '../../src/cli/format.js';
import { inspectApp } from '../../src/cli/inspect.js';
import { measureViaHook } from '../../src/cli/measure.js';
import type { InspectInput } from '../../src/cli/types.js';
import { attachedLedger } from './helpers/ledger.js';

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
 * An app with 4 meshes, a ledger on an injected clock and the agent hook. Every render() call costs 3 ms (ticked from
 * `scene.onBeforeRender`, which the fake calls inside render()); each frame's filing reads the scheduler once, which
 * costs the next of `filingCosts` (so it lands in that frame's `js.ledgerMs`).
 */
function app(options: { schemaVersion?: number; filingCosts?: number[] } = {}): { window: FakeWindow } {
  let t = 0;
  const { renderer, ledger, scene, camera } = attachedLedger({ sceneHooks: true }, { now: () => t });
  scene.onBeforeRender = () => {
    t += 3;
  };
  const costs = [...(options.filingCosts ?? [])];
  ledger.attachScheduler({
    skippedRecently: () => {
      t += costs.shift() ?? 0;
      return 0;
    },
  });
  for (let i = 0; i < 4; i++) scene.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  const window: FakeWindow = {};
  exposeToAgents({
    ledger,
    renderer: renderer as never,
    scene,
    camera,
    target: window,
    requestFrame: (callback) => callback(),
  });
  delete window.__threeforge!.measureOverdraw; // the fake renderer cannot run the overdraw count renders
  if (options.schemaVersion !== undefined)
    (window.__threeforge as unknown as { schemaVersion: number }).schemaVersion = options.schemaVersion;
  return { window };
}

const input = (overrides: Partial<InspectInput> = {}): InspectInput => ({
  url: 'http://127.0.0.1:9/',
  backend: 'webgl2',
  tier: 'auto',
  budget: null,
  frames: 3,
  compile: true,
  timeout: 2000,
  headed: false,
  ...overrides,
});
const launchOn = (page: PlaywrightPage) => async (): Promise<BrowserHandle> => ({
  newPage: async () => page,
  close: async () => {},
});

describe('inspect and the frame snapshot schemaVersion', () => {
  it('measures a schemaVersion 3 app with median renderMs and ledgerMs', async () => {
    const { window } = app({ filingCosts: [9, 1, 1, 50] });
    expect(window.__threeforge!.schemaVersion).toBe(3);
    const doc = await inspectApp(input(), undefined, { launch: launchOn(pageOn(window)) });
    expect(doc.before.schemaVersion).toBe(3);
    expect(doc.before.totals.sceneSubmissions).toBe(4);
    expect(doc.before.js.renderMs).toBe(3);
    // The 3 measured frames filed in 9, 1 and 1 ms (median 1); the snapshot's own frame took 50.
    expect(doc.before.js.ledgerMs).toBe(1);
  });

  it('fails at once on a schemaVersion 2 app, naming its version', async () => {
    // schemaVersion 2 is what threeforge 0.8.0 exposes: nothing is measured, compiled or formatted.
    const { window } = app({ schemaVersion: 2 });
    const evaluated: string[] = [];
    const printed: string[] = [];
    const streams = {
      stdout: { write: (chunk: string) => printed.push(chunk) },
      stderr: { write: (chunk: string) => printed.push(chunk) },
    };
    const started = Date.now();
    // What `threeforge inspect` does (src/cli/index.ts): print the document inspectApp resolves with.
    const error = await inspectApp(input({ timeout: 5000 }), undefined, {
      launch: launchOn(pageOn(window, evaluated)),
    }).then(
      (doc) => printDocument(doc, summarize, true, streams),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PageError);
    expect((error as Error).message).toMatch(/unsupported schemaVersion 2/);
    // Names both versions and tells the reader what to do about it.
    expect((error as Error).message).toContain('reads schemaVersion 3');
    expect((error as Error).message).toContain('upgrade threeforge in the app (exposeToAgents)');
    expect(Date.now() - started, 'fails without waiting for the timeout').toBeLessThan(1000);
    expect(evaluated.filter((e) => e.includes('frameAsync') || e.includes('compile'))).toEqual([]);
    expect(printed).toEqual([]);
  });

  it('a page without the hook still times out naming exposeToAgents', async () => {
    const error = await inspectApp(input({ timeout: 100 }), undefined, { launch: launchOn(pageOn({})) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PageError);
    expect((error as Error).message).toMatch(/no window.__threeforge hook appeared/);
  });

  it('measureViaHook (analyze and inspect) refuses a hook exposing another schemaVersion', async () => {
    const { window } = app({ schemaVersion: 2 });
    await expect(measureViaHook(pageOn(window), 2, 2000)).rejects.toThrow(/unsupported schemaVersion 2/);
    // The in-page check (measureViaHook's own script) and the Node-side check (assertHookVersion, above) share the
    // same wording: both build it from measure.ts's UNSUPPORTED_PREFIX/UNSUPPORTED_SUFFIX, not a re-typed copy.
    await expect(measureViaHook(pageOn(window), 2, 2000)).rejects.toThrow(
      /upgrade threeforge in the app \(exposeToAgents\)/,
    );
  });
});

/**
 * `assertHookVersion` and the in-page guard above both check the *hook's* advertised version;
 * the snapshot `frameAsync()` returns was passed through untouched, so a target that advertises 3 and hands back a
 * differently-shaped frame produced a document violating the CLI's own published `SNAPSHOT_SCHEMA`
 * (`{ schemaVersion: { const: 3 } }`) with nothing to notice.
 */
describe('the returned frame carries its own schemaVersion', () => {
  /** A hook that advertises 3 and returns a frame claiming something else (or nothing). */
  function mismatched(frameVersion: unknown): FakeWindow {
    const { window } = app();
    const hook = window.__threeforge as unknown as { frameAsync(): Promise<Record<string, unknown>> };
    const real = hook.frameAsync.bind(hook);
    hook.frameAsync = async () => {
      const frame = await real();
      if (frameVersion === undefined) delete frame.schemaVersion;
      else frame.schemaVersion = frameVersion;
      return frame;
    };
    return window;
  }

  it.each([
    ['an older frame', 2],
    ['a newer frame', 4],
    ['a frame with no version at all', undefined],
    ['a version that is not a number', '3'],
  ])('refuses %s with the same upgrade message (exit 4)', async (_what, version) => {
    const window = mismatched(version);
    expect(window.__threeforge!.schemaVersion, 'the hook still advertises 3; only the frame disagrees').toBe(3);
    const error = await measureViaHook(pageOn(window), 2, 2000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PageError);
    expect((error as Error).message).toMatch(/schemaVersion/);
    expect((error as Error).message).toContain('reads schemaVersion 3');
    expect((error as Error).message).toContain('upgrade threeforge in the app (exposeToAgents)');
  });

  it('accepts the frame a current hook returns', async () => {
    const { window } = app();
    const measurement = await measureViaHook(pageOn(window), 2, 2000);
    expect(measurement.snapshot.schemaVersion).toBe(3);
  });
});
