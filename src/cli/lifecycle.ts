import type { BrowserHandle } from './browser.js';
import { PageError } from './errors.js';
import type { StaticRoot } from './server.js';
import type { Backend } from './types.js';

/** How long each resource may take to close before the stack moves on. */
export const CLOSE_TIMEOUT_MS = 5_000;

/** How long a finished command may keep the process alive before it exits anyway. */
export const EXIT_WATCHDOG_MS = 5_000;

/** Node's setTimeout limit; longer delays fire immediately. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * Settle with `work`, or reject with `PageError("<what> timed out after <ms> ms")` once `ms` passed. The timer is
 * always cleared. `ms <= 0` sets no deadline, as in Playwright. A function is called here, so a synchronous throw
 * becomes the rejection.
 */
export async function withTimeout<T>(what: string, ms: number, work: PromiseLike<T> | (() => PromiseLike<T>)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = Promise.resolve(typeof work === 'function' ? work() : work);
    if (!(ms > 0)) return await pending;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PageError(`${what} timed out after ${ms} ms`)), Math.min(ms, MAX_DELAY_MS));
    });
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a command opened (static server, browser, page), closed newest first. Each close is bounded by the close
 * timeout, and a failing close does not stop the ones after it.
 */
export class Resources {
  private readonly stack: Array<{ what: string; close: () => unknown }> = [];
  /** The signal `armAbort` was given, so `add` can tell that the call was already aborted. */
  private signal: AbortSignal | undefined;

  constructor(private readonly closeTimeoutMs = CLOSE_TIMEOUT_MS) {}

  /**
   * Register `close` for `what` (e.g. `'the browser'`) right after opening it. If the armed signal has already aborted
   * — the MCP client disconnected while this resource was still opening, after `armAbort` had closed everything
   * registered so far — nothing would ever close it: it is closed at once (bounded, errors ignored) and a
   * `PageError` stops the caller before it uses it.
   */
  add(what: string, close: () => unknown): void {
    if (this.signal?.aborted) {
      void withTimeout(`closing ${what}`, this.closeTimeoutMs, async () => close()).catch(() => {});
      throw new PageError(`aborted: ${what} was closed as soon as it opened`);
    }
    this.stack.push({ what, close });
  }

  /** Close everything registered so far, newest first. Never rejects: resolves with the errors. A second call closes nothing twice. */
  async close(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (let entry = this.stack.pop(); entry; entry = this.stack.pop()) {
      const { what, close } = entry;
      try {
        await withTimeout(`closing ${what}`, this.closeTimeoutMs, async () => close());
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  /**
   * If `signal` later aborts, closes everything registered so far (newest first), same as `close()` — so a caller
   * whose work is stuck (e.g. a page that never resolves) still has its browser/server torn down promptly instead
   * of running to completion after nobody is listening for the result. A no-op when `signal` is undefined; closes
   * immediately when `signal` is already aborted at call time. A resource `add`ed after the abort is closed at once
   * (see `add`). Call once, right after construction, before `run`.
   */
  armAbort(signal?: AbortSignal): void {
    if (!signal) return;
    this.signal = signal;
    if (signal.aborted) {
      void this.close();
      return;
    }
    signal.addEventListener('abort', () => void this.close(), { once: true });
  }

  /** Run `work`, then close everything. The work's error always wins; after a successful run the first close error is thrown. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await work();
    } catch (error) {
      await this.close();
      throw error;
    }
    const errors = await this.close();
    if (errors.length > 0) throw errors[0];
    return result;
  }
}

/** Injection points for the browser commands (tests use them to fail a launch or stall a page). */
export interface CliDeps {
  /** Browser launcher (default `launchBrowser`). */
  launch?: (backend: Backend, headed: boolean) => Promise<BrowserHandle>;
  /** Static file server (default `serveStatic`). */
  serve?: (roots: StaticRoot[]) => Promise<{ url: string; close(): Promise<void> }>;
  /** Directory of the harness page `analyze` serves (default `dist/cli-app` next to the CLI). */
  appDir?: string;
  /** Aborting closes the call's `Resources` (browser/server) and lets it reject promptly instead of running to
   *  completion. `serveMcp` passes one shared signal into every run so a client disconnecting mid-call cancels it. */
  signal?: AbortSignal;
}

/**
 * Call after a command finished and set `process.exitCode`: waits until stdout and stderr flushed, then arms an
 * unref'd timer that exits if something (a socket, a child process) still holds the event loop after `ms`. A process
 * that drains on its own exits first and the timer never fires.
 */
export async function armExitWatchdog(ms = EXIT_WATCHDOG_MS, exit: () => void = () => process.exit()): Promise<ReturnType<typeof setTimeout>> {
  await flushed(process.stdout);
  await flushed(process.stderr);
  const timer = setTimeout(exit, ms);
  timer.unref();
  return timer;
}

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((done) => {
    if (stream.destroyed || !stream.writable) done();
    else stream.write('', () => done());
  });
}
