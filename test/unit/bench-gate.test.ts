import { describe, expect, it } from 'vitest';
import { compare, DETERMINISTIC, TIMING } from '../../scripts/bench-gate.mjs';

const metrics = (over: Record<string, number> = {}) => ({ sceneSubmissions: 100, gpuDraws: 100, triangles: 1000, programs: 5, overdrawOpaque: 1, overdrawTransparent: 0.5, skinnedVertices: 0, shadowCasters: 0, shadowTexels: 0, textureBytes: 1000, geometryBytes: 1000, renderTargetBytes: 0, particles: 100, fillMegapixels: 0.5, renderMs: 2, frameMs: 16, unattributed: 0, ...over });
const file = (naive: Record<string, number> = {}, optimized: Record<string, number> = {}) => ({ schemaVersion: 1, env: {}, scenes: { village: { naive: metrics(naive), optimized: metrics(optimized) } } as Record<string, { naive: ReturnType<typeof metrics>; optimized: ReturnType<typeof metrics> }> });

describe('bench gate', () => {
  it('passes when nothing regressed and reports the naive to optimized ratio', () => {
    const { failures, rows } = compare(file(), file({}, { sceneSubmissions: 10 }), { gateTiming: false, tolerance: 0.1 });
    expect(failures).toEqual([]);
    expect(rows.find((r) => r.scene === 'village' && r.variant === 'optimized' && r.metric === 'sceneSubmissions')?.ratio).toBe(10);
  });

  it('fails a deterministic metric worse by 10 % or more, tolerates 9 %', () => {
    expect(compare(file(), file({}, { gpuDraws: 110 }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual(['village optimized gpuDraws: 100 -> 110 (+10.0%)']);
    expect(compare(file(), file({}, { gpuDraws: 109 }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
  });

  it('gates timing only when asked', () => {
    expect(compare(file(), file({ frameMs: 40 }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
    expect(compare(file(), file({ frameMs: 40 }), { gateTiming: true, tolerance: 0.1 }).failures).toEqual(['village naive frameMs: 16 -> 40 (+150.0%)']);
  });

  it('treats a missing baseline scene as new and a missing result scene as a failure', () => {
    const base = file();
    const res = file();
    res.scenes.forest = res.scenes.village!;
    expect(compare(base, res, { gateTiming: false, tolerance: 0.1 }).failures).toEqual([]);
    expect(compare(res, base, { gateTiming: false, tolerance: 0.1 }).failures).toEqual(['forest: missing from results']);
  });

  it('fails any unattributed draw', () => {
    expect(compare(file(), file({ unattributed: 2 }), { gateTiming: false, tolerance: 0.1 }).failures).toEqual(['village naive: 2 unattributed draws']);
  });

  it('exports the metric lists', () => {
    expect(DETERMINISTIC).toContain('overdrawTransparent');
    expect(DETERMINISTIC).toEqual(expect.arrayContaining(['particles', 'fillMegapixels']));
    expect(TIMING).toEqual(['renderMs', 'frameMs']);
  });
});
