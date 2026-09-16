import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeAssetWithShots } from '../../src/cli/analyze.js';
import { UsageError as ArgsUsageError } from '../../src/cli/args.js';
import { EnvironmentError as BrowserEnvironmentError, type BrowserHandle, type PlaywrightPage } from '../../src/cli/browser.js';
import { EnvironmentError, exitCodeFor, PageError, UsageError } from '../../src/cli/errors.js';
import { inspectApp } from '../../src/cli/inspect.js';
import { armExitWatchdog, Resources, withTimeout } from '../../src/cli/lifecycle.js';
import { PageError as MeasurePageError } from '../../src/cli/measure.js';
import { serveStatic, type StaticRoot } from '../../src/cli/server.js';
import type { AnalyzeInput, InspectInput } from '../../src/cli/types.js';

const settle = <T>(promise: Promise<T>): Promise<T | unknown> => promise.then((value) => value, (error: unknown) => error);

afterEach(() => {
  vi.useRealTimers();
});

describe('errors', () => {
  it('maps usage to 2, environment to 3, page errors and anything unexpected to 4', () => {
    expect(exitCodeFor(new UsageError('x'))).toBe(2);
    expect(exitCodeFor(new EnvironmentError('x'))).toBe(3);
    expect(exitCodeFor(new PageError('x'))).toBe(4);
    expect(exitCodeFor(new TypeError('x'))).toBe(4);
    expect(exitCodeFor('a string')).toBe(4);
  });

  it('keeps the classes importable from their old modules', () => {
    expect(ArgsUsageError).toBe(UsageError);
    expect(BrowserEnvironmentError).toBe(EnvironmentError);
    expect(MeasurePageError).toBe(PageError);
  });
});

describe('withTimeout', () => {
  it('rejects with a PageError naming the work once the time is up, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const outcome = settle(withTimeout('measuring 30 frames', 3000, new Promise(() => {})));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(PageError);
    expect((error as Error).message).toBe('measuring 30 frames timed out after 3000 ms');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the work resolves, rejects or throws synchronously', async () => {
    vi.useFakeTimers();
    await expect(withTimeout('a', 3000, Promise.resolve(7))).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
    await expect(withTimeout('b', 3000, Promise.reject(new Error('page threw')))).rejects.toThrow('page threw');
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      withTimeout('c', 3000, () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sets no deadline for a zero timeout (Playwright reads 0 as no limit)', async () => {
    vi.useFakeTimers();
    let resolve!: (value: number) => void;
    const pending = withTimeout('d', 0, new Promise<number>((ok) => (resolve = ok)));
    expect(vi.getTimerCount()).toBe(0);
    resolve(3);
    await expect(pending).resolves.toBe(3);
  });
});

describe('Resources', () => {
  it('closes newest first, bounds each close by its timeout and keeps going past a failure', async () => {
    const order: string[] = [];
    const resources = new Resources(30);
    resources.add('the static server', () => {
      order.push('server');
    });
    resources.add('the stuck browser', () => {
      order.push('browser');
      return new Promise(() => {});
    });
    resources.add('the page', async () => {
      order.push('page');
      throw new Error('page close failed');
    });
    const errors = await resources.close();
    expect(order).toEqual(['page', 'browser', 'server']);
    expect(errors.map((e) => (e as Error).message)).toEqual(['page close failed', 'closing the stuck browser timed out after 30 ms']);
    expect(await resources.close()).toEqual([]);
    expect(order).toHaveLength(3);
  });

  it('run: the work error wins over close errors, and everything is closed either way', async () => {
    const closed: string[] = [];
    const resources = new Resources(30);
    const error = await settle(
      resources.run(async () => {
        resources.add('a', () => {
          closed.push('a');
        });
        resources.add('b', () => {
          closed.push('b');
          throw new Error('close failed');
        });
        throw new EnvironmentError('no browser');
      }),
    );
    expect(error).toBeInstanceOf(EnvironmentError);
    expect(closed).toEqual(['b', 'a']);
  });

  it('run: without a work error, the first close error is thrown after everything closed', async () => {
    const closed: string[] = [];
    const resources = new Resources(30);
    const error = await settle(
      resources.run(async () => {
        resources.add('a', () => {
          closed.push('a');
        });
        resources.add('b', () => {
          closed.push('b');
          throw new Error('close failed');
        });
        return 1;
      }),
    );
    expect((error as Error).message).toBe('close failed');
    expect(closed).toEqual(['b', 'a']);
    await expect(new Resources().run(async () => 5)).resolves.toBe(5);
  });
});

/**
 * Final review area 3, F8: `armAbort` closed the stack once, when the signal fired, and `add()` did not look at the
 * signal, so a browser registered after an MCP client disconnected mid-launch was never closed and the page was
 * measured to completion with nobody listening.
 */
describe('Resources after an abort', () => {
  it('add() after the armed signal aborted closes the resource at once and throws a PageError', async () => {
    const resources = new Resources();
    const controller = new AbortController();
    resources.armAbort(controller.signal);
    controller.abort();
    let closed = 0;
    expect(() => resources.add('the browser', () => closed++)).toThrow(PageError);
    expect(() => resources.add('the page', () => closed++)).toThrow(/aborted/);
    await new Promise((ok) => setTimeout(ok, 0));
    expect(closed).toBe(2);
    expect(await resources.close()).toEqual([]);
    expect(closed).toBe(2);
  });

  it('add() before any abort, or with no signal armed, only registers', async () => {
    const armed = new Resources();
    armed.armAbort(new AbortController().signal);
    const unarmed = new Resources();
    let closed = 0;
    armed.add('a', () => closed++);
    unarmed.add('b', () => closed++);
    expect(closed).toBe(0);
    await armed.close();
    await unarmed.close();
    expect(closed).toBe(2);
  });

  it('a client that disconnects while the browser launches: analyze closes the browser it gets and never opens a page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-lifecycle-'));
    try {
      const file = join(dir, 'a.glb');
      writeFileSync(file, 'glb');
      const { serve, state } = countingServe();
      const controller = new AbortController();
      let browserClosed = 0;
      let pagesOpened = 0;
      const launch = async (): Promise<BrowserHandle> => {
        controller.abort(); // the MCP client's stdin ends while Chromium starts
        return {
          newPage: async () => {
            pagesOpened++;
            return stuckPage();
          },
          close: async () => {
            browserClosed++;
          },
        };
      };
      const error = await settle(analyzeAssetWithShots(analyzeInput(file), undefined, false, { serve, launch, appDir: dir, signal: controller.signal }));
      expect(error).toBeInstanceOf(PageError);
      expect(browserClosed).toBe(1);
      expect(pagesOpened).toBe(0);
      expect(state.closed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('armExitWatchdog', () => {
  it('arms an unref’d timer that exits once it fires', async () => {
    const exit = vi.fn();
    const timer = await armExitWatchdog(10, exit);
    expect(timer.hasRef()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    await new Promise((ok) => setTimeout(ok, 40));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

const analyzeInput = (file: string): AnalyzeInput => ({ file, backend: 'webgl2', tier: 'auto', budget: null, frames: 1, compile: false, bake: 'off', views: 0, timeout: 1000, headed: false });
const inspectInput = (timeout: number): InspectInput => ({ url: 'http://127.0.0.1:9/', backend: 'webgl2', tier: 'auto', budget: null, frames: 2, compile: true, timeout, headed: false });

/** A real static server whose close is counted, so a test can prove it stopped listening. */
function countingServe(): { serve: (roots: StaticRoot[]) => Promise<{ url: string; close(): Promise<void> }>; state: { url: string; closed: number } } {
  const state = { url: '', closed: 0 };
  return {
    state,
    serve: async (roots) => {
      const server = await serveStatic(roots);
      state.url = server.url;
      return {
        url: server.url,
        close: async () => {
          state.closed++;
          await server.close();
        },
      };
    },
  };
}

/** A page whose evaluate never settles, like a hook whose frameAsync never resolves. */
function stuckPage(): PlaywrightPage {
  const page = {
    goto: async () => null,
    waitForFunction: async () => true,
    evaluate: () => new Promise(() => {}),
    screenshot: async () => Buffer.alloc(0),
    on: () => page,
    close: async () => {},
  };
  return page as unknown as PlaywrightPage;
}

describe('analyze and inspect release what they opened', () => {
  it('a failed launch still closes the static server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-lifecycle-'));
    try {
      const file = join(dir, 'a.glb');
      writeFileSync(file, 'glb');
      const { serve, state } = countingServe();
      const launch = async (): Promise<BrowserHandle> => {
        throw new EnvironmentError('could not launch Chromium');
      };
      const error = await settle(analyzeAssetWithShots(analyzeInput(file), undefined, false, { serve, launch, appDir: dir }));
      expect(error).toBeInstanceOf(EnvironmentError);
      expect(state.closed).toBe(1);
      await expect(fetch(state.url)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a throwing browser.close() still closes the server, and the original error wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-lifecycle-'));
    try {
      const file = join(dir, 'a.glb');
      writeFileSync(file, 'glb');
      const { serve, state } = countingServe();
      const launch = async (): Promise<BrowserHandle> => ({
        newPage: async () => {
          throw new PageError('the page crashed');
        },
        close: async () => {
          throw new Error('browser close failed');
        },
      });
      const error = await settle(analyzeAssetWithShots(analyzeInput(file), undefined, false, { serve, launch, appDir: dir }));
      expect(error).toBeInstanceOf(PageError);
      expect((error as Error).message).toBe('the page crashed');
      expect(state.closed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an analyze page that never answers becomes a PageError after the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-lifecycle-'));
    try {
      const file = join(dir, 'a.glb');
      writeFileSync(file, 'glb');
      const { serve, state } = countingServe();
      let browserClosed = 0;
      const launch = async (): Promise<BrowserHandle> => ({
        newPage: async () => stuckPage(),
        close: async () => {
          browserClosed++;
        },
      });
      const error = await settle(analyzeAssetWithShots({ ...analyzeInput(file), timeout: 100 }, undefined, false, { serve, launch, appDir: dir }));
      expect(error).toBeInstanceOf(PageError);
      expect((error as Error).message).toMatch(/timed out after 100 ms/);
      expect(browserClosed).toBe(1);
      expect(state.closed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an inspect hook that never resolves becomes a PageError after the timeout, and the browser is closed', async () => {
    let browserClosed = 0;
    const launch = async (): Promise<BrowserHandle> => ({
      newPage: async () => stuckPage(),
      close: async () => {
        browserClosed++;
      },
    });
    const error = await settle(inspectApp(inspectInput(100), undefined, { launch }));
    expect(error).toBeInstanceOf(PageError);
    expect((error as Error).message).toMatch(/timed out after 100 ms/);
    expect(browserClosed).toBe(1);
  });
});
