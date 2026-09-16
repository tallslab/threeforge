import type { Document, NodeIO } from '@gltf-transform/core';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { VERSION } from '../version.js';
import { analyzeAssetWithShots, comparePixels, failingViews, parityOf } from './analyze.js';
import { EnvironmentError, UsageError } from './errors.js';
import { assertConfinedUri, assertConfinedUris, readGltfJson, resourcePathsOf, type ResourcePath } from './gltf-uris.js';
import type { CliDeps } from './lifecycle.js';
import { planSteps } from './pipeline.js';
import { applySteps, createIO, DRACO_INSTALL, loadDeps, requirementsOf, statsOf } from './transform.js';
import type { AgentDocument, AnalyzeInput, AssetStats, OptimizeDelta, OptimizeDocument, OptimizeInput, OptimizeVerify, Parity, Verdict } from './types.js';
import { cleanText } from './untrusted.js';
import { pageErrorsReason, verdictOf } from './verdict.js';

/** `scene.glb` → `scene.forge.glb` next to it; `.gltf` inputs still default to a single `.glb`. */
export function defaultOutputPath(file: string): string {
  const ext = extname(file);
  return join(dirname(file), `${basename(file, ext)}.forge.glb`);
}

/** The page errors each verified render raised. The document does not carry them; the verdict quotes them cleaned. */
export interface VerifyPageErrors {
  original: string[];
  optimized: string[];
}

/** Both paths name one file: the same resolved path, or the same device and inode (a hard link, a symlink, a case variant on a case-insensitive filesystem). */
function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    const statA = statSync(a, { bigint: true, throwIfNoEntry: false });
    if (!statA || statA.ino === 0n) return false;
    const statB = statSync(b, { bigint: true });
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

/** `threeforge optimize <file>`: transform with glTF-Transform, write, verify by rendering both files, judge. */
export async function optimizeAsset(input: OptimizeInput, log: (line: string) => void = () => {}, cliDeps: CliDeps = {}): Promise<OptimizeDocument> {
  const started = Date.now();
  const file = resolve(input.file);
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`file not found: ${input.file}`);
  const out = resolve(input.out ?? defaultOutputPath(file));
  if (!/\.(glb|gltf)$/i.test(out)) throw new UsageError(`--out must end in .glb or .gltf (got ${input.out ?? out})`);
  if (sameFile(out, file)) throw new UsageError('--out must not be the input file');
  const steps = planSteps(input);
  // glTF-Transform reads every external image and buffer wherever its URI points; refuse the file before it does.
  const inputJson = readGltfJson(file);
  assertConfinedUris(inputJson, dirname(file));
  // A .gltf input is its JSON plus these files: nothing this run writes may land on one of them.
  const inputFiles: InputFiles = { file, resources: resourcePathsOf(inputJson, dirname(file)) };
  const named = inputFiles.resources.find((resource) => sameFile(out, resource.path));
  if (named) throw new UsageError(`--out would overwrite the input's ${named.where} ${JSON.stringify(cleanText(named.uri, 200))}`);
  const deps = await loadDeps(steps, input.textures !== null && input.textures !== 'none');
  const io = await createIO(deps);
  const { Logger } = await import('@gltf-transform/core');
  const silent = new Logger(Logger.Verbosity.SILENT);
  io.setLogger(silent);
  let doc;
  try {
    doc = await io.read(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/draco/i.test(message)) throw new EnvironmentError(`reading a Draco-compressed input needs draco3dgltf: ${DRACO_INSTALL}`);
    throw new UsageError(`cannot read ${input.file}: ${message}`);
  }
  doc.setLogger(silent);
  const before = statsOf(doc, statSync(file).size);
  log(`${basename(file)}: ${before.meshes} meshes, ${before.materials} materials, ${before.triangles} triangles, ${before.bytes} bytes; ${steps.map((s) => s.name).join(' → ') || 'no steps'}`);
  const transformStarted = Date.now();
  const stepReports = await applySteps(doc, steps, deps, log);
  await writeOutput(io, out, doc, inputFiles, input.overwrite);
  const transformMs = Date.now() - transformStarted;
  const after = statsOf(doc, statSync(out).size);
  const requires = requirementsOf(after.extensions);
  log(`wrote ${out}: ${after.bytes} bytes (${((100 * after.bytes) / Math.max(1, before.bytes)).toFixed(0)} % of the input)`);
  const verifyStarted = Date.now();
  const verified = input.verify ? await verifyPair(file, out, input, log, cliDeps) : null;
  const verifyMs = input.verify ? Date.now() - verifyStarted : 0;
  const verify = verified?.verify ?? null;
  const verdict = judgeOptimize(before, after, verify, input.budget, verified?.pageErrors);
  return {
    schemaVersion: 2,
    tool: 'threeforge',
    version: VERSION,
    command: 'optimize',
    input,
    output: { file: out, bytes: after.bytes },
    stats: { before, after },
    steps: stepReports,
    requires,
    verify,
    verdict,
    timings: { transformMs, verifyMs, totalMs: Date.now() - started },
  };
}

/** The input file and the external resources its JSON names: what `optimize` must never write over. */
interface InputFiles {
  file: string;
  resources: ResourcePath[];
}

/**
 * Refuses to replace an existing file at `path` unless `overwrite` — the general rule (Ruling R21) behind both the
 * `out` file itself and every resource target `writeOutput` is about to write. Runs before any write, so it must be
 * called for every target (`out`, then each resource) before any of them is touched: a clash discovered on the
 * third resource must not have let the first two through already. `overwrite` defaults to `true` (`OptimizeInput`'s
 * own default) so the CLI keeps replacing; only an explicit `false` (MCP's `optimize_asset.overwrite`) enforces it.
 */
function assertNotClobbering(path: string, overwrite: boolean): void {
  if (!overwrite && existsSync(path)) throw new UsageError(`${cleanText(path, 300)} already exists; pass overwrite: true to replace it`);
}

/**
 * `io.write` picks GLB only for a lower-case `.glb` and writes anything else as `.gltf` plus resource files, so every
 * `.glb` (any case) goes through `writeBinary` here. For a `.gltf`, glTF-Transform names each resource after its
 * existing URI (`createURI` returns `getURI()`, so a `.gltf` input's `scene.bin` stays `scene.bin`) or after the
 * output's base name (`..%2F..%2Fx.gltf` → `..%2F..%2Fx.bin`), and `NodeIO._writeGLTF` writes it to
 * `path.join(dirname(out), decodeURIComponent(uri))` after `mkdir -p`. So this serializes once with `writeJSON`, checks
 * every resource target (inside the output's directory, and not the input file or one of its resources, by path or by
 * device and inode), and only then writes the same JSON and resources itself, the way `_writeGLTF` does. Its skip of
 * `http:` resource URIs never applies: `assertConfinedUri` refuses any scheme first.
 *
 * `overwrite` (Ruling R21) is checked last, after the input-clash checks above and before any write, for `out`
 * itself and every resource target: an unrelated pre-existing file whose name happens to match a resource this run
 * would write (resource names derive from the out basename, e.g. a single buffer becomes `<basename>.bin`) is
 * refused exactly like `out` already existing, not silently replaced. `resolveOptimizeOut` (`src/cli/mcp.ts`)
 * already refuses an existing `out` early, before any of this runs, for the MCP caller; this is the one place that
 * rule is enforced for every caller (including a direct `optimizeAsset` call with no MCP layer in front of it) and
 * the only place resource targets are checked at all.
 */
async function writeOutput(io: NodeIO, out: string, doc: Document, input: InputFiles, overwrite: boolean = true): Promise<void> {
  if (/\.glb$/i.test(out)) {
    assertNotClobbering(out, overwrite);
    writeFileSync(out, await io.writeBinary(doc));
    return;
  }
  const dir = dirname(out);
  const { FileUtils, Format } = await import('@gltf-transform/core');
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLTF, basename: FileUtils.basename(out) });
  assertConfinedUris(json, dir);
  const targets = Object.keys(resources).map((uri) => {
    assertConfinedUri(uri, 'resource', dir);
    return { uri, path: join(dir, decodeURIComponent(uri)) };
  });
  for (const target of targets) {
    const clash = sameFile(target.path, input.file) ? 'file' : input.resources.find((resource) => sameFile(target.path, resource.path))?.where;
    if (!clash) continue;
    const what = clash === 'file' ? 'the input file' : `the input's ${clash}`;
    throw new UsageError(`the .gltf output's resource ${JSON.stringify(cleanText(target.uri, 200))} would overwrite ${what} (${cleanText(target.path, 300)}); write the output to another directory, or as .glb`);
  }
  assertNotClobbering(out, overwrite);
  for (const target of targets) assertNotClobbering(target.path, overwrite);
  writeFileSync(out, JSON.stringify(json, null, 2));
  for (const target of targets) {
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, resources[target.uri]!);
  }
}

/**
 * Both files go through `analyzeAssetWithShots`, each with its own server and browser on its own resource stack
 * (closed before the next render starts). One shared browser would share GPU and shader caches between the two
 * renders and skew `delta.loadMs`.
 */
async function verifyPair(original: string, optimized: string, input: OptimizeInput, log: (line: string) => void, deps: CliDeps): Promise<{ verify: OptimizeVerify; pageErrors: VerifyPageErrors }> {
  const base: Omit<AnalyzeInput, 'file'> = { backend: input.backend, tier: input.tier, budget: null, frames: input.frames, compile: input.compile, bake: 'off', views: input.views, timeout: input.timeout, headed: input.headed };
  log(`verifying on ${input.backend}: original`);
  const a = await analyzeAssetWithShots({ ...base, file: original }, log, true, deps);
  log(`verifying on ${input.backend}: optimized`);
  const b = await analyzeAssetWithShots({ ...base, file: optimized }, log, true, deps);
  const views = a.shots.map((shot, i) => {
    const diff = comparePixels(shot.png, b.shots[i]!.png);
    return { view: shot.view, diffPct: Number(diff.diffPct.toFixed(3)), changedPixels: diff.changedPixels };
  });
  // `--parity 0` is judged on the raw counts, not the rounded percentage (Ruling R108): see `parityOf`.
  const parity: Parity = parityOf(views, input.parity);
  if (!parity.pass) log(`pixel parity lost between the files: ${failingViews(views, input.parity).map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct}%)`).join(', ')}`);
  const verify: OptimizeVerify = { backend: input.backend, parity, original: a.doc, optimized: b.doc, delta: deltaOf(a.doc, b.doc, statSync(original).size, statSync(optimized).size) };
  return { verify, pageErrors: { original: a.pageErrors, optimized: b.pageErrors } };
}

function deltaOf(a: AgentDocument, b: AgentDocument, bytesA: number, bytesB: number): OptimizeDelta {
  const mem = (d: AgentDocument): number => d.before.memory.textures.bytes + d.before.memory.geometries.bytes;
  return {
    bytes: bytesB - bytesA,
    materials: (b.asset?.materials ?? 0) - (a.asset?.materials ?? 0),
    vertices: (b.asset?.vertices ?? 0) - (a.asset?.vertices ?? 0),
    triangles: (b.asset?.triangles ?? 0) - (a.asset?.triangles ?? 0),
    sceneSubmissions: { naive: b.before.totals.sceneSubmissions - a.before.totals.sceneSubmissions, compiled: a.after && b.after ? b.after.totals.sceneSubmissions - a.after.totals.sceneSubmissions : null },
    loadMs: Number(((b.asset?.loadMs ?? 0) - (a.asset?.loadMs ?? 0)).toFixed(1)),
    memoryBytes: mem(b) - mem(a),
  };
}

/**
 * Parity, lost clips/skins/morphs, budget, error hints and page errors on the optimized file, plus page errors on the
 * original render (the parity baseline). Deltas are never judged.
 */
export function judgeOptimize(before: AssetStats, after: AssetStats, verify: OptimizeVerify | null, budget: number | null, pageErrors: VerifyPageErrors = { original: [], optimized: [] }): Verdict {
  const reasons: string[] = [];
  if (after.animations < before.animations) reasons.push(`lost ${before.animations - after.animations} of ${before.animations} animations`);
  if (after.skins < before.skins) reasons.push(`lost ${before.skins - after.skins} of ${before.skins} skins`);
  if (after.morphTargets < before.morphTargets) reasons.push(`lost ${before.morphTargets - after.morphTargets} of ${before.morphTargets} morph targets`);
  if (!verify) return { pass: reasons.length === 0, budget: null, errors: [], reasons };
  const optimized = verdictOf(verify.optimized.after, verify.optimized.before, budget, verify.parity, pageErrors.optimized);
  reasons.push(...optimized.reasons);
  if (pageErrors.original.length > 0) reasons.push(`the original file raised ${pageErrorsReason(pageErrors.original)}`);
  const a = verify.original.asset;
  const b = verify.optimized.asset;
  if (a && b) {
    if (b.animations < a.animations) reasons.push(`the harness loaded ${b.animations} of ${a.animations} clips`);
    if (b.skinned < a.skinned) reasons.push(`the harness loaded ${b.skinned} of ${a.skinned} skinned meshes`);
    if (b.morph < a.morph) reasons.push(`the harness loaded ${b.morph} of ${a.morph} morph meshes`);
  }
  if (verify.optimized.parity && !verify.optimized.parity.pass) reasons.push(`the optimized file lost pixel parity when compiled (${verify.optimized.parity.diffPct.toFixed(2)}%)`);
  return { pass: reasons.length === 0, budget: optimized.budget, errors: optimized.errors, reasons: [...new Set(reasons)] };
}
