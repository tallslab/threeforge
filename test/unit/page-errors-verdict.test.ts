import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeAssetWithShots } from '../../src/cli/analyze.js';
import { parseArgs } from '../../src/cli/args.js';
import type { BrowserHandle, PlaywrightPage } from '../../src/cli/browser.js';
import { judgeOptimize } from '../../src/cli/optimize.js';
import type { AgentDocument, AnalyzeInput, AssetFacts, AssetStats, OptimizeVerify } from '../../src/cli/types.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';

/** Page errors (uncaught exceptions in the harness page) fail `analyze` and `optimize` verdicts; `inspect` only logs them. */
const env = { three: '186', backend: 'webgl2' as const, multiDraw: true, tier: 'phone-low' as const, gpu: 'x', dpr: 1, viewport: [800, 600] as [number, number] };
const asset: AssetFacts = { meshes: 1, materials: 1, vertices: 3, triangles: 1, animations: 0, skinned: 0, morph: 0, loadMs: 1 };

/** A harness page that loads and measures cleanly but raises `messages` as uncaught page errors. */
function pageRaising(messages: string[]): PlaywrightPage {
  const page = {
    goto: async () => null,
    waitForFunction: async () => true,
    evaluate: async (expression: unknown) => (String(expression).includes('__threeforgeCli') ? { ready: true, asset } : { snapshot: emptyFrame(env), renderMs: 1, frameMs: 16 }),
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
      writeFileSync(file, 'glb');
      const command = parseArgs(['analyze', file, '--no-compile']);
      if (command.name !== 'analyze') throw new Error(`parsed as ${command.name}`);
      const run = async (messages: string[]) => {
        const launch = async (): Promise<BrowserHandle> => ({ newPage: async () => pageRaising(messages), close: async () => {} });
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

const stats: AssetStats = { nodes: 1, meshes: 1, primitives: 1, materials: 1, textures: 0, textureBytes: 0, accessors: 1, vertices: 3, triangles: 1, bytes: 10, animations: 0, skins: 0, morphTargets: 0, extensions: [] };

function analyzed(): AgentDocument {
  const frame = emptyFrame(env);
  return { schemaVersion: 1, tool: 'threeforge', version: 'test', command: 'analyze', input: {} as AnalyzeInput, env, asset, before: frame, after: frame, compile: null, parity: null, hints: [], verdict: { pass: true, budget: null, errors: [], reasons: [] }, timings: { totalMs: 1 } };
}

const verify = (): OptimizeVerify => ({
  backend: 'webgl2',
  parity: { diffPct: 0, threshold: 0.5, pass: true, views: [] },
  original: analyzed(),
  optimized: analyzed(),
  delta: { bytes: 0, materials: 0, vertices: 0, triangles: 0, sceneSubmissions: { naive: 0, compiled: 0 }, loadMs: 0, memoryBytes: 0 },
});

describe('page errors fail the optimize verdict', () => {
  it('passes when neither render raised a page error', () => {
    expect(judgeOptimize(stats, stats, verify(), null, { original: [], optimized: [] })).toEqual({ pass: true, budget: null, errors: [], reasons: [] });
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
