import { existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { VERSION } from '../version.js';
import { analyzeAssetWithShots, pixelDiffPct } from './analyze.js';
import { EnvironmentError, UsageError } from './errors.js';
import type { CliDeps } from './lifecycle.js';
import { planSteps } from './pipeline.js';
import { applySteps, createIO, DRACO_INSTALL, loadDeps, requirementsOf, statsOf } from './transform.js';
import type { AgentDocument, AnalyzeInput, AssetStats, OptimizeDelta, OptimizeDocument, OptimizeInput, OptimizeVerify, Parity, Verdict } from './types.js';
import { verdictOf } from './verdict.js';

/** `scene.glb` → `scene.forge.glb` next to it; `.gltf` inputs still default to a single `.glb`. */
export function defaultOutputPath(file: string): string {
  const ext = extname(file);
  return join(dirname(file), `${basename(file, ext)}.forge.glb`);
}

/** `threeforge optimize <file>`: transform with glTF-Transform, write, verify by rendering both files, judge. */
export async function optimizeAsset(input: OptimizeInput, log: (line: string) => void = () => {}, cliDeps: CliDeps = {}): Promise<OptimizeDocument> {
  const started = Date.now();
  const file = resolve(input.file);
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`file not found: ${input.file}`);
  const out = resolve(input.out ?? defaultOutputPath(file));
  if (out === file) throw new UsageError('--out must not be the input file');
  const steps = planSteps(input);
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
  await io.write(out, doc);
  const transformMs = Date.now() - transformStarted;
  const after = statsOf(doc, statSync(out).size);
  const requires = requirementsOf(after.extensions);
  log(`wrote ${out}: ${after.bytes} bytes (${((100 * after.bytes) / Math.max(1, before.bytes)).toFixed(0)} % of the input)`);
  const verifyStarted = Date.now();
  const verify = input.verify ? await verifyPair(file, out, input, log, cliDeps) : null;
  const verifyMs = input.verify ? Date.now() - verifyStarted : 0;
  const verdict = judge(before, after, verify, input.budget);
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
 * Both files go through `analyzeAssetWithShots`, each with its own server and browser on its own resource stack
 * (closed before the next render starts). One shared browser would share GPU and shader caches between the two
 * renders and skew `delta.loadMs`.
 */
async function verifyPair(original: string, optimized: string, input: OptimizeInput, log: (line: string) => void, deps: CliDeps): Promise<OptimizeVerify> {
  const base: Omit<AnalyzeInput, 'file'> = { backend: input.backend, tier: input.tier, budget: null, frames: input.frames, compile: input.compile, bake: 'off', views: input.views, timeout: input.timeout, headed: input.headed };
  log(`verifying on ${input.backend}: original`);
  const a = await analyzeAssetWithShots({ ...base, file: original }, log, true, deps);
  log(`verifying on ${input.backend}: optimized`);
  const b = await analyzeAssetWithShots({ ...base, file: optimized }, log, true, deps);
  const views = a.shots.map((shot, i) => ({ view: shot.view, diffPct: Number(pixelDiffPct(shot.png, b.shots[i]!.png).toFixed(3)) }));
  const worst = views.length ? Math.max(...views.map((v) => v.diffPct)) : 0;
  const parity: Parity = { diffPct: worst, threshold: input.parity, pass: worst <= input.parity, views };
  if (!parity.pass) log(`pixel parity lost between the files: ${views.filter((v) => v.diffPct > input.parity).map((v) => `${v.view} ${v.diffPct}%`).join(', ')}`);
  return { backend: input.backend, parity, original: a.doc, optimized: b.doc, delta: deltaOf(a.doc, b.doc, statSync(original).size, statSync(optimized).size) };
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

/** Parity, lost clips/skins/morphs, budget and error hints on the optimized file. Deltas are never judged. */
function judge(before: AssetStats, after: AssetStats, verify: OptimizeVerify | null, budget: number | null): Verdict {
  const reasons: string[] = [];
  if (after.animations < before.animations) reasons.push(`lost ${before.animations - after.animations} of ${before.animations} animations`);
  if (after.skins < before.skins) reasons.push(`lost ${before.skins - after.skins} of ${before.skins} skins`);
  if (after.morphTargets < before.morphTargets) reasons.push(`lost ${before.morphTargets - after.morphTargets} of ${before.morphTargets} morph targets`);
  if (!verify) return { pass: reasons.length === 0, budget: null, errors: [], reasons };
  const optimized = verdictOf(verify.optimized.after, verify.optimized.before, budget, verify.parity);
  reasons.push(...optimized.reasons);
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
