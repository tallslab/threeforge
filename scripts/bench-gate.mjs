// Compares a bench results file with its committed baseline and fails on regressions.
// Usage: node scripts/bench-gate.mjs [webgl2|webgpu]   (FORGE_GPU=native also gates timing metrics)
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DETERMINISTIC = ['sceneSubmissions', 'gpuDraws', 'triangles', 'programs', 'overdrawOpaque', 'overdrawTransparent', 'skinnedVertices', 'shadowCasters', 'shadowTexels', 'textureBytes', 'geometryBytes', 'renderTargetBytes', 'particles', 'fillMegapixels', 'objects', 'autoUpdatedMatrices'];
export const TIMING = ['renderMs', 'frameMs'];

/** Lower is better for every metric. A metric fails when it is worse by `tolerance` (fraction) or more. */
export function compare(baseline, result, { gateTiming, tolerance }) {
  const rows = [];
  const failures = [];
  const gated = gateTiming ? [...DETERMINISTIC, ...TIMING] : DETERMINISTIC;
  for (const [scene, base] of Object.entries(baseline.scenes)) {
    const res = result.scenes[scene];
    if (!res) {
      failures.push(`${scene}: missing from results`);
      continue;
    }
    for (const variant of ['naive', 'optimized']) {
      if (base[variant] && !res[variant]) {
        failures.push(`${scene} ${variant}: missing from results`);
        continue;
      }
      for (const metric of [...DETERMINISTIC, ...TIMING]) {
        const before = base[variant]?.[metric];
        const after = res[variant]?.[metric];
        const ratio = res.naive?.[metric] > 0 && res.optimized?.[metric] > 0 ? res.naive[metric] / res.optimized[metric] : null;
        rows.push({ scene, variant, metric, before, after, ratio: variant === 'optimized' ? ratio : null });
        if (!gated.includes(metric) || before === undefined || after === undefined) continue;
        const worse = before === 0 ? after > 0 : after >= before * (1 + tolerance) - 1e-9;
        if (worse) failures.push(`${scene} ${variant} ${metric}: ${before} -> ${after} (+${(((after - before) / (before || 1)) * 100).toFixed(1)}%)`);
      }
      if (res[variant]?.unattributed) failures.push(`${scene} ${variant}: ${res[variant].unattributed} unattributed draws`);
    }
  }
  return { rows, failures };
}

const mb = (m) => ((m.textureBytes + m.geometryBytes + m.renderTargetBytes) / 1048576).toFixed(0);
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Markdown table: one row per scene, naive → optimized per metric family. */
export function table(result) {
  const lines = [
    '| scene | submissions naive → opt | gpu draws | triangles | overdraw opaque / transparent | particles | fill MPix | objects / auto-matrices | skinned verts | shadow texels | memory MB | render ms | frame ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [scene, { naive: n, optimized: o }] of Object.entries(result.scenes)) {
    if (!n || !o) continue;
    lines.push(
      `| ${scene} | ${n.sceneSubmissions} → ${o.sceneSubmissions} (${(n.sceneSubmissions / Math.max(1, o.sceneSubmissions)).toFixed(1)}×) | ${n.gpuDraws} → ${o.gpuDraws} | ${k(n.triangles)} → ${k(o.triangles)} | ${n.overdrawOpaque.toFixed(2)} / ${n.overdrawTransparent.toFixed(2)} → ${o.overdrawOpaque.toFixed(2)} / ${o.overdrawTransparent.toFixed(2)} | ${k(n.particles ?? 0)} → ${k(o.particles ?? 0)} | ${(n.fillMegapixels ?? 0).toFixed(2)} → ${(o.fillMegapixels ?? 0).toFixed(2)} | ${k(n.objects ?? 0)} / ${k(n.autoUpdatedMatrices ?? 0)} → ${k(o.objects ?? 0)} / ${k(o.autoUpdatedMatrices ?? 0)} | ${k(n.skinnedVertices)} → ${k(o.skinnedVertices)} | ${k(n.shadowTexels)} → ${k(o.shadowTexels)} | ${mb(n)} → ${mb(o)} | ${n.renderMs.toFixed(1)} → ${o.renderMs.toFixed(1)} | ${n.frameMs.toFixed(1)} → ${o.frameMs.toFixed(1)} |`,
    );
  }
  return lines.join('\n');
}

export function resultPath(backend) {
  return `bench/results/local.${backend}.json`;
}
export function baselinePath(backend) {
  return `bench/baselines/${backend}.json`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const backend = process.argv[2] ?? 'webgl2';
  if (!existsSync(resultPath(backend))) {
    console.error(`no results at ${resultPath(backend)}; run: pnpm exec playwright test test/e2e/bench.spec.ts --project=${backend}`);
    process.exit(2);
  }
  const result = JSON.parse(readFileSync(resultPath(backend), 'utf8'));
  console.log(`bench ${backend} · ${result.env?.gpu ?? '?'} · tier ${result.env?.tier ?? '?'}`);
  console.log(table(result));
  if (!existsSync(baselinePath(backend))) {
    console.log(`no baseline at ${baselinePath(backend)}; run: pnpm bench:baseline ${backend}`);
    process.exit(0);
  }
  const gateTiming = process.env.FORGE_GPU === 'native';
  const { failures } = compare(JSON.parse(readFileSync(baselinePath(backend), 'utf8')), result, { gateTiming, tolerance: 0.1 });
  if (failures.length) {
    console.error(`REGRESSION (${failures.length}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`bench gate ${backend}: PASS${gateTiming ? ' (timing gated)' : ' (timing recorded, not gated: set FORGE_GPU=native on a real GPU)'}`);
}
