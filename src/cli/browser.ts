import { EnvironmentError } from './errors.js';
import type { Backend } from './types.js';

export { EnvironmentError };

export interface BrowserHandle {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

/** The slice of Playwright's `Route` the CLI uses: enough to read a request's URL and let it through or refuse it. */
export interface PlaywrightRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/** The slice of Playwright's Page the CLI uses (typed structurally so the package compiles without Playwright). */
export interface PlaywrightPage {
  goto(url: string, options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown>;
  waitForFunction(
    fn: string | ((...args: never[]) => unknown),
    arg?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  evaluate<R>(fn: string | ((...args: never[]) => R | Promise<R>), arg?: unknown): Promise<R>;
  screenshot(options?: { type?: 'png'; timeout?: number }): Promise<Buffer>;
  /** Intercept matching requests. `analyze` installs one catch-all handler to confine the page to its static server. */
  route(url: string, handler: (route: PlaywrightRoute) => unknown): Promise<void>;
  on(event: 'pageerror', handler: (error: Error) => void): unknown;
  on(event: 'console', handler: (message: { type(): string; text(): string }) => void): unknown;
  close(): Promise<void>;
}

const INSTALL = 'Install the browser driver: npm i -D playwright && npx playwright install chromium';

/** Launch headless Chromium the way the test suite does: headless shell for WebGL2, full Chromium with WebGPU flags otherwise. */
export async function launchBrowser(backend: Backend, headed = false): Promise<BrowserHandle> {
  let playwright: {
    chromium: {
      launch(options: Record<string, unknown>): Promise<{ newPage(): Promise<PlaywrightPage>; close(): Promise<void> }>;
    };
  };
  try {
    playwright = (await import('playwright')) as unknown as typeof playwright;
  } catch {
    throw new EnvironmentError(`playwright is not installed. ${INSTALL}`);
  }
  const adapter = process.env.FORGE_WEBGPU ?? (process.platform === 'linux' ? 'swiftshader' : 'native');
  const options: Record<string, unknown> =
    backend === 'webgpu'
      ? {
          headless: !headed,
          ...(adapter === 'native' ? { channel: 'chromium' } : {}),
          args:
            adapter === 'native'
              ? ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
              : [
                  '--enable-features=WebGPU',
                  '--enable-unsafe-webgpu',
                  '--use-webgpu-adapter=swiftshader',
                  '--enable-unsafe-swiftshader',
                  '--ignore-gpu-blocklist',
                ],
        }
      : { headless: !headed, args: ['--ignore-gpu-blocklist'] };
  let browser: { newPage(): Promise<PlaywrightPage>; close(): Promise<void> };
  try {
    browser = await playwright.chromium.launch(options);
  } catch (error) {
    throw new EnvironmentError(
      `could not launch Chromium (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). ${INSTALL}`,
    );
  }
  return { newPage: () => browser.newPage(), close: () => browser.close() };
}
