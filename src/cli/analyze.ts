import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import type { CompileReport } from '../compiler/World.js';
import { VERSION } from '../version.js';
import { UsageError } from './args.js';
import { launchBrowser, type PlaywrightPage } from './browser.js';
import { measureViaHook, PageError, waitFor } from './measure.js';
import { serveStatic } from './server.js';
import type { AgentDocument, AnalyzeInput, AssetFacts, Parity } from './types.js';
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

async function waitReady(page: PlaywrightPage, timeout: number): Promise<AssetFacts> {
  await waitFor(page, `!!(window.__threeforgeCli && (window.__threeforgeCli.ready === true || typeof window.__threeforgeCli.error === 'string'))`, timeout, 'the harness page did not become ready');
  const facts = await page.evaluate<{ ready: boolean; error?: string; asset?: AssetFacts }>(`window.__threeforgeCli`);
  if (!facts.ready || !facts.asset) throw new PageError(`harness failed: ${facts.error ?? 'unknown error'}`);
  return facts.asset;
}

/** `threeforge analyze <file>`: render, measure, compile, measure again, compare pixels, judge. */
export async function analyzeAsset(input: AnalyzeInput, log: (line: string) => void = () => {}): Promise<AgentDocument> {
  const started = Date.now();
  const file = resolve(input.file);
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`file not found: ${input.file}`);
  const server = await serveStatic([
    { prefix: '/', dir: cliAppDir() },
    { prefix: '/asset/', dir: dirname(file) },
  ]);
  const browser = await launchBrowser(input.backend, input.headed);
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const q = new URLSearchParams({ file: `/asset/${basename(file)}`, backend: input.backend, tier: input.tier });
    log(`opening ${basename(file)} on ${input.backend}`);
    await page.goto(`${server.url}/?${q.toString()}`, { timeout: input.timeout, waitUntil: 'domcontentloaded' });
    const asset = await waitReady(page, input.timeout);
    log(`loaded: ${asset.meshes} meshes, ${asset.triangles} triangles; measuring ${input.frames} frames`);
    const before = await measureViaHook(page, input.frames);
    let after: AgentDocument['after'] = null;
    let compile: CompileReport | null = null;
    let parity: Parity | null = null;
    if (input.compile) {
      const shotBefore = await page.screenshot({ type: 'png' });
      compile = await page.evaluate<CompileReport>(`window.__threeforge.compile()`);
      log(`compiled: ${compile.after.batches} batches, ${compile.after.instanced} instanced, ${compile.skipped.length} skipped; measuring again`);
      await page.evaluate(`(async () => { for (let i = 0; i < 3; i++) await window.__threeforge.frameAsync(); })()`);
      after = (await measureViaHook(page, input.frames)).snapshot;
      const shotAfter = await page.screenshot({ type: 'png' });
      const diffPct = pixelDiffPct(shotBefore, shotAfter);
      parity = { diffPct: Number(diffPct.toFixed(3)), threshold: PARITY_THRESHOLD, pass: diffPct <= PARITY_THRESHOLD };
    }
    if (pageErrors.length) log(`page errors: ${pageErrors.join(' | ')}`);
    const hints = (after ?? before.snapshot).hints;
    const verdict = verdictOf(after, before.snapshot, input.budget, parity);
    return {
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
  } finally {
    await browser.close();
    await server.close();
  }
}
