import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { describe, expect, it } from 'vitest';
import { analyzeAssetWithShots } from '../../src/cli/analyze.js';
import { parseArgs } from '../../src/cli/args.js';
import type { BrowserHandle, PlaywrightPage } from '../../src/cli/browser.js';
import { judgeOptimize } from '../../src/cli/optimize.js';
import type { AgentDocument, AnalyzeInput, AssetFacts, AssetStats, OptimizeVerify } from '../../src/cli/types.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';
import { glbBytes } from './helpers/gltf-files.js';

/** Page errors (uncaught exceptions in the harness page) fail `analyze` and `optimize` verdicts; `inspect` only logs them. */
const env = {
  three: '186',
  backend: 'webgl2' as const,
  multiDraw: true,
  tier: 'phone-low' as const,
  gpu: 'x',
  dpr: 1,
  viewport: [800, 600] as [number, number],
};
const asset: AssetFacts = {
  meshes: 1,
  materials: 1,
  vertices: 3,
  triangles: 1,
  animations: 0,
  skinned: 0,
  morph: 0,
  loadMs: 1,
};

/** A harness page that loads and measures cleanly but raises `messages` as uncaught page errors. */
function pageRaising(messages: string[]): PlaywrightPage {
  const page = {
    goto: async () => null,
    waitForFunction: async () => true,
    evaluate: async (expression: unknown) =>
      String(expression).includes('__threeforgeCli')
        ? { ready: true, asset }
        : { snapshot: emptyFrame(env), renderMs: 1, frameMs: 16 },
    route: async () => {},
    screenshot: async () => Buffer.alloc(0),
    on: (event: string, listener: (error: Error) => void) => {
      if (event === 'pageerror') for (const message of messages) listener(new Error(message));
      return page;
    },
    close: async () => {},
  };
  return page as unknown as PlaywrightPage;
}

describe('page errors fail the analyze verdict', () => {
  it('passes a clean page, and turns page errors into one cleaned, capped verdict reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-page-errors-'));
    try {
      const file = join(dir, 'a.glb');
      writeFileSync(file, glbBytes({ asset: { version: '2.0' } }));
      const command = parseArgs(['analyze', file, '--no-compile']);
      if (command.name !== 'analyze') throw new Error(`parsed as ${command.name}`);
      const run = async (messages: string[]) => {
        const launch = async (): Promise<BrowserHandle> => ({
          newPage: async () => pageRaising(messages),
          close: async () => {},
        });
        return (await analyzeAssetWithShots(command.input, undefined, false, { launch, appDir: dir })).doc.verdict;
      };
      expect(await run([])).toEqual({ pass: true, budget: null, errors: [], reasons: [] });
      const verdict = await run(['boom', `\x1b[31m${'x'.repeat(5000)}`]);
      expect(verdict.pass).toBe(false);
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0]).toMatch(/^2 page errors: boom \| x+…$/);
      expect(verdict.reasons[0]).not.toContain('\x1b');
      expect(verdict.reasons[0]!.length).toBeLessThan(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `analyze --parity` judges compile parity through the same `parityOf` as `optimize`. The page's two
 * screenshots (before and after compile) differ in exactly one pixel of 400: 0.25 %.
 */
describe('analyze --parity judges the compile parity like optimize', () => {
  const png = (changed: boolean): Buffer => {
    const image = new pngjs.PNG({ width: 20, height: 20 });
    image.data.fill(255);
    if (changed) image.data[0] = 0;
    return pngjs.PNG.sync.write(image);
  };
  function comparingPage(shots: Buffer[]): PlaywrightPage {
    let shot = 0;
    const report = {
      after: { batches: 0, instanced: 0, baked: 0, spriteBatches: 0, frozen: 0, meshes: 0 },
      skipped: [],
      groups: [],
      bake: null,
    };
    const page = {
      goto: async () => null,
      waitForFunction: async () => true,
      evaluate: async (expression: unknown) => {
        const text = String(expression);
        if (text.includes('setView') || text.includes('rendering')) return undefined;
        if (text.includes('.compile()')) return { ...report, skippedCount: 0, groupCount: 0 };
        if (text.includes('const hook = window.__threeforge'))
          return { snapshot: emptyFrame(env), renderMs: 1, ledgerMs: 0, frameMs: 16 };
        if (text.includes('__threeforgeCli')) return { ready: true, asset };
        return undefined;
      },
      route: async () => {},
      screenshot: async () => shots[shot++]!,
      on: () => page,
      close: async () => {},
    };
    return page as unknown as PlaywrightPage;
  }
  async function analyzeWith(args: string[], shots: Buffer[]): Promise<AgentDocument> {
    const dir = mkdtempSync(join(tmpdir(), 'forge-analyze-parity-'));
    try {
      const file = join(dir, 'a.glb');
      writeFileSync(file, glbBytes({ asset: { version: '2.0' } }));
      const command = parseArgs(['analyze', file, ...args]);
      if (command.name !== 'analyze') throw new Error(`parsed as ${command.name}`);
      const launch = async (): Promise<BrowserHandle> => ({
        newPage: async () => comparingPage(shots),
        close: async () => {},
      });
      return (await analyzeAssetWithShots(command.input, undefined, false, { launch, appDir: dir })).doc;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const onePixel = [png(false), png(true)];

  it('passes one changed pixel at the default 0.5 %, and records the threshold it used', async () => {
    const doc = await analyzeWith([], onePixel);
    expect(doc.input).toMatchObject({ parity: 0.5 });
    expect(doc.parity).toMatchObject({
      threshold: 0.5,
      pass: true,
      diffPct: 0.25,
      views: [{ view: 'default', diffPct: 0.25, changedPixels: 1 }],
    });
    expect(doc.verdict.pass).toBe(true);
  });

  it('fails one changed pixel at --parity 0, judged on the raw count, with the same verdict reason as optimize', async () => {
    const doc = await analyzeWith(['--parity', '0'], onePixel);
    expect(doc.parity).toMatchObject({ threshold: 0, pass: false });
    expect(doc.verdict.pass).toBe(false);
    expect(doc.verdict.reasons).toContain('pixel parity 0.25% > 0% (1 changed pixel in the worst view)');
    expect(await analyzeWith(['--parity', '0'], [png(false), png(false)])).toMatchObject({
      parity: { threshold: 0, pass: true },
      verdict: { pass: true },
    });
  });

  /**
   * One changed pixel of 400 is 0.25 %, which a comparison of the rounded percentage also
   * rejects at 0, so the case above cannot tell raw-count semantics from the rounding defect. At the harness's 1280x720
   * canvas one pixel is 0.000109 %: `diffPct` rounds to 0 (three decimals, and `0.00` in the reason), so only a check
   * on `changedPixels` fails it.
   */
  it('fails one changed pixel of 921,600 at --parity 0, although its rounded percentage is 0', async () => {
    const large = (changed: boolean): Buffer => {
      const image = new pngjs.PNG({ width: 1280, height: 720 });
      image.data.fill(255);
      if (changed) image.data[4 * (1280 * 360 + 640)] = 0;
      return pngjs.PNG.sync.write(image);
    };
    const doc = await analyzeWith(['--parity', '0'], [large(false), large(true)]);
    expect(doc.parity).toMatchObject({
      threshold: 0,
      diffPct: 0,
      pass: false,
      views: [{ view: 'default', diffPct: 0, changedPixels: 1 }],
    });
    expect(doc.verdict.pass).toBe(false);
    expect(doc.verdict.reasons).toContain('pixel parity 0.00% > 0% (1 changed pixel in the worst view)');
  });

  it('compares a non-zero --parity as a percentage', async () => {
    expect((await analyzeWith(['--parity', '0.1'], onePixel)).parity).toMatchObject({ threshold: 0.1, pass: false });
    expect((await analyzeWith(['--parity', '0.25'], onePixel)).parity).toMatchObject({ threshold: 0.25, pass: true });
  });
});

const stats: AssetStats = {
  nodes: 1,
  meshes: 1,
  primitives: 1,
  materials: 1,
  textures: 0,
  textureBytes: 0,
  accessors: 1,
  vertices: 3,
  triangles: 1,
  bytes: 10,
  animations: 0,
  skins: 0,
  morphTargets: 0,
  extensions: [],
};

function analyzed(): AgentDocument {
  const frame = emptyFrame(env);
  return {
    schemaVersion: 2,
    tool: 'threeforge',
    version: 'test',
    command: 'analyze',
    input: {} as AnalyzeInput,
    env,
    asset,
    before: frame,
    after: frame,
    compile: null,
    parity: null,
    hints: [],
    verdict: { pass: true, budget: null, errors: [], reasons: [] },
    timings: { totalMs: 1 },
  };
}

const verify = (): OptimizeVerify => ({
  backend: 'webgl2',
  parity: { diffPct: 0, threshold: 0.5, pass: true, views: [] },
  original: analyzed(),
  optimized: analyzed(),
  delta: {
    bytes: 0,
    materials: 0,
    vertices: 0,
    triangles: 0,
    sceneSubmissions: { naive: 0, compiled: 0 },
    loadMs: 0,
    memoryBytes: 0,
  },
});

describe('page errors fail the optimize verdict', () => {
  it('passes when neither render raised a page error', () => {
    expect(judgeOptimize(stats, stats, verify(), null, { original: [], optimized: [] })).toEqual({
      pass: true,
      budget: null,
      errors: [],
      reasons: [],
    });
  });

  it('fails on a page error in either render and says which one', () => {
    const optimized = judgeOptimize(stats, stats, verify(), null, { original: [], optimized: ['boom'] });
    expect(optimized.pass).toBe(false);
    expect(optimized.reasons).toEqual(['1 page error: boom']);
    const original = judgeOptimize(stats, stats, verify(), null, { original: ['bad'], optimized: [] });
    expect(original.pass).toBe(false);
    expect(original.reasons).toEqual(['the original file raised 1 page error: bad']);
  });
});
