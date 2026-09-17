import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Document, NodeIO } from '@gltf-transform/core';
import { VERSION } from '../version.js';
import { analyzeAssetWithShots, comparePixels, failingViews, parityOf } from './analyze.js';
import { DEFAULT_PARITY } from './args.js';
import { EnvironmentError, UsageError } from './errors.js';
import {
  assertConfinedUri,
  assertConfinedUris,
  entryExists,
  type ResourcePath,
  readGltfJson,
  resourcePathsOf,
} from './gltf-uris.js';
import type { CliDeps } from './lifecycle.js';
import { planSteps } from './pipeline.js';
import { applySteps, createIO, DRACO_INSTALL, loadDeps, requirementsOf, statsOf } from './transform.js';
import type {
  AgentDocument,
  AnalyzeInput,
  AssetStats,
  OptimizeDelta,
  OptimizeDocument,
  OptimizeInput,
  OptimizeVerify,
  Parity,
  Verdict,
} from './types.js';
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
export async function optimizeAsset(
  input: OptimizeInput,
  log: (line: string) => void = () => {},
  cliDeps: CliDeps = {},
): Promise<OptimizeDocument> {
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
  if (named)
    throw new UsageError(
      `--out would overwrite the input's ${named.where} ${JSON.stringify(cleanText(named.uri, 200))}`,
    );
  const deps = await loadDeps(steps, input.textures !== null && input.textures !== 'none');
  const io = await createIO(deps);
  const { Logger } = await import('@gltf-transform/core');
  const silent = new Logger(Logger.Verbosity.SILENT);
  io.setLogger(silent);
  let doc: Document;
  try {
    doc = await io.read(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/draco/i.test(message))
      throw new EnvironmentError(`reading a Draco-compressed input needs draco3dgltf: ${DRACO_INSTALL}`);
    throw new UsageError(`cannot read ${input.file}: ${message}`);
  }
  doc.setLogger(silent);
  const before = statsOf(doc, statSync(file).size);
  log(
    `${basename(file)}: ${before.meshes} meshes, ${before.materials} materials, ${before.triangles} triangles, ${before.bytes} bytes; ${steps.map((s) => s.name).join(' → ') || 'no steps'}`,
  );
  const transformStarted = Date.now();
  const stepReports = await applySteps(doc, steps, deps, log);
  await writeOutput(io, out, doc, inputFiles, input.overwrite);
  const transformMs = Date.now() - transformStarted;
  const after = statsOf(doc, statSync(out).size);
  const requires = requirementsOf(after.extensions);
  log(
    `wrote ${out}: ${after.bytes} bytes (${((100 * after.bytes) / Math.max(1, before.bytes)).toFixed(0)} % of the input)`,
  );
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
 * Refuses to replace an existing file at `path` unless `overwrite` — the general rule behind both the
 * `out` file itself and every resource target `writeOutput` is about to write. A symlink counts as existing, dangling or
 * not (`lstat`): `existsSync` follows it, so a dangling link read as free and the write then created the link's target
 * wherever it pointed. Runs before any write, so it must be
 * called for every target (`out`, then each resource) before any of them is touched: a clash discovered on the
 * third resource must not have let the first two through already. `overwrite` defaults to `true` (`OptimizeInput`'s
 * own default) so the CLI keeps replacing; only an explicit `false` (MCP's `optimize_asset.overwrite`) enforces it.
 */
function assertNotClobbering(path: string, overwrite: boolean): void {
  if (!overwrite && entryExists(path))
    throw new UsageError(`${cleanText(path, 300)} already exists; pass overwrite: true to replace it`);
}

/**
 * `io.write` picks GLB only for a lower-case `.glb`, so every `.glb` (any case) goes through `writeBinary` here. For a
 * `.gltf`, glTF-Transform names each resource after its existing URI or the output's base name and writes it to
 * `path.join(dirname(out), decodeURIComponent(uri))` after `mkdir -p`, so this serializes once with `writeJSON`, checks
 * every resource target (inside the output's directory, not the input file or one of its resources by path or by
 * device and inode, and not an existing file unless `overwrite`), and only then writes the JSON and resources itself.
 * `resolveOptimizeOut` (`mcp.ts`) refuses an existing `out` early for the MCP caller; this is where the rule holds
 * for every caller and the only place resource targets are checked.
 */
async function writeOutput(
  io: NodeIO,
  out: string,
  doc: Document,
  input: InputFiles,
  overwrite: boolean = true,
): Promise<void> {
  // Without `overwrite`, every write is `wx` (`O_CREAT | O_EXCL`): it fails on anything already at the path, a symlink
  // included, instead of following it, so a link planted between the check and the write cannot redirect it either.
  const flag = overwrite ? 'w' : 'wx';
  if (/\.glb$/i.test(out)) {
    assertNotClobbering(out, overwrite);
    writeExclusive(out, await io.writeBinary(doc), flag);
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
    const clash = sameFile(target.path, input.file)
      ? 'file'
      : input.resources.find((resource) => sameFile(target.path, resource.path))?.where;
    if (!clash) continue;
    const what = clash === 'file' ? 'the input file' : `the input's ${clash}`;
    throw new UsageError(
      `the .gltf output's resource ${JSON.stringify(cleanText(target.uri, 200))} would overwrite ${what} (${cleanText(target.path, 300)}); write the output to another directory, or as .glb`,
    );
  }
  assertNotClobbering(out, overwrite);
  for (const target of targets) assertNotClobbering(target.path, overwrite);
  writeExclusive(out, JSON.stringify(json, null, 2), flag);
  for (const target of targets) {
    mkdirSync(dirname(target.path), { recursive: true });
    writeExclusive(target.path, resources[target.uri]!, flag);
  }
}

/** `writeFileSync` with `flag`; an `EEXIST` from `wx` (something appeared after `assertNotClobbering`) is the same `UsageError`. */
function writeExclusive(path: string, data: string | Uint8Array, flag: 'w' | 'wx'): void {
  try {
    writeFileSync(path, data, { flag });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new UsageError(`${cleanText(path, 300)} already exists; pass overwrite: true to replace it`);
    throw error;
  }
}

/**
 * `input.parity` is the threshold between the two files; each file's compile check keeps the `analyze` default, because
 * a stricter `--parity` passed inward fails a correct run: the Buggy's optimized file is pixel-identical to the original,
 * yet compiling either moves 1 px (webgl2) or 2 px (webgpu) of 921,600. `verify.optimized.parity` still reports the drift.
 */
export function verifyAnalyzeInput(input: OptimizeInput): Omit<AnalyzeInput, 'file'> {
  return {
    backend: input.backend,
    tier: input.tier,
    budget: null,
    frames: input.frames,
    compile: input.compile,
    bake: 'off',
    views: input.views,
    parity: DEFAULT_PARITY,
    timeout: input.timeout,
    headed: input.headed,
  };
}

/**
 * Both files go through `analyzeAssetWithShots`, each with its own server and browser on its own resource stack
 * (closed before the next render starts). One shared browser would share GPU and shader caches between the two
 * renders and skew `delta.loadMs`.
 */
async function verifyPair(
  original: string,
  optimized: string,
  input: OptimizeInput,
  log: (line: string) => void,
  deps: CliDeps,
): Promise<{ verify: OptimizeVerify; pageErrors: VerifyPageErrors }> {
  const base = verifyAnalyzeInput(input);
  log(`verifying on ${input.backend}: original`);
  const a = await analyzeAssetWithShots({ ...base, file: original }, log, true, deps);
  log(`verifying on ${input.backend}: optimized`);
  const b = await analyzeAssetWithShots({ ...base, file: optimized }, log, true, deps);
  const views = a.shots.map((shot, i) => {
    const diff = comparePixels(shot.png, b.shots[i]!.png);
    return { view: shot.view, diffPct: Number(diff.diffPct.toFixed(3)), changedPixels: diff.changedPixels };
  });
  // `--parity 0` is judged on the raw counts, not the rounded percentage: see `parityOf`.
  const parity: Parity = parityOf(views, input.parity);
  if (!parity.pass)
    log(
      `pixel parity lost between the files: ${failingViews(views, input.parity)
        .map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct}%)`)
        .join(', ')}`,
    );
  const verify: OptimizeVerify = {
    backend: input.backend,
    parity,
    original: a.doc,
    optimized: b.doc,
    delta: deltaOf(a.doc, b.doc, statSync(original).size, statSync(optimized).size),
  };
  return { verify, pageErrors: { original: a.pageErrors, optimized: b.pageErrors } };
}

function deltaOf(a: AgentDocument, b: AgentDocument, bytesA: number, bytesB: number): OptimizeDelta {
  const mem = (d: AgentDocument): number => d.before.memory.textures.bytes + d.before.memory.geometries.bytes;
  return {
    bytes: bytesB - bytesA,
    materials: (b.asset?.materials ?? 0) - (a.asset?.materials ?? 0),
    vertices: (b.asset?.vertices ?? 0) - (a.asset?.vertices ?? 0),
    triangles: (b.asset?.triangles ?? 0) - (a.asset?.triangles ?? 0),
    sceneSubmissions: {
      naive: b.before.totals.sceneSubmissions - a.before.totals.sceneSubmissions,
      compiled: a.after && b.after ? b.after.totals.sceneSubmissions - a.after.totals.sceneSubmissions : null,
    },
    loadMs: Number(((b.asset?.loadMs ?? 0) - (a.asset?.loadMs ?? 0)).toFixed(1)),
    memoryBytes: mem(b) - mem(a),
  };
}

/**
 * Parity, lost clips/skins/morphs, budget, error hints and page errors on the optimized file, plus page errors on the
 * original render (the parity baseline). Deltas are never judged.
 */
export function judgeOptimize(
  before: AssetStats,
  after: AssetStats,
  verify: OptimizeVerify | null,
  budget: number | null,
  pageErrors: VerifyPageErrors = { original: [], optimized: [] },
): Verdict {
  const reasons: string[] = [];
  if (after.animations < before.animations)
    reasons.push(`lost ${before.animations - after.animations} of ${before.animations} animations`);
  if (after.skins < before.skins) reasons.push(`lost ${before.skins - after.skins} of ${before.skins} skins`);
  if (after.morphTargets < before.morphTargets)
    reasons.push(`lost ${before.morphTargets - after.morphTargets} of ${before.morphTargets} morph targets`);
  if (!verify) return { pass: reasons.length === 0, budget: null, errors: [], reasons };
  const optimized = verdictOf(
    verify.optimized.after,
    verify.optimized.before,
    budget,
    verify.parity,
    pageErrors.optimized,
  );
  reasons.push(...optimized.reasons);
  if (pageErrors.original.length > 0) reasons.push(`the original file raised ${pageErrorsReason(pageErrors.original)}`);
  const a = verify.original.asset;
  const b = verify.optimized.asset;
  if (a && b) {
    if (b.animations < a.animations) reasons.push(`the harness loaded ${b.animations} of ${a.animations} clips`);
    if (b.skinned < a.skinned) reasons.push(`the harness loaded ${b.skinned} of ${a.skinned} skinned meshes`);
    if (b.morph < a.morph) reasons.push(`the harness loaded ${b.morph} of ${a.morph} morph meshes`);
  }
  // The raw count as well as the percent: `diffPct` is rounded to two decimals here, so a compile that
  // moved a few pixels of 921,600 would report "0.00%" and say nothing about what actually moved. The count is what
  // tells a reader whether this is threeforge's own sub-pixel batching drift or a real loss from the rewrite.
  if (verify.optimized.parity && !verify.optimized.parity.pass) {
    const worst = Math.max(0, ...verify.optimized.parity.views.map((view) => view.changedPixels));
    reasons.push(
      `the optimized file lost pixel parity when compiled (${worst} changed pixels in the worst view, ${verify.optimized.parity.diffPct.toFixed(2)}%)`,
    );
  }
  return {
    pass: reasons.length === 0,
    budget: optimized.budget,
    errors: optimized.errors,
    reasons: [...new Set(reasons)],
  };
}
