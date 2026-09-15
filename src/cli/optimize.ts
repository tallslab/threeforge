import type { Document, NodeIO } from '@gltf-transform/core';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { VERSION } from '../version.js';
import { analyzeAssetWithShots, pixelDiffPct } from './analyze.js';
import { EnvironmentError, UsageError } from './errors.js';
import { assertConfinedUri, assertConfinedUris, readGltfJson } from './gltf-uris.js';
import type { CliDeps } from './lifecycle.js';
import { planSteps } from './pipeline.js';
import { applySteps, createIO, DRACO_INSTALL, loadDeps, requirementsOf, statsOf } from './transform.js';
import type { AgentDocument, AnalyzeInput, AssetStats, OptimizeDelta, OptimizeDocument, OptimizeInput, OptimizeVerify, Parity, Verdict } from './types.js';
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

/** Both paths name one file: the same device and inode (a hard link, a symlink, a case variant on a case-insensitive filesystem). */
function sameFile(a: string, b: string): boolean {
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
  if (out === file || sameFile(out, file)) throw new UsageError('--out must not be the input file');
  const steps = planSteps(input);
  // glTF-Transform reads every external image and buffer wherever its URI points; refuse the file before it does.
  assertConfinedUris(readGltfJson(file), dirname(file));
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
  await writeOutput(io, out, doc);
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
    schemaVersion: 1,
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

/**
 * `io.write` picks GLB only for a lower-case `.glb` and writes anything else as `.gltf` plus resource files, so every
 * `.glb` (any case) goes through `writeBinary` here. A `.gltf` writer names each resource after its existing URI or
 * after the output's base name (`..%2F..%2Fx.gltf` → `..%2F..%2Fx.bin`) and writes it to
 * `path.join(dirname(out), decodeURIComponent(uri))` after `mkdir -p`, so the URIs of a dry `writeJSON` are checked
 * against the output's directory before anything is written.
 */
async function writeOutput(io: NodeIO, out: string, doc: Document): Promise<void> {
  if (/\.glb$/i.test(out)) {
    writeFileSync(out, await io.writeBinary(doc));
    return;
  }
  const { FileUtils, Format } = await import('@gltf-transform/core');
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLTF, basename: FileUtils.basename(out) });
  assertConfinedUris(json, dirname(out));
  for (const uri of Object.keys(resources)) assertConfinedUri(uri, 'resource', dirname(out));
  await io.write(out, doc);
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
  const views = a.shots.map((shot, i) => ({ view: shot.view, diffPct: Number(pixelDiffPct(shot.png, b.shots[i]!.png).toFixed(3)) }));
  const worst = views.length ? Math.max(...views.map((v) => v.diffPct)) : 0;
  const parity: Parity = { diffPct: worst, threshold: input.parity, pass: worst <= input.parity, views };
  if (!parity.pass) log(`pixel parity lost between the files: ${views.filter((v) => v.diffPct > input.parity).map((v) => `${v.view} ${v.diffPct}%`).join(', ')}`);
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
