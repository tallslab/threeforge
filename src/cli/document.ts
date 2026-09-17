import type { BakeSummary } from '../compiler/World.js';
import type { FrameSnapshot } from '../ledger/snapshot.js';
import { VERSION } from '../version.js';
import { launchBrowser, type PlaywrightPage } from './browser.js';
import { type CliDeps, type Resources, withTimeout } from './lifecycle.js';
import { compileViaHook, evaluateWithin, measureViaHook } from './measure.js';
import { DOCUMENT_SCHEMA_VERSION } from './schema.js';
import type { AgentDocument, AnalyzeInput, AssetFacts, CliCompileReport, InspectInput, Parity } from './types.js';
import { verdictOf } from './verdict.js';

/** What `analyze` and `inspect` share of their inputs: enough to open a page and to measure through the hook. */
type PageInput = Pick<AnalyzeInput & InspectInput, 'backend' | 'headed' | 'timeout'>;
type MeasureInput = Pick<AnalyzeInput & InspectInput, 'frames' | 'timeout'>;

export interface OpenedPage {
  page: PlaywrightPage;
  /** Uncaught exceptions the page raised so far, as raw page text; grows while the page runs. */
  pageErrors: string[];
}

/**
 * Launches the browser (through `deps.launch` in tests), registers it on `resources` so the run closes it, opens one
 * page bounded by `input.timeout` (an unbounded `newPage()` is a wait `--timeout` cannot shorten), and collects the
 * page's uncaught exceptions.
 */
export async function openPage(resources: Resources, input: PageInput, deps: CliDeps): Promise<OpenedPage> {
  const browser = await (deps.launch ?? launchBrowser)(input.backend, input.headed);
  resources.add('the browser', () => browser.close());
  const page = await withTimeout('opening a browser page', input.timeout, () => browser.newPage());
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return { page, pageErrors };
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

/**
 * Compiles through `window.__threeforge.compile()`, logs what it did, renders three frames so the batched scene settles
 * (culling, sorting, shadow maps), then measures `input.frames` frames again: the `after` snapshot of the document.
 */
export async function compileAndRemeasure(
  page: PlaywrightPage,
  input: MeasureInput,
  log: (line: string) => void,
): Promise<{ compile: CliCompileReport; after: FrameSnapshot }> {
  const compile = await compileViaHook(page, input.timeout);
  log(
    `compiled: ${compile.after.batches} batches, ${compile.after.instanced} instanced, ${compile.after.baked} baked, ${compile.skippedCount} skipped; measuring again`,
  );
  if (compile.bake) log(bakeProgressLine(compile.bake));
  await evaluateWithin(
    page,
    'rendering 3 frames after compile',
    input.timeout,
    `(async () => { for (let i = 0; i < 3; i++) await window.__threeforge.frameAsync(); })()`,
  );
  const after = (await measureViaHook(page, input.frames, input.timeout)).snapshot;
  return { compile, after };
}

export interface DocumentParts {
  command: AgentDocument['command'];
  input: AgentDocument['input'];
  asset: AssetFacts | null;
  before: FrameSnapshot;
  after: FrameSnapshot | null;
  compile: CliCompileReport | null;
  parity: Parity | null;
  /** Judged by the verdict (`analyze`); `inspect` passes none, its page being the user's own app. */
  pageErrors?: readonly string[];
  /** `Date.now()` when the command started, for `timings.totalMs`. */
  started: number;
}

/**
 * The one document `analyze` and `inspect` print, keys in the order `ANALYZE_SCHEMA`/`INSPECT_SCHEMA` declare them.
 * Hints and the verdict read the compiled frame when there is one, else the naive frame.
 */
export function buildDocument(parts: DocumentParts): AgentDocument {
  const { command, input, asset, before, after, compile, parity, pageErrors, started } = parts;
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    tool: 'threeforge',
    version: VERSION,
    command,
    input,
    env: before.env,
    asset,
    before,
    after,
    compile,
    parity,
    hints: (after ?? before).hints,
    verdict: verdictOf(after, before, input.budget, parity, pageErrors),
    timings: { totalMs: Date.now() - started },
  };
}
