import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import type { CompileReport } from '../compiler/World.js';
import { VERSION } from '../version.js';
import { launchBrowser, type PlaywrightPage } from './browser.js';
import { PageError, UsageError } from './errors.js';
import { Resources, type CliDeps } from './lifecycle.js';
import { evaluateWithin, measureViaHook, waitFor } from './measure.js';
import { serveStatic } from './server.js';
import type { AgentDocument, AnalyzeInput, AssetFacts, Parity } from './types.js';
import { formatPageErrors } from './untrusted.js';
import { verdictOf } from './verdict.js';

const PARITY_THRESHOLD = 0.5;

/** The shipped harness page lives next to this module's directory: dist/cli/analyze.js -> dist/cli-app. */
function cliAppDir(): string {
  const dir = fileURLToPath(new URL('../cli-app/', import.meta.url));
  if (!existsSync(dir)) throw new PageError(`the harness page is missing at ${dir}; reinstall threeforge or run pnpm build in the repository`);
  return dir;
}

export function pixelDiffPct(a: Buffer, b: Buffer): number {
  const pa = pngjs.PNG.sync.read(a);
  const pb = pngjs.PNG.sync.read(b);
  const n = Math.min(pa.width * pa.height, pb.width * pb.height);
  let differing = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(pa.data[o]! - pb.data[o]!), Math.abs(pa.data[o + 1]! - pb.data[o + 1]!), Math.abs(pa.data[o + 2]! - pb.data[o + 2]!));
    if (d > 24) differing++;
  }
  return (100 * differing) / Math.max(1, n);
}

/** Screenshots of the default framing plus `views` orbit views (the page's `setView`), then back to the default. */
async function captureViews(page: PlaywrightPage, views: number, timeout: number): Promise<Array<{ view: string; png: Buffer }>> {
  const shots: Array<{ view: string; png: Buffer }> = [];
  for (let i = -1; i < views; i++) {
    const view = i < 0 ? 'default' : `orbit-${i}`;
    await evaluateWithin(page, `rendering the ${view} view`, timeout, `(async () => { window.__threeforgeCli.setView(${i}, ${views}); for (let k = 0; k < 2; k++) await window.__threeforge.frameAsync(); })()`);
    shots.push({ view, png: await page.screenshot({ type: 'png' }) });
  }
  if (views > 0) await evaluateWithin(page, 'restoring the default view', timeout, `(async () => { window.__threeforgeCli.setView(-1, ${views}); await window.__threeforge.frameAsync(); })()`);
  return shots;
}

async function waitReady(page: PlaywrightPage, timeout: number): Promise<AssetFacts> {
  await waitFor(page, `!!(window.__threeforgeCli && (window.__threeforgeCli.ready === true || typeof window.__threeforgeCli.error === 'string'))`, timeout, 'the harness page did not become ready');
  const facts = await evaluateWithin<{ ready: boolean; error?: string; asset?: AssetFacts }>(page, 'reading the harness state', timeout, `window.__threeforgeCli`);
  if (!facts.ready || !facts.asset) throw new PageError(`harness failed: ${facts.error ?? 'unknown error'}`);
  return facts.asset;
}

export interface AnalysisWithShots {
  doc: AgentDocument;
  /** PNGs of the naive render: `default` plus `orbit-<i>` for each extra view (empty unless requested or compiled). */
  shots: Array<{ view: string; png: Buffer }>;
  /** Uncaught exceptions the harness page raised, as raw page text (`doc.verdict` already quotes them cleaned). */
  pageErrors: string[];
}

/** `analyzeAsset` plus the screenshots it took before compiling, so `optimize` can compare two files. */
export async function analyzeAssetWithShots(input: AnalyzeInput, log: (line: string) => void = () => {}, wantShots = false, deps: CliDeps = {}): Promise<AnalysisWithShots> {
  const started = Date.now();
  const file = resolve(input.file);
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`file not found: ${input.file}`);
  const resources = new Resources();
  resources.armAbort(deps.signal);
  return resources.run(async () => {
    // The server is on the stack before the launch, so a missing browser does not leave it listening.
    const server = await (deps.serve ?? serveStatic)([
      { prefix: '/', dir: deps.appDir ?? cliAppDir() },
      { prefix: '/asset/', dir: dirname(file) },
    ]);
    resources.add('the static server', () => server.close());
    const browser = await (deps.launch ?? launchBrowser)(input.backend, input.headed);
    resources.add('the browser', () => browser.close());
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const q = new URLSearchParams({ file: `/asset/${basename(file)}`, backend: input.backend, tier: input.tier, ...(input.bake === 'off' ? {} : { bake: input.bake === 'buried' ? 'buried' : '1' }) });
    log(`opening ${basename(file)} on ${input.backend}`);
    await page.goto(`${server.url}/?${q.toString()}`, { timeout: input.timeout, waitUntil: 'domcontentloaded' });
    const asset = await waitReady(page, input.timeout);
    log(`loaded: ${asset.meshes} meshes, ${asset.triangles} triangles; measuring ${input.frames} frames`);
    const before = await measureViaHook(page, input.frames, input.timeout);
    const shotsBefore = input.compile || wantShots ? await captureViews(page, input.views, input.timeout) : [];
    let after: AgentDocument['after'] = null;
    let compile: CompileReport | null = null;
    let parity: Parity | null = null;
    if (input.compile) {
      compile = await evaluateWithin<CompileReport>(page, 'compiling', input.timeout, `window.__threeforge.compile()`);
      log(`compiled: ${compile.after.batches} batches, ${compile.after.instanced} instanced, ${compile.after.baked} baked, ${compile.skipped.length} skipped; measuring again`);
      if (compile.bake) log(`bake: ${compile.bake.inputTriangles} -> ${compile.bake.triangles} triangles (${compile.bake.contactFaces} seam, ${compile.bake.duplicateFaces} duplicate, ${compile.bake.buriedFaces} buried faces removed, ${compile.bake.weldedVertices} vertices welded)`);
      await evaluateWithin(page, 'rendering 3 frames after compile', input.timeout, `(async () => { for (let i = 0; i < 3; i++) await window.__threeforge.frameAsync(); })()`);
      after = (await measureViaHook(page, input.frames, input.timeout)).snapshot;
      const shotsAfter = await captureViews(page, input.views, input.timeout);
      const views = shotsBefore.map((shot, i) => ({ view: shot.view, diffPct: Number(pixelDiffPct(shot.png, shotsAfter[i]!.png).toFixed(3)) }));
      const worst = Math.max(...views.map((v) => v.diffPct));
      parity = { diffPct: worst, threshold: PARITY_THRESHOLD, pass: worst <= PARITY_THRESHOLD, views };
      if (!parity.pass) log(`pixel parity lost: ${views.filter((v) => v.diffPct > PARITY_THRESHOLD).map((v) => `${v.view} ${v.diffPct}%`).join(', ')}`);
    }
    if (pageErrors.length) log(`page errors: ${formatPageErrors(pageErrors)}`);
    const hints = (after ?? before.snapshot).hints;
    const verdict = verdictOf(after, before.snapshot, input.budget, parity, pageErrors);
    const doc: AgentDocument = {
      schemaVersion: 1,
      tool: 'threeforge',
      version: VERSION,
      command: 'analyze',
      input,
      env: before.snapshot.env,
      asset,
      before: before.snapshot,
      after,
      compile,
      parity,
      hints,
      verdict,
      timings: { totalMs: Date.now() - started },
    };
    return { doc, shots: shotsBefore, pageErrors };
  });
}

/** `threeforge analyze <file>`: render, measure, compile, measure again, compare pixels, judge. */
export async function analyzeAsset(input: AnalyzeInput, log: (line: string) => void = () => {}, deps: CliDeps = {}): Promise<AgentDocument> {
  return (await analyzeAssetWithShots(input, log, false, deps)).doc;
}
