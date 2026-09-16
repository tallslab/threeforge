import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import type { BakeSummary } from '../compiler/World.js';
import { VERSION } from '../version.js';
import { DEFAULT_PARITY } from './args.js';
import { launchBrowser, type PlaywrightPage } from './browser.js';
import { PageError, UsageError } from './errors.js';
import { Resources, type CliDeps } from './lifecycle.js';
import { compileViaHook, evaluateWithin, measureViaHook, waitFor } from './measure.js';
import { serveStatic } from './server.js';
import type { AgentDocument, AnalyzeInput, AssetFacts, CliCompileReport, Parity } from './types.js';
import { formatPageErrors } from './untrusted.js';
import { verdictOf } from './verdict.js';

/** The shipped harness page lives next to this module's directory: dist/cli/analyze.js -> dist/cli-app. */
function cliAppDir(): string {
  const dir = fileURLToPath(new URL('../cli-app/', import.meta.url));
  if (!existsSync(dir)) throw new PageError(`the harness page is missing at ${dir}; reinstall threeforge or run pnpm build in the repository`);
  return dir;
}

/** What a view comparison found: the exact count as well as the percent the report rounds. */
export interface PixelComparison {
  /** Pixels where any of R, G, B differs by more than 24. Exact, so `0` means "no pixel moved", with no rounding. */
  changedPixels: number;
  /** Pixels compared: the image's pixels, or the larger image's when the sizes differ. */
  comparedPixels: number;
  /** `changedPixels` as a percent of `comparedPixels`, unrounded. */
  diffPct: number;
}

/**
 * Compares two PNGs pixel by pixel, counting a pixel as changed when any of R, G, B differs by more than 24.
 *
 * The count is reported beside the percent because the percent alone cannot express parity: callers round it to
 * three decimals, and at the harness's 1280x720 canvas that absorbs up to 4 changed pixels of 921,600. A `diffPct`
 * of 0 therefore means "at most 4 pixels moved", while `changedPixels === 0` means none did.
 */
export function comparePixels(a: Buffer, b: Buffer): PixelComparison {
  const pa = pngjs.PNG.sync.read(a);
  const pb = pngjs.PNG.sync.read(b);
  // Images of different sizes differ everywhere: a render that changed size is not parity, and a flat-index compare of
  // the overlap would misalign rows and pass `--parity 0`.
  if (pa.width !== pb.width || pa.height !== pb.height) {
    const larger = Math.max(pa.width * pa.height, pb.width * pb.height);
    return { changedPixels: larger, comparedPixels: larger, diffPct: 100 };
  }
  const n = pa.width * pa.height;
  let differing = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(pa.data[o]! - pb.data[o]!), Math.abs(pa.data[o + 1]! - pb.data[o + 1]!), Math.abs(pa.data[o + 2]! - pb.data[o + 2]!));
    if (d > 24) differing++;
  }
  return { changedPixels: differing, comparedPixels: n, diffPct: (100 * differing) / Math.max(1, n) };
}

export function pixelDiffPct(a: Buffer, b: Buffer): number {
  return comparePixels(a, b).diffPct;
}

/**
 * The views a parity threshold rejects. At a threshold of 0 that is every view that changed a pixel, judged on the
 * raw count; at any other threshold it is the views whose percentage exceeds it.
 */
export function failingViews(views: Parity['views'], threshold: number): Parity['views'] {
  return threshold === 0 ? views.filter((v) => v.changedPixels > 0) : views.filter((v) => v.diffPct > threshold);
}

/**
 * The parity verdict for a set of views.
 *
 * A threshold of 0 means exactly that, and is judged on `changedPixels` rather than on the percentage: `diffPct` is
 * rounded to three decimals, so at the harness's 1280x720 canvas it reads `0.000` for anything up to 4 changed
 * pixels of 921,600. Comparing the rounded percentage let `--parity 0` report `pass: true` and exit 0 while pixels
 * moved (Ruling R108) — the tool has to mean zero when it says zero, because agents act on this number. A non-zero
 * threshold is a percentage and is still compared as one.
 */
export function parityOf(views: Parity['views'], threshold: number): Parity {
  const diffPct = views.length ? Math.max(...views.map((v) => v.diffPct)) : 0;
  const pass = threshold === 0 ? views.every((v) => v.changedPixels === 0) : diffPct <= threshold;
  return { diffPct, threshold, pass, views };
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

/**
 * The progress line of a compile that baked: faces each rule removed, coincident faces the seam guard kept, duplicate
 * faces the duplicate rule kept, vertices welded, and meshes batched instead of baked (`unbakeableEntries`: a node, an
 * instance function, a subclass or a `displacementMap` in their material, or an attribute the bake drops). A report from
 * an older threeforge lacks `keptCoincidentFaces`, `keptDuplicateFaces` or `unbakeableEntries`: each prints 0.
 */
export function bakeProgressLine(bake: BakeSummary): string {
  return `bake: ${bake.inputTriangles} -> ${bake.triangles} triangles (${bake.contactFaces} seam, ${bake.duplicateFaces} duplicate, ${bake.buriedFaces} buried faces removed; ${bake.keptCoincidentFaces ?? 0} coincident and ${bake.keptDuplicateFaces ?? 0} duplicate faces kept; ${bake.weldedVertices} vertices welded; ${bake.unbakeableEntries ?? 0} meshes batched, not baked: a node, instance function, subclass or displacementMap in their material, or an attribute the bake drops)`;
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
  // `--parity` (Ruling R149), judged exactly as `optimize` judges its own: through `parityOf` and `failingViews`.
  const threshold = input.parity ?? DEFAULT_PARITY;
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
    let compile: CliCompileReport | null = null;
    let parity: Parity | null = null;
    if (input.compile) {
      compile = await compileViaHook(page, input.timeout);
      log(`compiled: ${compile.after.batches} batches, ${compile.after.instanced} instanced, ${compile.after.baked} baked, ${compile.skippedCount} skipped; measuring again`);
      if (compile.bake) log(bakeProgressLine(compile.bake));
      await evaluateWithin(page, 'rendering 3 frames after compile', input.timeout, `(async () => { for (let i = 0; i < 3; i++) await window.__threeforge.frameAsync(); })()`);
      after = (await measureViaHook(page, input.frames, input.timeout)).snapshot;
      const shotsAfter = await captureViews(page, input.views, input.timeout);
      const views = shotsBefore.map((shot, i) => {
        const diff = comparePixels(shot.png, shotsAfter[i]!.png);
        return { view: shot.view, diffPct: Number(diff.diffPct.toFixed(3)), changedPixels: diff.changedPixels };
      });
      parity = parityOf(views, threshold);
      if (!parity.pass) log(`pixel parity lost: ${failingViews(views, threshold).map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct}%)`).join(', ')}`);
    }
    if (pageErrors.length) log(`page errors: ${formatPageErrors(pageErrors)}`);
    const hints = (after ?? before.snapshot).hints;
    const verdict = verdictOf(after, before.snapshot, input.budget, parity, pageErrors);
    const doc: AgentDocument = {
      schemaVersion: 2,
      tool: 'threeforge',
      version: VERSION,
      command: 'analyze',
      input: { ...input, parity: threshold },
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
