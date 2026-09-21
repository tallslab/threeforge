/**
 * The decoder files `threeforge decoders` copies, served to the harness page the ways a host serves them: whole,
 * or with one file answered 404 (a static host) or with a page (a dev server with an SPA fallback, Vite's default).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import { test } from './fixtures.js';

/** Copies the packaged decoders into a temporary directory for the spec that calls this; returns where. */
export function packagedDecoders(): () => string {
  let dir = '';
  test.beforeAll(() => {
    if (!existsSync('dist/cli/index.js')) execFileSync('pnpm', ['build'], { stdio: 'inherit' });
    dir = mkdtempSync(join(tmpdir(), 'forge-decoders-'));
    execFileSync('node', ['dist/cli/index.js', 'decoders', dir]);
  });
  test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return () => dir;
}

/** Serves the files of `directory` under `/<prefix>/`. */
export async function serveModels(page: Page, prefix: string, directory: string): Promise<void> {
  await page.route(`**/${prefix}/*`, (route) =>
    route.fulfill({ path: join(directory, basename(new URL(route.request().url()).pathname)) }),
  );
}

/** Serves the packaged decoders under `/_packaged/`. */
export async function servePackaged(page: Page, decoders: string): Promise<void> {
  await page.route('**/_packaged/**', (route) => {
    const file = join(decoders, new URL(route.request().url()).pathname.split('/_packaged/')[1]!);
    return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: 'not found' });
  });
}

/** Serves the packaged decoders under `/_partial/` with one file taken away, answered 404 or with a page. */
export async function serveWithout(page: Page, decoders: string, file: string, how: '404' | 'html'): Promise<void> {
  await page.route('**/_partial/**', (route) => {
    const path = new URL(route.request().url()).pathname.split('/_partial/')[1]!;
    if (!path.endsWith(file)) return route.fulfill({ path: join(decoders, path) });
    return how === '404'
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title>' });
  });
}

/** Loads the models at `urls` through ONE loader with its decoders under `decoders`, all at once or one by one. */
export function loadThrough(page: Page, urls: string[], together: boolean, decoders = '/_partial/'): Promise<string[]> {
  return page.evaluate(
    async ({ urls, together, decoders }) => {
      const f = window.__forge;
      const loader = await f.createLoader(f.renderer, { decoders });
      const outcome = (url: string): Promise<string> => {
        const settled = loader.loadAsync(url).then(
          (gltf) => {
            let maps = 0;
            let triangles = 0;
            gltf.scene.traverse((o) => {
              const mesh = o as InstanceType<typeof f.three.Mesh>;
              if (!mesh.isMesh) return;
              if ((mesh.material as { map?: unknown }).map) maps++;
              triangles += mesh.geometry.index!.count / 3;
            });
            return `loaded with ${maps} colour maps and ${triangles} triangles`;
          },
          (error: Error) => `rejected: ${error.message}`,
        );
        const hung = new Promise<string>((resolve) => setTimeout(() => resolve('never settled'), 15_000));
        return Promise.race([settled, hung]);
      };
      if (together) return Promise.all(urls.map(outcome));
      const outcomes: string[] = [];
      for (const url of urls) outcomes.push(await outcome(url));
      return outcomes;
    },
    { urls, together, decoders },
  );
}
