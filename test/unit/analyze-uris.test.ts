import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeAssetWithShots } from '../../src/cli/analyze.js';
import { parseArgs } from '../../src/cli/args.js';
import type { BrowserHandle, PlaywrightPage, PlaywrightRoute } from '../../src/cli/browser.js';
import { UsageError } from '../../src/cli/errors.js';
import type { AnalyzeInput } from '../../src/cli/types.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';
import { glbBytes } from './helpers/gltf-files.js';

/**
 * `analyze` serves the asset's directory to a headless browser and points the page at it, but
 * three r186's `LoaderUtils.resolveURL` (`node_modules/three/src/loaders/LoaderUtils.js:44`) returns an absolute
 * `http(s)://` or protocol-relative `//host/` URI *unchanged*, so `GLTFLoader` fetches it directly instead of through
 * the confined static server. An untrusted `.gltf` therefore made Chromium issue requests from this machine's network
 * (blind egress, and GET side effects against `127.0.0.1` services). These pin both layers of the fix: the URI scan
 * `optimize` already ran, and a deny-by-default route that covers a URI the scan cannot see.
 */
const env = { three: '186', backend: 'webgl2' as const, multiDraw: true, tier: 'desktop' as const, gpu: 'x', dpr: 1, viewport: [800, 600] as [number, number] };
const asset = { meshes: 1, materials: 1, vertices: 3, triangles: 1, animations: 0, skinned: 0, morph: 0, loadMs: 1 };

/** A page that loads cleanly and records the route handler `analyze` installed, so the test can drive it itself. */
function recordingPage(): PlaywrightPage & { handler(): (route: PlaywrightRoute) => unknown } {
  let handler: ((route: PlaywrightRoute) => unknown) | undefined;
  const page = {
    goto: async () => null,
    waitForFunction: async () => true,
    evaluate: async (expression: unknown) => (String(expression).includes('__threeforgeCli') ? { ready: true, asset } : { snapshot: emptyFrame(env), renderMs: 1, ledgerMs: 0, frameMs: 16 }),
    screenshot: async () => Buffer.alloc(0),
    route: async (_url: string, install: (route: PlaywrightRoute) => unknown) => {
      handler = install;
    },
    on: () => page,
    close: async () => {},
    handler: () => {
      if (!handler) throw new Error('analyze installed no route handler');
      return handler;
    },
  };
  return page as unknown as PlaywrightPage & { handler(): (route: PlaywrightRoute) => unknown };
}

/** A `Route` double: records whether the handler let the request through or aborted it. */
function fakeRoute(url: string): PlaywrightRoute & { verdict(): string } {
  let verdict = 'pending';
  return {
    request: () => ({ url: () => url }),
    continue: async () => {
      verdict = 'continue';
    },
    abort: async (code?: string) => {
      verdict = `abort:${code ?? ''}`;
    },
    verdict: () => verdict,
  };
}

function inputFor(file: string): AnalyzeInput {
  const command = parseArgs(['analyze', file, '--no-compile']);
  if (command.name !== 'analyze') throw new Error(`parsed as ${command.name}`);
  return command.input;
}

async function settle(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
}

describe('analyze refuses an asset whose resource URIs leave its directory', () => {
  const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-analyze-uris-'));
    try {
      await body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each([
    ['an absolute http:// buffer', { buffers: [{ uri: 'http://127.0.0.1:1/x.bin', byteLength: 4 }] }, /buffers\[0\]\.uri .*URI scheme/],
    ['a protocol-relative image', { images: [{ uri: '//attacker.example/beacon.png' }] }, /images\[0\]\.uri .*absolute path/],
    ['an image climbing out of the directory', { images: [{ uri: '../../../../etc/passwd' }] }, /images\[0\]\.uri .*outside/],
  ])('refuses %s before it opens a browser', async (_what, json, message) => {
    await withDir(async (dir) => {
      const file = join(dir, 'hostile.gltf');
      writeFileSync(file, JSON.stringify({ asset: { version: '2.0' }, ...json }));
      let launched = false;
      const launch = async (): Promise<BrowserHandle> => {
        launched = true;
        return { newPage: async () => recordingPage(), close: async () => {} };
      };
      const error = await settle(analyzeAssetWithShots(inputFor(file), undefined, false, { launch, appDir: dir }));
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toMatch(message);
      // A UsageError is exit code 2, the same path `optimize` already took for these inputs.
      expect(launched).toBe(false);
    });
  });

  it('accepts a relative resource URI, and a GLB whose buffer is the embedded chunk', async () => {
    await withDir(async (dir) => {
      const gltf = join(dir, 'fine.gltf');
      writeFileSync(gltf, JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'scene.bin', byteLength: 4 }], images: [{ uri: 'tex/a.png' }] }));
      const glb = join(dir, 'fine.glb');
      writeFileSync(glb, glbBytes({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }));
      for (const file of [gltf, glb]) {
        const launch = async (): Promise<BrowserHandle> => ({ newPage: async () => recordingPage(), close: async () => {} });
        const result = await analyzeAssetWithShots(inputFor(file), undefined, false, { launch, appDir: dir });
        expect(result.doc.command).toBe('analyze');
      }
    });
  });
});

describe('the analyze page may only reach the static server it was given', () => {
  it('continues a request to the served origin and aborts every other one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-analyze-route-'));
    try {
      const file = join(dir, 'a.glb');
      writeFileSync(file, glbBytes({ asset: { version: '2.0' } }));
      const page = recordingPage();
      let url = '';
      const serve = async (): Promise<{ url: string; close(): Promise<void> }> => {
        url = 'http://127.0.0.1:65123';
        return { url, close: async () => {} };
      };
      const launch = async (): Promise<BrowserHandle> => ({ newPage: async () => page, close: async () => {} });
      await analyzeAssetWithShots(inputFor(file), undefined, false, { launch, serve, appDir: dir });
      const handler = page.handler();
      const decide = async (target: string): Promise<string> => {
        const route = fakeRoute(target);
        await handler(route);
        return route.verdict();
      };
      expect(await decide(`${url}/`)).toBe('continue');
      expect(await decide(`${url}/asset/a.glb`)).toBe('continue');
      // Everything else, including a look-alike origin whose host merely starts with the served one.
      expect(await decide('http://127.0.0.1:1/x.bin')).toMatch(/^abort:/);
      expect(await decide('http://attacker.example/b?h=1')).toMatch(/^abort:/);
      expect(await decide('https://127.0.0.1:65123/asset/a.glb')).toMatch(/^abort:/);
      expect(await decide(`${url}.attacker.example/x`)).toMatch(/^abort:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
