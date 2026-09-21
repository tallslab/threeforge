import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BACKENDS, backendsFromArgv, baselinePath, readBaseline, resultPath } from '../../scripts/bench-common.mjs';
import { compare, DETERMINISTIC, TIMING } from '../../scripts/bench-gate.mjs';

const metrics = (over: Record<string, number> = {}) => ({
  sceneSubmissions: 100,
  gpuDraws: 100,
  triangles: 1000,
  programs: 5,
  overdrawOpaque: 1,
  overdrawTransparent: 0.5,
  skinnedVertices: 0,
  shadowCasters: 0,
  shadowTexels: 0,
  textureBytes: 1000,
  geometryBytes: 1000,
  renderTargetBytes: 0,
  particles: 100,
  fillMegapixels: 0.5,
  objects: 500,
  autoUpdatedMatrices: 20,
  shadowPassesPerFrame: 1,
  renderMs: 2,
  frameMs: 16,
  unattributed: 0,
  ...over,
});
const file = (naive: Record<string, number> = {}, optimized: Record<string, number> = {}) => ({
  schemaVersion: 1,
  env: {},
  scenes: { village: { naive: metrics(naive), optimized: metrics(optimized) } } as Record<
    string,
    { naive: ReturnType<typeof metrics>; optimized: ReturnType<typeof metrics> }
  >,
});

describe('bench gate', () => {
  it('passes when nothing regressed and reports the naive to optimized ratio', () => {
    const { failures, rows } = compare(file(), file({}, { sceneSubmissions: 10 }), {
      gateTiming: false,
      tolerance: 0.1,
    });
    expect(failures).toEqual([]);
    expect(
      rows.find((r) => r.scene === 'village' && r.variant === 'optimized' && r.metric === 'sceneSubmissions')?.ratio,
    ).toBe(10);
  });

  it('fails a deterministic metric worse by 10 % or more, tolerates 9 %', () => {
    expect(compare(file(), file({}, { gpuDraws: 110 }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([
      'village optimized gpuDraws: 100 -> 110 (+10.0%)',
    ]);
    expect(compare(file(), file({}, { gpuDraws: 109 }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
  });

  it('gates timing only when asked', () => {
    expect(compare(file(), file({ frameMs: 40 }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
    expect(compare(file(), file({ frameMs: 40 }), { gateTiming: true, tolerance: 0.1 }).failures).toEqual([
      'village naive frameMs: 16 -> 40 (+150.0%)',
    ]);
  });

  it('treats a missing baseline scene as new and a missing result scene as a failure', () => {
    const base = file();
    const res = file();
    res.scenes.forest = res.scenes.village!;
    expect(compare(base, res, { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
    expect(compare(res, base, { gateTiming: false, tolerance: 0.1 }).failures).toEqual([
      'forest: missing from results',
    ]);
  });

  it('fails any unattributed draw', () => {
    expect(compare(file(), file({ unattributed: 2 }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([
      'village naive: 2 unattributed draws',
    ]);
  });

  it('exports the metric lists', () => {
    expect(DETERMINISTIC).toContain('overdrawTransparent');
    expect(DETERMINISTIC).toEqual(
      expect.arrayContaining(['particles', 'fillMegapixels', 'objects', 'autoUpdatedMatrices', 'shadowPassesPerFrame']),
    );
    expect(TIMING).toEqual(['renderMs', 'frameMs']);
  });

  it('fails when a variant is missing from the results, not only a whole scene', () => {
    const result = file();
    delete (result.scenes.village as Record<string, unknown>).naive;
    const { failures } = compare(file(), result, { gateTiming: false, tolerance: 0.1 });
    expect(failures).toEqual([expect.stringContaining('village naive: missing from results')]);
  });

  it('fails a gated metric missing from the results, so a regression cannot hide as a hole', () => {
    const result = file();
    delete (result.scenes.village!.naive as unknown as Record<string, unknown>).gpuDraws;
    expect(compare(file(), result, { gateTiming: false, tolerance: 0.1 }).failures).toEqual([
      'village naive gpuDraws: missing from results',
    ]);
  });

  it('fails a gated metric that is not a finite number', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(compare(file(), file({ triangles: bad }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([
        `village naive triangles: ${String(bad)} is not a finite number`,
      ]);
    }
    for (const bad of [null, 'x']) {
      expect(
        compare(file(), file({ triangles: bad as unknown as number }), { gateTiming: false, tolerance: 0.1 }).failures,
      ).toEqual([`village naive triangles: ${String(bad)} is not a finite number`]);
    }
  });

  it('fails a non-finite baseline value instead of comparing against it', () => {
    expect(compare(file({ triangles: NaN }), file(), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([
      'village naive triangles: baseline NaN is not a finite number',
    ]);
  });

  it('skips a metric the baseline does not carry yet, so a newly added metric is not a failure', () => {
    const baseline = file();
    delete (baseline.scenes.village!.naive as unknown as Record<string, unknown>).particles;
    expect(compare(baseline, file(), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
  });

  it('leaves an ungated timing metric alone when it is missing or non-finite', () => {
    const result = file({ renderMs: NaN });
    delete (result.scenes.village!.naive as unknown as Record<string, unknown>).frameMs;
    expect(compare(file(), result, { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
    expect(compare(file(), result, { gateTiming: true, tolerance: 0.1 }).failures).toEqual([
      'village naive renderMs: NaN is not a finite number',
      'village naive frameMs: missing from results',
    ]);
  });

  it('fails a missing or non-finite unattributed rather than reading it as zero', () => {
    const missing = file();
    delete (missing.scenes.village!.naive as unknown as Record<string, unknown>).unattributed;
    expect(compare(file(), missing, { gateTiming: false, tolerance: 0.1 }).failures).toEqual([
      'village naive unattributed: missing from results',
    ]);
    expect(compare(file(), file({ unattributed: NaN }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([
      'village naive unattributed: NaN is not a finite number',
    ]);
  });

  it('does not invent failures for a variant neither the baseline nor the results carry', () => {
    const baseline = file();
    const result = file();
    delete (baseline.scenes.village as Record<string, unknown>).optimized;
    delete (result.scenes.village as Record<string, unknown>).optimized;
    expect(compare(baseline, result, { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
  });
});

describe('bench-common', () => {
  it('names both backends, or the one on the command line', () => {
    expect(BACKENDS).toEqual(['webgl2', 'webgpu']);
    expect(backendsFromArgv(['node', 'script'])).toEqual(['webgl2', 'webgpu']);
    expect(backendsFromArgv(['node', 'script', 'webgpu'])).toEqual(['webgpu']);
  });

  it('places results and baselines where the gate reads them', () => {
    expect(resultPath('webgpu')).toBe('bench/results/local.webgpu.json');
    expect(baselinePath('webgl2')).toBe('bench/baselines/webgl2.json');
  });

  it('returns null for a backend without a committed baseline', () => {
    expect(readBaseline('no-such-backend')).toBeNull();
  });
});

/**
 * The gate as a process, the way ci.yml's advisory bench leg calls it. `--advisory` turns the two outcomes the gate
 * decides (worse than the baseline, nothing measured) into a warning and exit 0. Anything it did not decide, such as
 * a results file it cannot read, must still end non-zero: a crash exits 1 as a regression does, so no caller can
 * tell them apart by the code.
 */
describe('bench gate --advisory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bench/baselines'), { recursive: true });
  mkdirSync(join(dir, 'bench/results'), { recursive: true });
  writeFileSync(join(dir, 'bench/baselines/webgpu.json'), JSON.stringify(file()));
  const results = join(dir, 'bench/results/local.webgpu.json');
  const gate = (...flags: string[]) =>
    spawnSync(process.execPath, [resolve('scripts/bench-gate.mjs'), 'webgpu', ...flags], {
      cwd: dir,
      encoding: 'utf8',
    });

  it('warns and exits 0 on a regression, which without the flag exits 1', () => {
    writeFileSync(results, JSON.stringify(file({}, { triangles: 5000 })));
    expect(gate().status).toBe(1);
    const advisory = gate('--advisory');
    expect(advisory.stdout).toContain('::warning::bench webgpu: worse than the baseline');
    expect(advisory.status).toBe(0);
  });

  it('warns and exits 0 when no scene was measured, which without the flag exits 2', () => {
    rmSync(results, { force: true });
    expect(gate().status).toBe(2);
    const advisory = gate('--advisory');
    expect(advisory.stdout).toContain('::warning::bench webgpu: no scene was measured');
    expect(advisory.status).toBe(0);
  });

  it('passes quietly when the results hold the baseline', () => {
    writeFileSync(results, JSON.stringify(file()));
    const advisory = gate('--advisory');
    expect(advisory.stdout).not.toContain('::warning::');
    expect(advisory.status).toBe(0);
  });

  it.each([
    ['results that are not JSON', '{ "scenes": '],
    ['results whose scenes lack their metrics', JSON.stringify({ scenes: { village: { naive: {}, optimized: {} } } })],
  ])('still fails on %s, without calling it a regression', (_, text) => {
    writeFileSync(results, text);
    const advisory = gate('--advisory');
    expect(advisory.stdout).not.toContain('::warning::');
    expect(advisory.status).not.toBe(0);
  });
});
