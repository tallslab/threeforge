import { describe, expect, it } from 'vitest';
import type { BrowserHandle, PlaywrightPage } from '../../src/cli/browser.js';
import { buildDocument, compileAndRemeasure, openPage } from '../../src/cli/document.js';
import { PageError, UsageError } from '../../src/cli/errors.js';
import { Resources } from '../../src/cli/lifecycle.js';
import { DOCUMENT_SCHEMA_VERSION } from '../../src/cli/schema.js';
import type { AgentDocument, AnalyzeInput, CliCompileReport, InspectInput } from '../../src/cli/types.js';
import { verdictOf } from '../../src/cli/verdict.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';
import { VERSION } from '../../src/version.js';

const env = {
  three: '186',
  backend: 'webgl2' as const,
  multiDraw: true,
  tier: 'desktop' as const,
  gpu: 'x',
  dpr: 1,
  viewport: [800, 600] as [number, number],
};

const analyzeInput: AnalyzeInput = {
  file: 'a.glb',
  backend: 'webgl2',
  tier: 'auto',
  budget: 1,
  frames: 2,
  compile: true,
  bake: 'off',
  views: 0,
  parity: 0.5,
  timeout: 1000,
  headed: false,
};

const inspectInput: InspectInput = {
  url: 'http://127.0.0.1:9/',
  backend: 'webgl2',
  tier: 'auto',
  budget: null,
  frames: 2,
  compile: false,
  timeout: 1000,
  headed: false,
};

/** The 14 keys in the order `analyze` and `inspect` have always printed them (`cli-core.test.ts` pins the schema to it). */
const DOC_KEYS = [
  'schemaVersion',
  'tool',
  'version',
  'command',
  'input',
  'env',
  'asset',
  'before',
  'after',
  'compile',
  'parity',
  'hints',
  'verdict',
  'timings',
];

describe('buildDocument', () => {
  it('matches the literal analyze and inspect used to build, byte for byte', () => {
    const before = emptyFrame(env);
    const after = emptyFrame(env);
    after.totals.sceneSubmissions = 5;
    after.hints = [{ category: 'drawCalls', severity: 'warn', code: 'X', message: 'm', objects: [] }];
    const parity = { diffPct: 0, threshold: 0.5, pass: true, views: [] };
    const started = Date.now() - 5;
    const pageErrors = ['boom'];
    const doc = buildDocument({
      command: 'analyze',
      input: analyzeInput,
      asset: null,
      before,
      after,
      compile: null,
      parity,
      pageErrors,
      started,
    });
    const literal: AgentDocument = {
      schemaVersion: 2,
      tool: 'threeforge',
      version: VERSION,
      command: 'analyze',
      input: analyzeInput,
      env: before.env,
      asset: null,
      before,
      after,
      compile: null,
      parity,
      hints: after.hints,
      verdict: verdictOf(after, before, analyzeInput.budget, parity, pageErrors),
      timings: { totalMs: doc.timings.totalMs },
    };
    expect(Object.keys(doc)).toEqual(DOC_KEYS);
    expect(JSON.stringify(doc, null, 2)).toBe(JSON.stringify(literal, null, 2));
    expect(doc.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(doc.verdict.pass).toBe(false);
    expect(doc.verdict.reasons).toEqual(['5 scene submissions over the budget of 1', '1 page error: boom']);
    expect(doc.timings.totalMs).toBeGreaterThanOrEqual(5);
  });

  it('an inspect document: hints and the verdict come from `before` when nothing compiled, and page errors are not judged', () => {
    const before = emptyFrame(env);
    before.hints = [{ category: 'js', severity: 'error', code: 'E', message: 'm', objects: [] }];
    const doc = buildDocument({
      command: 'inspect',
      input: inspectInput,
      asset: null,
      before,
      after: null,
      compile: null,
      parity: null,
      started: Date.now(),
    });
    expect(Object.keys(doc)).toEqual(DOC_KEYS);
    expect(doc.command).toBe('inspect');
    expect(doc.hints).toBe(before.hints);
    expect(doc.verdict).toEqual(verdictOf(null, before, null, null));
    expect(doc.verdict.reasons).toEqual(['error hint E']);
  });
});

function fakePage(overrides: Partial<PlaywrightPage> = {}): PlaywrightPage & { listeners: Record<string, unknown[]> } {
  const listeners: Record<string, unknown[]> = {};
  return {
    listeners,
    goto: async () => undefined,
    waitForFunction: async () => true,
    evaluate: async () => undefined as never,
    screenshot: async () => Buffer.alloc(0),
    route: async () => undefined,
    on: ((event: string, handler: unknown) => {
      (listeners[event] ??= []).push(handler);
    }) as PlaywrightPage['on'],
    close: async () => undefined,
    ...overrides,
  };
}

describe('openPage', () => {
  it('launches through deps, registers the browser on the resources, and collects page errors', async () => {
    const page = fakePage();
    let closed = 0;
    const launched: Array<[string, boolean]> = [];
    const launch = async (backend: string, headed: boolean): Promise<BrowserHandle> => {
      launched.push([backend, headed]);
      return { newPage: async () => page, close: async () => void closed++ };
    };
    const resources = new Resources();
    const opened = await resources.run(async () => {
      const opened = await openPage(resources, { backend: 'webgpu', headed: true, timeout: 1000 }, { launch });
      (opened.page as typeof page).listeners.pageerror!.forEach((fn) => (fn as (e: Error) => void)(new Error('boom')));
      return opened;
    });
    expect(launched).toEqual([['webgpu', true]]);
    expect(opened.page).toBe(page);
    expect(opened.pageErrors).toEqual(['boom']);
    expect(closed, 'resources.run closed the browser it registered').toBe(1);
  });

  it('bounds newPage() by the timeout, so a browser that never answers is a PageError', async () => {
    const launch = async (): Promise<BrowserHandle> => ({
      newPage: () => new Promise<PlaywrightPage>(() => {}),
      close: async () => {},
    });
    const resources = new Resources();
    const error = await resources
      .run(() => openPage(resources, { backend: 'webgl2', headed: false, timeout: 20 }, { launch }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PageError);
    expect((error as Error).message).toMatch(/opening a browser page/);
    expect(error).not.toBeInstanceOf(UsageError);
  });
});

describe('compileAndRemeasure', () => {
  it('compiles through the hook, logs the counts, renders three frames and measures again', async () => {
    const report: CliCompileReport = {
      after: { batches: 2, instanced: 1, baked: 3, spriteBatches: 0, frozen: 0, meshes: 0 },
      before: { meshes: 6, materials: 2, drawCalls: 6 },
      skipped: [],
      groups: [],
      skippedCount: 7,
      groupCount: 0,
      bake: {
        groups: 1,
        inputTriangles: 10,
        triangles: 8,
        contactFaces: 1,
        duplicateFaces: 1,
        buriedFaces: 0,
        keptCoincidentFaces: 0,
        keptDuplicateFaces: 0,
        weldedVertices: 2,
        unbakeableEntries: 0,
      },
    } as unknown as CliCompileReport;
    const after = emptyFrame(env);
    after.totals.sceneSubmissions = 3;
    const evaluated: string[] = [];
    const page = fakePage({
      evaluate: (async (expression: string) => {
        evaluated.push(expression);
        if (expression.includes('.compile()')) return report;
        if (expression.includes('hook.frameAsync')) return { snapshot: after, renderMs: 1, ledgerMs: 1, frameMs: 1 };
        return undefined;
      }) as PlaywrightPage['evaluate'],
    });
    const log: string[] = [];
    const result = await compileAndRemeasure(page, { frames: 2, timeout: 1000 }, (line) => log.push(line));
    expect(result.compile).toEqual(report);
    expect(result.after.totals.sceneSubmissions).toBe(3);
    expect(log[0]).toBe('compiled: 2 batches, 1 instanced, 3 baked, 7 skipped; measuring again');
    expect(log[1]).toMatch(/^bake: 10 -> 8 triangles/);
    expect(log).toHaveLength(2);
    // compile, then the three settling frames, then the measurement
    expect(
      evaluated.map((e) => (e.includes('.compile()') ? 'compile' : e.includes('i < 3') ? 'settle' : 'measure')),
    ).toEqual(['compile', 'settle', 'measure']);
  });
});
